/**
 * Export frame sources: decoded, frame-exact pictures for the compositor.
 *
 * - Video: Mediabunny CanvasSink per asset; one sequential reader per CLIP that walks the
 *   decoded frames forward (each packet decoded once) and restarts only on a backwards or long
 *   forward jump. Frame shown at time t = the last frame whose timestamp ≤ t.
 * - Image: ImageBitmap per asset.
 * - `prepare(fs)` is the only async step; `get(op)` is synchronous for renderFrame.
 */
import { frameLookupSec, type FrameState, type MediaDrawOp } from '../engine/frameState';
import type { FrameSources, SourceImage } from '../engine/render';
import { intendedMatrix, webCodecsMatrix, type Matrix } from '../media/colorMatrix';
import type { Id, Project } from '../model/types';
import { DECODE_STALL_MS, ExportStalled, withTimeout } from './watchdog';

/** Minimal frame shape we need from Mediabunny's WrappedCanvas. */
export interface TimedFrame {
  canvas: CanvasImageSource & { width: number; height: number };
  timestamp: number; // seconds
}

export type OpenFrames = (startSec: number) => AsyncGenerator<TimedFrame, void, unknown>;

/** Restart the decoder instead of decoding forward when jumping more than this far ahead. */
export const MAX_FORWARD_DECODE_SEC = 2.5;
const EPS = 1e-6;

class DecodeStall extends Error {}

/**
 * Walks an ordered frame stream; returns the frame covering each requested time. Pure logic, testable.
 *
 * Stalls: a decoder read that does not answer within `stallMs` is abandoned (never awaited again —
 * awaiting `return()` on a generator stuck in an await would hang too) and the stream is reopened
 * at the wanted time, once per reader. A second stall throws ExportStalled, so the export fails
 * with a message instead of waiting forever.
 */
export class SequentialReader {
  private iter: AsyncGenerator<TimedFrame, void, unknown> | null = null;
  private cur: TimedFrame | null = null;
  private next: TimedFrame | null = null;
  private done = false;
  private lastT = -Infinity;
  /** Number of decoder (re)starts — for tests and diagnostics. */
  restarts = 0;
  /** Stalled reads recovered by reopening the decoder. */
  recoveries = 0;

  constructor(
    private open: OpenFrames,
    private stallMs: number = DECODE_STALL_MS,
    private maxRecoveries = 1,
  ) {}

  private async pull(): Promise<TimedFrame | null> {
    if (!this.iter || this.done) return null;
    const r = await withTimeout(this.iter.next(), this.stallMs, () => new DecodeStall());
    if (r.done) {
      this.done = true;
      return null;
    }
    return r.value;
  }

  private abandon(): void {
    const old = this.iter;
    this.iter = null;
    this.cur = this.next = null;
    // fire and forget: if the stuck read ever settles, the generator cleans up (closes its decoder)
    void old?.return(undefined).catch(() => undefined);
  }

  private async restart(t: number): Promise<void> {
    await this.iter?.return(undefined);
    this.iter = this.open(t);
    this.restarts++;
    this.done = false;
    this.cur = await this.pull();
    this.next = this.cur ? await this.pull() : null;
  }

  async frameAt(t: number): Promise<TimedFrame | null> {
    for (;;) {
      try {
        return await this.step(t);
      } catch (e) {
        if (!(e instanceof DecodeStall)) throw e;
        this.abandon();
        if (this.recoveries >= this.maxRecoveries) {
          throw new ExportStalled(`the video decoder stopped delivering frames at ${t.toFixed(3)} s of the source, also after a restart`);
        }
        this.recoveries++;
        this.lastT = -Infinity; // reopen at t
      }
    }
  }

  private async step(t: number): Promise<TimedFrame | null> {
    const backwards = t < this.lastT - EPS;
    this.lastT = t;
    const farAhead = this.next !== null && t - this.next.timestamp > MAX_FORWARD_DECODE_SEC;
    if (!this.iter || backwards || farAhead) await this.restart(t);
    while (this.next && this.next.timestamp <= t + EPS) {
      this.cur = this.next;
      this.next = await this.pull();
    }
    return this.cur;
  }

  async close(): Promise<void> {
    const it = this.iter;
    this.iter = null;
    this.cur = this.next = null;
    // bounded: a stuck generator must not block the export's cleanup
    if (it) await withTimeout(it.return(undefined), 1000, () => new DecodeStall()).catch(() => undefined);
  }
}

interface VideoAssetDecoder {
  open: OpenFrames;
  dispose: () => void;
}

export class ExportFrameSource implements FrameSources {
  private decoders = new Map<Id, Promise<VideoAssetDecoder | null>>();
  private readers = new Map<Id, SequentialReader>();
  private images = new Map<Id, Promise<ImageBitmap | null>>();
  private ready = new Map<Id, SourceImage | 'missing'>();
  /** What prepare() is waiting for right now (named in a stall error). */
  waiting: string | null = null;

  constructor(private project: Project, private loadBlob: (assetId: Id) => Promise<Blob | null>) {}

  get(op: MediaDrawOp): SourceImage | 'missing' | null {
    return this.ready.get(op.mediaType === 'image' ? `img:${op.assetId}` : op.clipId) ?? null;
  }

