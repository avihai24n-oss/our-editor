/**
 * Waveform peaks per asset, decoded once per asset and kept in a byte-budgeted LRU
 * (MEMORY_LIMITS.peaksBytes). Browser only.
 *
 * Memory rules:
 * - The file is STREAMED with Mediabunny (BlobSource reads it in chunks, AudioSampleSink decodes
 *   chunk by chunk) and each chunk is reduced into a PeakAccumulator and closed at once. Neither
 *   the whole file nor the whole decoded PCM is ever in memory.
 * - Only when Mediabunny cannot read the file, and the file is small (≤ FALLBACK_MAX_BYTES), does it
 *   fall back to Web Audio decodeAudioData, whose AudioBuffer is dropped right after reduction.
 * - Decodes run one at a time, so importing many files does not stack decoders.
 */
import { ByteLRU } from '../../media/lru';
import { MEMORY_LIMITS, registerCache } from '../../media/memory';
import { getAssetBlob } from '../../media/registry';
import type { Id } from '../../model/types';
import { computePeaks, PeakAccumulator, PEAKS_PER_SEC, type Peaks } from './peaks';

const FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

const done = new ByteLRU<Peaks | null>({ maxBytes: MEMORY_LIMITS.peaksBytes });
const pending = new Map<Id, Promise<Peaks | null>>();
let queue: Promise<unknown> = Promise.resolve();

registerCache('peaks', () => done.clear(), () => ({ entries: done.size, bytes: done.bytes }));

/** Synchronous read of an already-decoded envelope (undefined while pending / never requested). */
export const peaksReady = (assetId: Id): Peaks | null | undefined => done.get(assetId);

/** Decodes (once) and resolves the asset's peaks, or null when decoding fails. */
export function getPeaks(assetId: Id, url: string): Promise<Peaks | null> {
  if (done.has(assetId)) return Promise.resolve(done.get(assetId) ?? null);
  const hit = pending.get(assetId);
  if (hit) return hit;
  const run = () => decode(assetId, url).catch(() => null);
  const p = queue.then(run, run);
  queue = p;
  const tracked: Promise<Peaks | null> = p.then((peaks) => {
    if (pending.get(assetId) === tracked) {
      pending.delete(assetId);
      done.set(assetId, peaks, peaks ? peaks.data.byteLength : 0);
    }
    return peaks;
  });
  pending.set(assetId, tracked);
  return tracked;
}

async function decode(assetId: Id, url: string): Promise<Peaks | null> {
  const blob = getAssetBlob(assetId) ?? (await (await fetch(url)).blob());
  const streamed = await decodeStreaming(blob).catch(() => null);
  if (streamed) return streamed;
  if (blob.size > FALLBACK_MAX_BYTES) return null;
  return decodeWhole(blob);
}

/** Mediabunny: chunked read + chunked decode, only the envelope is kept. */
async function decodeStreaming(blob: Blob): Promise<Peaks | null> {
  const { Input, BlobSource, ALL_FORMATS, AudioSampleSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    const duration = await input.computeDuration();
    const acc = new PeakAccumulator(PEAKS_PER_SEC, duration);
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples()) {
      try {
        const channels: Float32Array[] = [];
        for (let c = 0; c < sample.numberOfChannels; c++) {
          const buf = new Float32Array(sample.numberOfFrames);
          sample.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
          channels.push(buf);
        }
        acc.push(channels, sample.sampleRate, Math.max(0, sample.timestamp));
      } finally {
        sample.close();
      }
    }
    return acc.result(duration);
  } finally {
    input.dispose();
  }
}

/** Web Audio fallback for small files Mediabunny cannot demux. */
async function decodeWhole(blob: Blob): Promise<Peaks | null> {
  const Ctx: typeof OfflineAudioContext | undefined =
    (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctx) return null;
  // Decode at a low rate: plenty for a 200-peaks/s envelope and 6× less memory than 48 kHz.
  const ctx = new Ctx(1, 1, 8000);
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  const channels: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
  return computePeaks(channels, audio.sampleRate); // the AudioBuffer is not kept
}

/** Drops a cached envelope (e.g. when an asset is removed). */
export function forgetPeaks(assetId: Id): void {
  pending.delete(assetId);
  done.delete(assetId);
}
