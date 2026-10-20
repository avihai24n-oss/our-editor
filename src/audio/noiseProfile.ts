/**
 * Noise profiles for Voice isolation (DSP): measured OFFLINE once per (asset, source span) from the
 * file decoded at 48 kHz — the same decode the export uses — and cached, so the preview worklet and
 * the export worklet get the very same numbers. See src/audio/isolateCore.ts (oeNoiseProfile).
 */
import type { Id } from '../model/types';
import { getIsolateCore } from './isolateCore';
import { spanKey, type BlobLoader } from './measure';

/** Profiles are always measured at this rate (the export's mix rate). */
export const PROFILE_RATE = 48_000;
const MAX_DECODE_BYTES = 256 * 1024 * 1024;

const done = new Map<string, Float32Array | null>();
const pending = new Map<string, Promise<Float32Array | null>>();
let queue: Promise<unknown> = Promise.resolve();

export { spanKey as profileKey };

/** Float32Array (ready), null (unmeasurable / silent) or undefined (not measured yet). */
export const noiseProfileReady = (key: string): Float32Array | null | undefined => (done.has(key) ? done.get(key)! : undefined);

interface ChannelSource {
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** Profile of a decoded buffer's span [inSec, inSec + lenSec). */
export function profileFromBuffer(buf: ChannelSource, inSec: number, lenSec: number): Float32Array | null {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c));
  const sr = buf.sampleRate;
  return getIsolateCore().profile(channels, sr, Math.round(inSec * sr), Math.round((inSec + lenSec) * sr));
}

/** Export: the cached profile for this span, or measure it from the already-decoded buffer. */
export function profileForBuffer(assetId: Id, inSec: number, lenSec: number, buf: ChannelSource): Float32Array | null {
  const key = spanKey(assetId, inSec, lenSec);
  if (done.has(key)) return done.get(key)!;
  const p = buf.sampleRate === PROFILE_RATE ? profileFromBuffer(buf, inSec, lenSec) : null;
  done.set(key, p);
  return p;
}

/** Preview: measures (once, one at a time) and caches. */
export function measureNoiseProfile(assetId: Id, inSec: number, lenSec: number, load: BlobLoader): Promise<Float32Array | null> {
  const key = spanKey(assetId, inSec, lenSec);
  if (done.has(key)) return Promise.resolve(done.get(key)!);
  const hit = pending.get(key);
  if (hit) return hit;
  const run = async () => {
    const blob = await load(assetId);
    if (!blob || blob.size > MAX_DECODE_BYTES) return null;
    const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Ctx) return null;
    const buf = await new Ctx(2, 1, PROFILE_RATE).decodeAudioData(await blob.arrayBuffer());
    return profileFromBuffer(buf, inSec, lenSec);
  };
  const p = queue.then(run, run).catch(() => null);
  queue = p;
  const tracked = p.then((v) => {
    pending.delete(key);
    if (!done.has(key)) done.set(key, v);
    return done.get(key)!;
  });
  pending.set(key, tracked);
  return tracked;
}

/** Test / memory hook. */
export function clearNoiseProfiles(): void {
  done.clear();
  pending.clear();
}
