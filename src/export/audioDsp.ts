/**
 * Pure DSP for the export mix (no Web Audio, unit-testable):
 *
 * - `stretchMapped` / `stretchPreservePitch`: WSOLA time-stretch (standard speed and speed curves). The preview plays speed-changed clips through a
 *   media element with `preservesPitch` (CapCut's default, "Change audio pitch" off), so the
 *   export must keep the pitch too. An OfflineAudioContext playbackRate would shift it
 *   (2× = an octave up), which is what the export did before (audit 2026-10-19).
 * - `limitPeaks`: a look-ahead peak limiter on the final mix. Overlapping loud clips used to sum
 *   past full scale (peak 1.61 measured), which clips in every player. It only acts on samples
 *   above the ceiling, so a mix that already fits is left bit-identical.
 */

/** WSOLA frame (≈43 ms at 48 kHz), 50 % overlap, ±10 ms alignment search. */
const FRAME = 2048;
const HOP = FRAME / 2;
const SEEK = 512;

let hann: Float32Array | null = null;
/** Periodic Hann window centred on FRAME/2: overlapping copies at HOP sum to exactly 1. */
function window(): Float32Array {
  if (!hann) {
    hann = new Float32Array(FRAME);
    for (let n = 0; n < FRAME; n++) hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / FRAME);
  }
  return hann;
}

/** Source position (SECONDS) that output sample n must play — a clip's time mapping. */
export type SourceMap = (n: number) => number;

/**
 * Plays `channels` from sample `start` at `speed` (source samples per output sample) for
 * `outLength` output samples, keeping the pitch. Samples outside the input read as silence.
 * Standard speed is the constant-rate case of `stretchMapped`.
 */
export function stretchPreservePitch(channels: readonly Float32Array[], start: number, speed: number, outLength: number): Float32Array<ArrayBuffer>[] {
  return stretchMapped(channels, 1, outLength, (n) => start + n * speed, speed === 1);
}

/**
 * WSOLA time-stretch along an arbitrary, increasing time mapping: output sample n plays source
 * time `srcAt(n)` seconds (× `sampleRate` = source sample). Standard speed and speed curves share
 * this one implementation (the project's only pitch-preserving stretcher — the integration kept
 * it over tab-speed's variant: 6–30 dB better sine SNR at 0.5×–3× thanks to the ±512-sample
 * search refined to 1 sample). All channels share one alignment so the stereo image stays put.
 *
 * `unity` = the mapping is rate 1 everywhere: frames are copied without searching (bit-exact).
 */
export function stretchMapped(channels: readonly Float32Array[], sampleRate: number, outLength: number, srcAt: SourceMap, unity = false): Float32Array<ArrayBuffer>[] {
  const out = channels.map(() => new Float32Array(Math.max(0, outLength)));
  if (outLength <= 0 || !channels.length) return out;
  const len = channels[0]!.length;
  const w = window();
  const half = FRAME / 2;
  const pos = (n: number) => srcAt(n) * sampleRate;
  // mono sum of the input range this call can touch (for the alignment search only)
  const lo = Math.max(0, Math.floor(Math.min(pos(-half), pos(0))) - FRAME - SEEK);
  const hi = Math.min(len, Math.ceil(pos(outLength + FRAME)) + FRAME + SEEK);
  const sum = new Float32Array(Math.max(0, hi - lo));
  for (const ch of channels) for (let i = lo; i < hi; i++) sum[i - lo]! += ch[i]!;
  const mono = (i: number): number => (i >= lo && i < hi ? sum[i - lo]! : 0);
  let prev = Number.NaN; // input centre of the previous frame
  const frames = Math.ceil(outLength / HOP) + 1;
  for (let k = 0; k <= frames; k++) {
    const oc = k * HOP; // output centre
    let centre = Math.round(pos(oc));
    // rate 1 here (source advanced exactly one hop): a plain copy needs no alignment
    const rate1 = unity || (k > 0 && Math.abs(pos(oc) - pos(oc - HOP) - HOP) < 1e-6);
    if (k > 0 && !rate1) {
      // find the offset whose overlap region best continues the previous frame
      const nat = Math.round(prev + HOP);
      const corr = (d: number, step: number) => {
        let s = 0;
        for (let n = -half / 2; n < half / 2; n += step) s += mono(nat + n) * mono(centre + d + n);
        return s;
      };
      let best = 0;
      let bestV = -Infinity;
      for (let d = -SEEK; d <= SEEK; d += 4) {
        const v = corr(d, 4);
        if (v > bestV) (bestV = v), (best = d);
      }
      const coarse = best;
      for (let d = coarse - 3; d <= coarse + 3; d++) {
        const v = corr(d, 1);
        if (v > bestV || d === coarse - 3) (bestV = v), (best = d);
      }
      centre += best;
    }
    prev = centre;
    for (let n = 0; n < FRAME; n++) {
      const o = oc - half + n;
      if (o < 0 || o >= outLength) continue;
      const i = centre - half + n;
      if (i < 0 || i >= len) continue;
      const g = w[n]!;
      for (let c = 0; c < channels.length; c++) out[c]![o]! += g * channels[c]![i]!;
    }
  }
  return out;
}

/** −1 dBFS: leaves headroom for AAC overshoot. */
export const LIMIT_CEILING = Math.pow(10, -1 / 20);

/**
 * In-place look-ahead peak limiter. Returns the deepest gain reduction in dB (0 = untouched).
 * Gain = moving average (attack = look-ahead) of a release-smoothed sliding minimum of the
 * required gain, so it is never above what any sample in its window needs: no overs.
 */
export function limitPeaks(channels: Float32Array[], sampleRate: number, ceiling = LIMIT_CEILING, lookaheadSec = 0.005, releaseSec = 0.15): number {
  if (!channels.length) return 0;
  const n = channels[0]!.length;
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  if (peak <= ceiling) return 0;

  const L = Math.max(1, Math.round(lookaheadSec * sampleRate));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of channels) p = Math.max(p, Math.abs(ch[i]!));
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // sliding minimum over [i, i + L] (monotonic deque)
  const ahead = new Float32Array(n);
  const dq = new Int32Array(n + L + 1);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const end = Math.min(n - 1, i + L);
    while (next <= end) {
      while (tail > head && need[dq[tail - 1]!]! >= need[next]!) tail--;
      dq[tail++] = next++;
    }
    while (dq[head]! < i) head++;
    ahead[i] = need[dq[head]!]!;
  }
  // release: recover towards 1, never above the look-ahead minimum
  const rel = 1 - Math.exp(-1 / (releaseSec * sampleRate));
  let r = 1;
  for (let i = 0; i < n; i++) {
    r = Math.min(ahead[i]!, r + (1 - r) * rel);
    ahead[i] = r;
  }
  // attack: moving average of the last L + 1 values (each ≤ need[i] by construction)
  // before the first sample, assume the first gain (≤ every need in [0, L])
  let minGain = 1;
  const win = L + 1;
  const hist = new Float32Array(win).fill(ahead[0]!);
  let sum = win * ahead[0]!;
  for (let i = 0; i < n; i++) {
    sum += ahead[i]! - hist[i % win]!;
    hist[i % win] = ahead[i]!;
    const g = Math.min(1, sum / win);
    if (g < 1) for (const ch of channels) ch[i]! *= g;
    minGain = Math.min(minGain, g);
  }
  return 20 * Math.log10(minGain);
}
