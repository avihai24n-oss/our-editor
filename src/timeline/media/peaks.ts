/**
 * Pure waveform maths: reduce decoded PCM to a peak envelope, and read that envelope back for a
 * time range. No DOM — unit-tested in media.test.ts.
 */

/** Envelope resolution (peaks per second of source). */
export const PEAKS_PER_SEC = 200;

export interface Peaks {
  /** Max |sample| (0..1) per bucket, across all channels. */
  data: Float32Array;
  /** Buckets per second of source. */
  pps: number;
  /** Source duration in seconds. */
  duration: number;
}

/** Reduces channel data to `pps` max-abs peaks per second. */
export function computePeaks(channels: readonly Float32Array[], sampleRate: number, pps = PEAKS_PER_SEC): Peaks {
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const duration = sampleRate > 0 ? length / sampleRate : 0;
  const buckets = Math.max(0, Math.ceil(duration * pps));
  const data = new Float32Array(buckets);
  const per = sampleRate / pps;
  for (const ch of channels) {
    for (let b = 0; b < buckets; b++) {
      const s0 = Math.floor(b * per);
      const s1 = Math.min(ch.length, Math.floor((b + 1) * per));
      let m = data[b]!;
      for (let i = s0; i < s1; i++) {
        const v = Math.abs(ch[i]!);
        if (v > m) m = v;
      }
      data[b] = m > 1 ? 1 : m;
    }
  }
  return { data, pps, duration };
}

/**
 * Streaming version of computePeaks: feed decoded chunks in order (or with their timestamps) and
 * read the envelope at the end. Only the envelope is kept — never the PCM — so a long file costs
 * PEAKS_PER_SEC × 4 bytes per second (≈ 2.9 MB per hour) however big it is.
 */
export class PeakAccumulator {
  private data: Float32Array;
  private maxBucket = 0;

  constructor(
    readonly pps = PEAKS_PER_SEC,
    expectedDurationSec = 0,
  ) {
    this.data = new Float32Array(Math.max(16, Math.ceil(expectedDurationSec * pps) + 1));
  }

  /** `channels` = planar samples of one chunk; `startSec` = the chunk's timestamp. */
  push(channels: readonly Float32Array[], sampleRate: number, startSec: number): void {
    if (sampleRate <= 0) return;
    const per = sampleRate / this.pps;
    const frames = channels.reduce((m, c) => Math.max(m, c.length), 0);
    if (!frames) return;
    const first = Math.max(0, Math.floor(startSec * this.pps));
    const last = Math.max(first, Math.ceil((startSec + frames / sampleRate) * this.pps) - 1);
    this.ensure(last + 1);
    const offset = startSec * sampleRate; // fractional frame index of sample 0
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const b = Math.floor((offset + i) / per);
        if (b < 0) continue;
        const v = ch[i]! < 0 ? -ch[i]! : ch[i]!;
        if (v > this.data[b]!) this.data[b] = v > 1 ? 1 : v;
      }
    }
    if (last + 1 > this.maxBucket) this.maxBucket = last + 1;
  }

  /** The envelope so far. `durationSec` trims/extends to the known source duration. */
  result(durationSec?: number): Peaks {
    const buckets = durationSec !== undefined ? Math.max(0, Math.ceil(durationSec * this.pps)) : this.maxBucket;
    this.ensure(buckets);
    return { data: this.data.slice(0, buckets), pps: this.pps, duration: durationSec ?? buckets / this.pps };
  }

  private ensure(n: number): void {
    if (n <= this.data.length) return;
    const next = new Float32Array(Math.max(n, this.data.length * 2));
    next.set(this.data);
    this.data = next;
  }
}

/** Max peak over source seconds [t0, t1). Out-of-range → 0. Always reads at least one bucket. */
export function peakAt(p: Peaks, t0: number, t1: number): number {
  const n = p.data.length;
  if (!n) return 0;
  let b0 = Math.floor(t0 * p.pps);
  let b1 = Math.ceil(t1 * p.pps);
  if (b1 <= b0) b1 = b0 + 1;
  if (b1 <= 0 || b0 >= n) return 0;
  b0 = Math.max(0, b0);
  b1 = Math.min(n, b1);
  let m = 0;
  for (let i = b0; i < b1; i++) if (p.data[i]! > m) m = p.data[i]!;
  return m;
}

/** Normalisation gain so the loudest peak fills the clip height (quiet files stay readable). */
export function normGain(p: Peaks): number {
  let m = 0;
  for (let i = 0; i < p.data.length; i++) if (p.data[i]! > m) m = p.data[i]!;
  return m > 0.01 ? Math.min(4, 0.95 / m) : 1;
}

// ---------------------------------------------------------------- filmstrip maths

/** Quantisation steps (seconds) for thumbnail times, so nearby requests reuse the cache. */
const THUMB_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

/** The cache step for tiles that each cover `tileSec` of source. */
export function thumbStep(tileSec: number): number {
  for (const s of THUMB_STEPS) if (s >= tileSec * 0.75) return s;
  return THUMB_STEPS[THUMB_STEPS.length - 1]!;
}

/** Quantise a source time (seconds) to `step`, clamped into [0, duration - a hair]. */
export function quantizeTime(sec: number, step: number, duration: number): number {
  const q = Math.floor(Math.max(0, sec) / step) * step;
  const max = Math.max(0, duration - 0.04);
  return Math.round(Math.min(q, max) * 1000) / 1000;
}

/** Tile indexes intersecting the clip-local pixel window [fromPx, toPx). */
export function tileRange(fromPx: number, toPx: number, tileW: number, clipW: number): [number, number] {
  if (tileW <= 0 || clipW <= 0 || toPx <= 0 || fromPx >= clipW) return [0, -1];
  const first = Math.max(0, Math.floor(fromPx / tileW));
  const last = Math.min(Math.ceil(clipW / tileW) - 1, Math.floor((Math.min(toPx, clipW) - 1) / tileW));
  return [first, last];
}
