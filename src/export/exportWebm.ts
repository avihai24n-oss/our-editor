/**
 * Fallback for browsers without WebCodecs H.264: MediaRecorder on canvas.captureStream().
 * Real time (paced by the wall clock), VP9/VP8 + Opus WebM. Not frame-exact. MediaRecorder writes
 * no duration and no cues (players could not seek), so the recording is remuxed once through
 * Mediabunny (packets copied, not re-encoded), which writes both.
 * Pictures come from <video> elements seeked frame by frame (ElementFrameSource).
 */
import { frameLookupSec, type FrameState, type MediaDrawOp } from '../engine/frameState';
import type { FrameSources, SourceImage } from '../engine/render';
import { getAssetUrl } from '../media/registry';
import type { Id, Project, Us } from '../model/types';
import { ExportCanceled, type EncodeOptions, type EncodeResult } from './exportMp4';
import { frameCount } from './settings';

export function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export async function exportWebm(o: EncodeOptions): Promise<EncodeResult> {
  const mimeType = pickRecorderMime();
  if (!mimeType) throw new Error('This browser can neither encode MP4 (WebCodecs) nor record WebM (MediaRecorder).');
  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Cannot create a 2D canvas for export.');
  const stream = canvas.captureStream(o.fps);

  let ac: AudioContext | null = null;
  let player: AudioBufferSourceNode | null = null;
  if (o.audio) {
    ac = new AudioContext({ sampleRate: o.audio.sampleRate });
    await ac.resume().catch(() => undefined);
    const dest = ac.createMediaStreamDestination();
    player = ac.createBufferSource();
    player.buffer = o.audio;
    player.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  }

  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: o.videoBitrate, audioBitsPerSecond: o.audioBitrate });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  const frames = frameCount(o.durationUs, o.fps);

  await o.render(ctx, 0, 0);
  rec.start(250);
  player?.start();
  const t0 = performance.now();
  let failed: unknown = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const tick = async () => {
        try {
          if (o.signal?.aborted) return reject(new ExportCanceled());
          const elapsedUs: Us = (performance.now() - t0) * 1000;
          if (elapsedUs >= o.durationUs) return resolve();
          const f = Math.min(frames - 1, Math.floor((elapsedUs * o.fps) / 1e6));
          await o.render(ctx, Math.round((f * 1e6) / o.fps), f);
          o.onProgress?.({ frame: f + 1, frames, fraction: (f + 1) / frames });
          setTimeout(tick, 1000 / o.fps / 2); // not rAF: rAF stalls in hidden tabs
        } catch (e) {
          reject(e);
        }
      };
      void tick();
    });
  } catch (e) {
    failed = e;
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    try {
      player?.stop();
    } catch {
      /* not started */
    }
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    await ac?.close().catch(() => undefined);
  }
  if (failed) throw o.signal?.aborted ? new ExportCanceled() : failed;
  const recorded = new Blob(chunks, { type: 'video/webm' });
  return { blob: await remuxWebm(recorded), mimeType, ext: 'webm' };
}

/** Copies a MediaRecorder WebM into a new WebM with a duration and cues. Returns the input on failure. */
export async function remuxWebm(blob: Blob): Promise<Blob> {
  try {
    const { Input, BlobSource, ALL_FORMATS, Output, WebMOutputFormat, BufferTarget, Conversion } = await import('mediabunny');
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
      const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
      const conv = await Conversion.init({ input, output, showWarnings: false });
      if (!conv.isValid) return blob;
      await conv.execute();
      const buf = output.target.buffer;
      return buf && buf.byteLength > 0 ? new Blob([buf], { type: 'video/webm' }) : blob;
    } finally {
      input.dispose();
    }
  } catch {
    return blob;
  }
}

/** Frame source for the fallback: one <video> per clip, seeked to each frame's source time. */
export class ElementFrameSource implements FrameSources {
  private videos = new Map<Id, HTMLVideoElement>();
  private images = new Map<Id, HTMLImageElement>();
  private ready = new Map<Id, SourceImage | 'missing'>();

  constructor(private project: Project) {}

  get(op: MediaDrawOp): SourceImage | 'missing' | null {
    return this.ready.get(op.mediaType === 'image' ? `img:${op.assetId}` : op.clipId) ?? null;
  }

  async prepare(fs: FrameState): Promise<void> {
    this.ready.clear();
    for (const op of fs.ops) {
      if (op.kind !== 'media') continue;
      const key = op.mediaType === 'image' ? `img:${op.assetId}` : op.clipId;
      const url = getAssetUrl(op.assetId);
      if (!url || this.project.assets[op.assetId]?.missing) {
        this.ready.set(key, 'missing');
        continue;
      }
      if (op.mediaType === 'image') {
        const img = await this.image(op.assetId, url);
        if (img) this.ready.set(key, { image: img, width: img.naturalWidth, height: img.naturalHeight });
        continue;
      }
      const v = await this.video(op.clipId, url);
      if (!v) continue;
      await seekTo(v, frameLookupSec(op.sourceTime));
      if (v.videoWidth) this.ready.set(key, { image: v, width: v.videoWidth, height: v.videoHeight });
    }
  }

  dispose(): void {
    for (const v of this.videos.values()) {
      v.removeAttribute('src');
      v.load();
    }
    this.videos.clear();
    this.images.clear();
  }

  private async video(clipId: Id, url: string): Promise<HTMLVideoElement | null> {
    let v = this.videos.get(clipId);
    if (v) return v;
    v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    const ok = await waitEvent(v, 'loadeddata', 10_000);
    if (!ok) return null;
    this.videos.set(clipId, v);
    return v;
  }

  private async image(assetId: Id, url: string): Promise<HTMLImageElement | null> {
    let img = this.images.get(assetId);
    if (img) return img;
    img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      return null;
    }
    this.images.set(assetId, img);
    return img;
  }
}

function waitEvent(el: HTMLElement, name: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => done(false), timeoutMs);
    const onErr = () => done(false);
    const on = () => done(true);
    function done(v: boolean) {
      clearTimeout(t);
      el.removeEventListener(name, on);
      el.removeEventListener('error', onErr);
      resolve(v);
    }
    el.addEventListener(name, on, { once: true });
    el.addEventListener('error', onErr, { once: true });
  });
}

async function seekTo(v: HTMLVideoElement, sec: number): Promise<void> {
  const target = Math.max(0, Math.min(sec, Number.isFinite(v.duration) ? v.duration - 0.001 : sec));
  if (Math.abs(v.currentTime - target) < 0.001 && !v.seeking) return;
  const p = waitEvent(v, 'seeked', 2000);
  v.currentTime = target;
  await p;
}
