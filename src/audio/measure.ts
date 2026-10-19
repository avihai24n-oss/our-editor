/**
 * Measures the integrated loudness of a clip's SOURCE SPAN [inSec, inSec + lenSec) for "Normalize
 * loudness". Shared by the preview (audioEngine), the inspector readout and the export (offlineMix),
 * so all three use the very same number.
 *
 * Memory: the file is streamed with Mediabunny (chunked read + chunked decode, each chunk fed to
 * the meter and closed at once). Only when Mediabunny cannot read a small file does it fall back
 * to decodeAudioData. Results are cached per (asset, span); measurements run one at a time.
 */
import type { Id } from '../model/types';
import { LoudnessMeter } from './loudness';

const FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

export type BlobLoader = (assetId: Id) => Promise<Blob | null> | Blob | null;

const done = new Map<string, number | null>();
const pending = new Map<string, Promise<number | null>>();
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

/** Cache key; spans are rounded to the millisecond. */
export const spanKey = (assetId: Id, inSec: number, lenSec: number): string => `${assetId}@${Math.round(inSec * 1000)}+${Math.round(lenSec * 1000)}`;

/** Synchronous lookup: number (LUFS, may be -Infinity), null (unmeasurable) or undefined (not yet). */
export const loudnessReady = (key: string): number | null | undefined => (done.has(key) ? done.get(key)! : undefined);

/** Called whenever a measurement finishes (inspector readout re-renders). */
export function onLoudness(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function measureSpan(assetId: Id, inSec: number, lenSec: number, load: BlobLoader): Promise<number | null> {
  const key = spanKey(assetId, inSec, lenSec);
  if (done.has(key)) return Promise.resolve(done.get(key)!);
  const hit = pending.get(key);
  if (hit) return hit;
  const run = async () => {
    const blob = await load(assetId);
    if (!blob) return null;
    return measureBlob(blob, inSec, lenSec);
  };
  const p = queue.then(run, run).catch(() => null);
  queue = p;
  const tracked = p.then((v) => {
    pending.delete(key);
    done.set(key, v);
    for (const fn of listeners) fn();
    return v;
  });
  pending.set(key, tracked);
  return tracked;
}

export async function measureBlob(blob: Blob, inSec: number, lenSec: number): Promise<number | null> {
  const streamed = await measureStreaming(blob, inSec, lenSec).catch(() => undefined);
  if (streamed !== undefined) return streamed;
  if (blob.size > FALLBACK_MAX_BYTES) return null;
  return measureWhole(blob, inSec, lenSec).catch(() => null);
}

/** Feeds the part of a planar chunk that falls in [t0, t1) to the meter. */
function feed(m: LoudnessMeter, channels: Float32Array[], rate: number, ts: number, t0: number, t1: number) {
  const n = channels[0]?.length ?? 0;
  const a = Math.max(0, Math.round((t0 - ts) * rate));
  const b = Math.min(n, Math.round((t1 - ts) * rate));
  if (b <= a) return;
  m.push(a === 0 && b === n ? channels : channels.map((c) => c.subarray(a, b)), rate);
}

/** undefined = Mediabunny could not read it (try the fallback). */
async function measureStreaming(blob: Blob, inSec: number, lenSec: number): Promise<number | null | undefined> {
  const { Input, BlobSource, ALL_FORMATS, AudioSampleSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return undefined;
    const m = new LoudnessMeter();
    const t1 = inSec + lenSec;
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(Math.max(0, inSec - 0.05), t1 + 0.05)) {
      try {
        const ts = Math.max(0, sample.timestamp);
        if (ts >= t1) continue;
        const channels: Float32Array[] = [];
        for (let c = 0; c < Math.min(2, sample.numberOfChannels); c++) {
          const buf = new Float32Array(sample.numberOfFrames);
          sample.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
          channels.push(buf);
        }
        feed(m, channels, sample.sampleRate, ts, inSec, t1);
      } finally {
        sample.close();
      }
    }
    const v = m.integrated();
    return Number.isFinite(v) ? v : null;
  } finally {
    input.dispose();
  }
}

async function measureWhole(blob: Blob, inSec: number, lenSec: number): Promise<number | null> {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx(2, 1, 48_000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  return measureAudioBuffer(buf, inSec, lenSec);
}

/** Loudness of a decoded AudioBuffer's span (used by the export when no blob loader is given). */
export function measureAudioBuffer(buf: AudioBuffer, inSec: number, lenSec: number): number | null {
  const m = new LoudnessMeter();
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c));
  feed(m, channels, buf.sampleRate, 0, inSec, inSec + lenSec);
  const v = m.integrated();
  return Number.isFinite(v) ? v : null;
}

/** Test / memory hook. */
export function clearLoudnessCache(): void {
  done.clear();
  pending.clear();
}