  async prepare(fs: FrameState): Promise<void> {
    this.ready.clear();
    for (const op of fs.ops) {
      if (op.kind !== 'media') continue;
      const asset = this.project.assets[op.assetId];
      if (!asset || asset.missing) {
        this.ready.set(op.mediaType === 'image' ? `img:${op.assetId}` : op.clipId, 'missing');
        continue;
      }
      if (op.mediaType === 'image') {
        const bmp = await this.image(op.assetId);
        this.ready.set(`img:${op.assetId}`, bmp ? { image: bmp, width: bmp.width, height: bmp.height } : 'missing');
        continue;
      }
      const reader = await this.reader(op.clipId, op.assetId);
      if (!reader) {
        this.ready.set(op.clipId, 'missing');
        continue;
      }
      const sec = frameLookupSec(op.sourceTime);
      this.waiting = `decoding "${asset.name}" at ${sec.toFixed(3)} s`;
      const f = await reader.frameAt(sec);
      this.waiting = null;
      if (f) this.ready.set(op.clipId, { image: f.canvas, width: f.canvas.width, height: f.canvas.height });
    }
  }

  async dispose(): Promise<void> {
    // inputs first: disposing an Input stops its decoders, which also frees a stuck read
    const bounded = <T,>(p: Promise<T>) => withTimeout(p, 1000, () => new Error('timeout')).catch(() => null);
    for (const p of this.decoders.values()) (await bounded(p))?.dispose();
    this.decoders.clear();
    for (const r of this.readers.values()) await r.close().catch(() => undefined);
    this.readers.clear();
    for (const p of this.images.values()) (await p.catch(() => null))?.close();
    this.images.clear();
    this.ready.clear();
  }

  private image(assetId: Id): Promise<ImageBitmap | null> {
    let p = this.images.get(assetId);
    if (!p) {
      p = (async () => {
        const blob = await this.loadBlob(assetId);
        if (!blob) return null;
        try {
          return await createImageBitmap(blob);
        } catch {
          return null;
        }
      })();
      this.images.set(assetId, p);
    }
    return p;
  }

  private async reader(clipId: Id, assetId: Id): Promise<SequentialReader | null> {
    const existing = this.readers.get(clipId);
    if (existing) return existing;
    const dec = await this.decoder(assetId);
    if (!dec) return null;
    const r = new SequentialReader(dec.open);
    this.readers.set(clipId, r);
    return r;
  }

  private decoder(assetId: Id): Promise<VideoAssetDecoder | null> {
    let p = this.decoders.get(assetId);
    if (!p) {
      p = (async () => {
        const blob = await this.loadBlob(assetId);
        if (!blob) return null;
        const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) {
          input.dispose?.();
          throw new Error(`This browser cannot decode the video "${this.project.assets[assetId]?.name ?? assetId}".`);
        }
        // WebCodecs decodes UNTAGGED video with BT.709 even when it is SD, where the preview and
        // the convention use BT.601. Such streams are re-tagged frame by frame (lossless: the YUV
        // planes are copied into a new frame carrying the intended colour space).
        const cs = await track.getColorSpace().catch(() => ({}) as VideoColorSpaceInit);
        const tags = { matrix: cs.matrix ?? null, primaries: cs.primaries ?? null, transfer: cs.transfer ?? null, width: track.codedWidth, height: track.codedHeight };
        const want = intendedMatrix(tags);
        const retag = want && webCodecsMatrix(tags) !== want ? want : null;
        if (retag) {
          const { VideoSampleSink } = await import('mediabunny');
          const vsink = new VideoSampleSink(track);
          return { open: (startSec: number) => retaggedFrames(vsink.samples(Math.max(0, startSec)), retag, cs.fullRange ?? false), dispose: () => input.dispose?.() };
        }
        const sink = new CanvasSink(track);
        return {
          open: (startSec: number) => sink.canvases(Math.max(0, startSec)) as AsyncGenerator<TimedFrame, void, unknown>,
          dispose: () => input.dispose?.(),
        };
      })();
      this.decoders.set(assetId, p);
    }
    return p;
  }
}

type Sample = import('mediabunny').VideoSample;

/** Decoded frames re-tagged with the intended YUV matrix, drawn to canvases (like CanvasSink). */
async function* retaggedFrames(src: AsyncGenerator<Sample, void, unknown>, matrix: Matrix, fullRange: boolean): AsyncGenerator<TimedFrame, void, unknown> {
  const { VideoSample } = await import('mediabunny');
  const colorSpace: VideoColorSpaceInit = matrix === 'bt601' ? { matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', fullRange } : { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange };
  try {
    for await (const s of src) {
      try {
        const buf = new Uint8Array(s.allocationSize());
        const layout = await s.copyTo(buf);
        // copyTo() copies the visible rect, so the new frame's coded size is that rect
        const fixed = new VideoSample(buf, { format: s.format!, codedWidth: s.visibleRect.width, codedHeight: s.visibleRect.height, timestamp: s.timestamp, duration: s.duration, layout, colorSpace, rotation: s.rotation });
        const canvas = new OffscreenCanvas(fixed.displayWidth, fixed.displayHeight);
        const ctx = canvas.getContext('2d');
        if (ctx) fixed.draw(ctx, 0, 0, canvas.width, canvas.height);
        fixed.close();
        yield { canvas, timestamp: s.timestamp };
      } finally {
        s.close();
      }
    }
  } finally {
    await src.return(undefined);
  }
}
