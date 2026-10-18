/**
 * Pure decisions for keeping a media element in step with the timeline. Shared by the video
 * pool and the audio engine; unit-tested.
 */

/** Browser playbackRate limits (Chrome: 1/16 … 16). */
export const MIN_RATE = 0.0625;
export const MAX_RATE = 16;

export interface ElementState {
  /** element.currentTime, seconds */
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  playbackRate: number;
  /** ms since we last issued a seek (Infinity if never) */
  sinceSeekMs: number;
}

export interface SyncWant {
  /** Source time we want to show/hear now, seconds. */
  target: number;
  /** Timeline is playing AND the source should be advancing (not a held edge frame). */
  running: boolean;
  /** Clip speed. */
  speed: number;
  /** Half a frame, seconds — tolerance when paused. */
  tolerance: number;
}

export interface SyncAction {
  seek: number | null;
  play: boolean;
  pause: boolean;
  rate: number | null;
}

/** Drift allowed while playing before we re-seek, seconds (scaled with speed). */
export const driftLimit = (speed: number): number => 0.15 * Math.max(1, speed);
/** After a seek, ignore drift for this long (currentTime settles). */
export const SEEK_GRACE_MS = 400;

export function decideSync(el: ElementState, want: SyncWant): SyncAction {
  const out: SyncAction = { seek: null, play: false, pause: false, rate: null };
  const nativeRate = want.speed >= MIN_RATE && want.speed <= MAX_RATE;
  const diff = Math.abs(el.currentTime - want.target);

  if (want.running && nativeRate) {
    if (Math.abs(el.playbackRate - want.speed) > 1e-6) out.rate = want.speed;
    if (el.paused) {
      if (diff > want.tolerance) out.seek = want.target;
      out.play = true;
    } else if (!el.seeking && el.sinceSeekMs > SEEK_GRACE_MS && diff > driftLimit(want.speed)) {
      out.seek = want.target;
    }
    return out;
  }

  // paused timeline, held frame, or a speed beyond the native range: step by seeking
  if (!el.paused) out.pause = true;
  if (diff > want.tolerance && !(el.seeking && want.running)) out.seek = want.target;
  return out;
}
