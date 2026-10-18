/**
 * Playback clock. Timeline time = anchor + (now − anchorNow). `now` is the AudioContext clock
 * when audio is running (so picture follows sound), else performance.now(). Injectable for tests.
 */
import type { Us } from '../model/types';

/** Returns seconds. */
export type NowFn = () => number;

export class PlaybackClock {
  private anchorUs: Us = 0;
  private anchorNow = 0;
  private running = false;

  constructor(private now: NowFn) {}

  /** Swap the time source (e.g. once the AudioContext is running). Keeps the current time. */
  setSource(now: NowFn): void {
    const t = this.time();
    this.now = now;
    if (this.running) this.start(t);
  }

  start(fromUs: Us): void {
    this.anchorUs = fromUs;
    this.anchorNow = this.now();
    this.running = true;
  }

  stop(): Us {
    const t = this.time();
    this.running = false;
    this.anchorUs = t;
    return t;
  }

  /** Re-anchor without stopping (seek while playing). */
  seek(toUs: Us): void {
    this.anchorUs = toUs;
    this.anchorNow = this.now();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Current timeline time in µs (integer). */
  time(): Us {
    if (!this.running) return this.anchorUs;
    return Math.round(this.anchorUs + (this.now() - this.anchorNow) * 1e6);
  }
}

export const perfNow: NowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
