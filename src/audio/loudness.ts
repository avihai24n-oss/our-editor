/**
 * Integrated loudness (ITU-R BS.1770-4 / EBU R 128) — pure maths, no DOM.
 *
 * - K-weighting = high-shelf (+4 dB above ~1.7 kHz) then high-pass (~38 Hz), coefficients for any
 *   sample rate (the closed form used by libebur128).
 * - 400 ms blocks with 75 % overlap (100 ms hop), absolute gate −70 LUFS, relative gate −10 LU.
 * - Channel weights: L and R 1.0. A MONO source is counted as dual-mono (weight 2), because the
 *   editor plays mono files on both speakers (Web Audio upmix) and exports stereo — so the number
 *   matches what ffmpeg's ebur128 reads from the exported file.
 */

/** CapCut's "Normalize loudness" target (EBU R 128). Source: capcut.com/resource/normalize-audio-premiere. */
export const NORMALIZE_TARGET_LUFS = -23;
/** The normalize gain is limited to ± this many dB (silence or near-silence must not explode). */
export const NORMALIZE_MAX_GAIN_DB = 30;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages for sample rate `fs`. */
export function kWeighting(fs: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

class ChannelFilter {
  // direct form I state for two cascaded biquads
  private s = new Float64Array(8);
  constructor(private f: [Biquad, Biquad]) {}
  /** Returns the sum of squares of the K-weighted samples in x[from, to). */
  run(x: Float32Array, from: number, to: number): number {
    const [p, q] = this.f;
    const s = this.s;
    let x1 = s[0]!, x2 = s[1]!, y1 = s[2]!, y2 = s[3]!;
    let u1 = s[4]!, u2 = s[5]!, z1 = s[6]!, z2 = s[7]!;
    let acc = 0;
    for (let i = from; i < to; i++) {
      const xi = x[i]!;
      const y = p.b0 * xi + p.b1 * x1 + p.b2 * x2 - p.a1 * y1 - p.a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = y;
      const z = q.b0 * y + q.b1 * u1 + q.b2 * u2 - q.a1 * z1 - q.a2 * z2;
      u2 = u1;
      u1 = y;
      z2 = z1;
      z1 = z;
      acc += z * z;
    }
    s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2;
    s[4] = u1; s[5] = u2; s[6] = z1; s[7] = z2;
    return acc;
  }
}

/** Streaming integrated-loudness meter. Feed planar float chunks with `push`, read `integrated()`. */
export class LoudnessMeter {
  private fs = 0;
  private filters: ChannelFilter[] = [];
  private hop = 0; // samples per 100 ms sub-block
  private fill = 0; // samples in the current sub-block
  private cur = 0; // weighted energy sum in the current sub-block
  /** Mean-square (channel-weighted) energy of each finished 100 ms sub-block. */
  private subs: number[] = [];
  private total = 0;
  private totalSamples = 0;

  push(channels: readonly Float32Array[], sampleRate: number): void {
    if (!channels.length) return;
    if (!this.fs) {
      this.fs = sampleRate;
      this.hop = Math.max(1, Math.round(sampleRate / 10));
    }
    const used = channels.slice(0, 2);
    while (this.filters.length < used.length) this.filters.push(new ChannelFilter(kWeighting(this.fs)));
    const weight = used.length === 1 ? 2 : 1;
    const n = used[0]!.length;
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, this.hop - this.fill);
      let e = 0;
      for (let c = 0; c < used.length; c++) e += this.filters[c]!.run(used[c]!, i, i + take);
      e *= weight;
      this.cur += e;
      this.total += e;
      this.fill += take;
      this.totalSamples += take;
      i += take;
      if (this.fill >= this.hop) {
        this.subs.push(this.cur / this.hop);
        this.cur = 0;
        this.fill = 0;
      }
    }
  }

  /** Integrated loudness in LUFS; -Infinity for silence / nothing measured. */
  integrated(): number {
    const blocks: number[] = [];
    for (let i = 0; i + 4 <= this.subs.length; i++) blocks.push((this.subs[i]! + this.subs[i + 1]! + this.subs[i + 2]! + this.subs[i + 3]!) / 4);
    if (!blocks.length) {
      // shorter than one 400 ms block: ungated mean
      if (!this.totalSamples) return -Infinity;
      return energyToLufs(this.total / this.totalSamples);
    }
    return gatedLoudness(blocks);
  }
}

export const energyToLufs = (meanSquare: number): number => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

/** BS.1770 two-stage gating over per-block mean-square energies. */
export function gatedLoudness(blocks: readonly number[]): number {
  const abs = blocks.filter((z) => energyToLufs(z) > -70);
  if (!abs.length) return -Infinity;
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rel = energyToLufs(mean(abs)) - 10;
  const kept = abs.filter((z) => energyToLufs(z) > rel);
  return kept.length ? energyToLufs(mean(kept)) : -Infinity;
}

/** Gain (dB) that brings `measured` LUFS to the target; 0 when nothing could be measured. */
export function normalizeGainDb(measured: number | null | undefined, target = NORMALIZE_TARGET_LUFS): number {
  if (measured === null || measured === undefined || !Number.isFinite(measured)) return 0;
  const g = target - measured;
  return Math.max(-NORMALIZE_MAX_GAIN_DB, Math.min(NORMALIZE_MAX_GAIN_DB, g));
}

/** Integrated loudness of whole planar buffers (convenience for tests and AudioBuffers). */
export function measureLoudness(channels: readonly Float32Array[], sampleRate: number): number {
  const m = new LoudnessMeter();
  m.push(channels, sampleRate);
  return m.integrated();
}
