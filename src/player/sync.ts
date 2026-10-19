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
  /** Clip speed now (instantaneous for a speed curve). */
  speed: number;
  /**
   * The speed changes over time (Speed › Curve). The element's playbackRate then follows the
   * curve every tick, plus a small proportional correction toward the target so the element
   * stays on the integral of the curve without re-seeking (seeks stutter).
   */
  varying?: boolean;
  /** Half a frame, seconds — tolerance when paused. */
  tolerance: number;
  /**
   * Close small drift while playing by nudging playbackRate (up to ±MAX_NUDGE) instead of
   * leaving it until it passes driftLimit. Used for the (muted) preview videos: a play() start
   * or a cut leaves them ~1.5 frames behind the audio clock, which no seek would ever fix.
   * Not for audible elements (a rate change bends the pitch).
   */
  nudge?: boolean;
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
/** Largest playbackRate nudge, as a fraction of the clip speed. */
export const MAX_NUDGE = 0.08;
/** A nudge aims to close the current drift over this many seconds. */
export const CATCH_UP_SEC = 0.5;

/** playbackRate that closes `lag` seconds (target − currentTime) of drift. Pure; exported for tests. */
export function nudgedRate(speed: number, lag: number): number {
  const k = Math.min(MAX_NUDGE, Math.max(-MAX_NUDGE, lag / CATCH_UP_SEC));
  return Math.min(MAX_RATE, Math.max(MIN_RATE, speed * (1 + k)));
}

/** Time constant of the curve-following correction, seconds of wall time. */
export const FOLLOW_TC = 0.5;

/**
 * playbackRate for a varying speed: the curve's speed plus (target − current) / FOLLOW_TC,
 * limited to ±25 % of the speed and to the browser's native range.
 */
export function followRate(currentTime: number, target: number, speed: number): number {
  const r = speed + (target - currentTime) / FOLLOW_TC;
  const lo = Math.max(MIN_RATE, speed * 0.8);
  const hi = Math.min(MAX_RATE, speed * 1.25);
  return Math.round(Math.min(hi, Math.max(lo, r)) * 1000) / 1000;
}

export function decideSync(el: ElementState, want: SyncWant): SyncAction {
  const out: SyncAction = { seek: null, play: false, pause: false, rate: null };
  const nativeRate = want.speed >= MIN_RATE && want.speed <= MAX_RATE;
  const diff = Math.abs(el.currentTime - want.target);

  if (want.running && nativeRate) {
    let rate = want.speed;
    // a speed curve: follow the curve's instantaneous speed plus a proportional correction
    if (want.varying) rate = followRate(el.currentTime, want.target, want.speed);
    if (el.paused) {
      if (diff > want.tolerance) out.seek = want.target;
      out.play = true;
    } else if (!el.seeking && el.sinceSeekMs > SEEK_GRACE_MS && diff > driftLimit(want.speed)) {
      out.seek = want.target;
    } else if (want.nudge && !want.varying && !el.seeking) {
      const lag = want.target - el.currentTime;
      if (diff > want.tolerance) rate = nudgedRate(want.speed, lag);
      // inside the dead band keep a running nudge until the drift is under a quarter frame
      else if (diff > want.tolerance / 2 && Math.abs(el.playbackRate - want.speed) > 1e-6 && Math.sign(el.playbackRate - want.speed) === Math.sign(lag))
        rate = el.playbackRate;
    }
    // a curve-following rate changes every tick: only write it when it moved by > 1 %
    const tol = want.varying ? 0.01 * rate : 1e-6;
    if (Math.abs(el.playbackRate - rate) > tol) out.rate = rate;
    return out;
  }

  // paused timeline, held frame, or a speed beyond the native range: step by seeking
  if (!el.paused) out.pause = true;
  if (diff > want.tolerance && !(el.seeking && want.running)) out.seek = want.target;
  return out;
}
