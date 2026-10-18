/**
 * Waveform peaks per asset: fetch the object URL, decode with Web Audio, reduce to peaks.
 * Cached per asset id (one decode per asset per session). Browser only.
 */
import type { Id } from '../../model/types';
import { computePeaks, type Peaks } from './peaks';

const cache = new Map<Id, Promise<Peaks | null>>();
const done = new Map<Id, Peaks | null>();

/** Synchronous read of an already-decoded envelope (undefined while pending / never requested). */
export const peaksReady = (assetId: Id): Peaks | null | undefined => done.get(assetId);

/** Decodes (once) and resolves the asset's peaks, or null when decoding fails. */
export function getPeaks(assetId: Id, url: string): Promise<Peaks | null> {
  const hit = cache.get(assetId);
  if (hit) return hit;
  const p = decode(url)
    .catch(() => null)
    .then((peaks) => {
      done.set(assetId, peaks);
      return peaks;
    });
  cache.set(assetId, p);
  return p;
}

async function decode(url: string): Promise<Peaks | null> {
  const Ctx: typeof OfflineAudioContext | undefined =
    (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctx) return null;
  const buf = await (await fetch(url)).arrayBuffer();
  // Decode at a low rate: plenty for a 200-peaks/s envelope and 5× less memory than 48 kHz.
  const ctx = new Ctx(1, 1, 8000);
  const audio = await ctx.decodeAudioData(buf);
  const channels: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
  return computePeaks(channels, audio.sampleRate);
}

/** Drops a cached envelope (e.g. when an asset is removed). */
export function forgetPeaks(assetId: Id): void {
  cache.delete(assetId);
  done.delete(assetId);
}
