/**
 * Volume keyframes (AudioProps.volumeKeys): pure helpers shared by the preview (frameState), the
 * export mix (offlineMix), the timeline (VolumeLine, Waveform) and the inspector.
 *
 * A key lives at a SOURCE position (`src`, the frame of `inPoint`): trims, splits (both halves keep
 * every key, so the envelope is continuous across the cut) and speed changes never move it off its
 * sound. Between keys the volume is linear in dB; before the first / after the last key it is flat.
 */
import { LIMITS } from './catalog';
import { localTimeForSourceOffset, sourceOffsetAt } from './time';
import type { SpeedCurve } from './speedCurve';
import type { AudioProps, Clip, TimedClip, Us, VolumeKey } from './types';

export type KeyedClip = Pick<Clip, 'start' | 'duration'> &
  Pick<TimedClip, 'speed' | 'inPoint'> & { speedCurve?: SpeedCurve | null; audio: Pick<AudioProps, 'volumeDb' | 'volumeKeys'> };

export const hasVolumeKeys = (a: Pick<AudioProps, 'volumeKeys'>): boolean => !!a.volumeKeys && a.volumeKeys.length > 0;

const clampDb = (db: number): number => Math.min(LIMITS.volumeDbMax, Math.max(LIMITS.volumeDbMin, Math.round(db * 10) / 10));

/** Source position (µs) heard at timeline time t. */
export function srcAt(c: KeyedClip, t: Us): Us {
  const local = Math.min(c.duration, Math.max(0, t - c.start));
  return c.inPoint + sourceOffsetAt(c, local);
}

/** Timeline time (µs, fractional) of a source position. */
export function timeAtSrc(c: KeyedClip, src: Us): number {
  return c.start + localTimeForSourceOffset(c, src - c.inPoint);
}

/** Envelope value (dB) at a source position. */
export function keysDbAt(keys: readonly VolumeKey[], src: Us): number {
  const first = keys[0]!;
  if (src <= first.src) return first.db;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (src <= b.src) {
      const a = keys[i - 1]!;
      return b.src === a.src ? b.db : a.db + ((b.db - a.db) * (src - a.src)) / (b.src - a.src);
    }
  }
  return keys[keys.length - 1]!.db;
}

/** The clip's volume (dB) at timeline time t: the keyframe envelope, or `volumeDb`. */
export function clipVolumeDbAt(c: KeyedClip, t: Us): number {
  const keys = c.audio.volumeKeys;
  return keys && keys.length ? keysDbAt(keys, srcAt(c, t)) : c.audio.volumeDb;
}

/** The keys inside the clip's visible span, with their timeline times. */
export function visibleKeys(c: KeyedClip): { key: VolumeKey; index: number; t: number }[] {
  const keys = c.audio.volumeKeys ?? [];
  const out: { key: VolumeKey; index: number; t: number }[] = [];
  keys.forEach((key, index) => {
    const t = timeAtSrc(c, key.src);
    if (t >= c.start - 0.5 && t <= c.start + c.duration + 0.5) out.push({ key, index, t });
  });
  return out;
}

/** Index of the key within `tolUs` of timeline time t, or -1. */
export function keyIndexAt(c: KeyedClip, t: Us, tolUs: number): number {
  let best = -1;
  let bestD = Infinity;
  for (const { index, t: kt } of visibleKeys(c)) {
    const d = Math.abs(kt - t);
    if (d <= tolUs && d < bestD) {
      best = index;
      bestD = d;
    }
  }
  return best;
}

/** Keys with one set at timeline time t (replacing a key within `tolUs`). */
export function withKeyAt(c: KeyedClip, t: Us, db: number, tolUs: number): VolumeKey[] {
  const keys = [...(c.audio.volumeKeys ?? [])];
  const i = keyIndexAt(c, t, tolUs);
  if (i >= 0) keys[i] = { src: keys[i]!.src, db: clampDb(db) };
  else keys.push({ src: Math.round(srcAt(c, t)), db: clampDb(db) });
  return keys.sort((a, b) => a.src - b.src);
}

/** Keys without the one at timeline time t; undefined when none are left (back to volumeDb). */
export function withoutKeyAt(c: KeyedClip, t: Us, tolUs: number): VolumeKey[] | undefined {
  const i = keyIndexAt(c, t, tolUs);
  const keys = (c.audio.volumeKeys ?? []).filter((_, j) => j !== i);
  return keys.length ? keys : undefined;
}

/** Every key moved by `deltaDb` (the timeline line dragged with keys on it, ⌘. / ⌘,). */
export const shiftKeys = (keys: readonly VolumeKey[], deltaDb: number): VolumeKey[] => keys.map((k) => ({ src: k.src, db: clampDb(k.db + deltaDb) }));

/** Timeline times of the visible keys, sorted (‹ › navigation). */
export const keyTimes = (c: KeyedClip): number[] => visibleKeys(c).map((k) => k.t).sort((a, b) => a - b);
