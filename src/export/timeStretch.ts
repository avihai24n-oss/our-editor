/**
 * Speed-mapped audio for the export mix. Pure (Float32Array in, Float32Array out), no Web Audio,
 * so it is unit-tested in Node.
 *
 * Both renderers take `srcAt(n)`: the SOURCE time in seconds that output sample n (seconds =
 * n / sampleRate from the clip's start) must play. That is exactly the clip's time mapping
 * (inPoint + ∫ speed), so standard speed and speed curves share one code path.
 *
 * - `resampleMapped` — "Change audio pitch" ON: read the source at the mapped time (linear
 *   interpolation, with a box pre-filter when reading faster than 1x). Pitch follows speed, like
 *   a tape.
 * - `stretchMapped` — "Change audio pitch" OFF (CapCut's default): WSOLA time-stretch. Hann
 *   grains of `GRAIN` samples are overlap-added at a fixed output hop; each grain is read at
 *   rate 1 from around the mapped source position, shifted by up to ±SEEK samples to the
 *   position that best continues the previous grain (cross-correlation). Pitch is preserved.
 */

export type SourceMap = (n: number) => number;

/** Grain length (samples) and output hop: 2048 / 1024 at 48 kHz ≈ 43 ms / 21 ms. */
export const GRAIN = 2048;
export const HOP = GRAIN / 2;
/** WSOLA search radius (samples). */
export const SEEK = 384;

const hann = (() => {
  const w = new Float32Array(GRAIN);
  // periodic Hann: overlap-add at 50 % sums to exactly 1
  for (let i = 0; i < GRAIN; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);
  return w;
})();

const sampleAt = (ch: Float32Array, pos: number): number => {
  if (pos < 0 || pos > ch.length - 1) return 0;
  const i = Math.floor(pos);
  const f = pos - i;
  const a = ch[i]!;
  const b = i + 1 < ch.length ? ch[i + 1]! : a;
  return a + (b - a) * f;
};

/** Pitch follows speed: out[n] = source(srcAt(n)). */
export function resampleMapped(channels: readonly Float32Array[], sampleRate: number, outFrames: number, srcAt: SourceMap): Float32Array[] {
  const out = channels.map(() => new Float32Array(outFrames));
  for (let n = 0; n < outFrames; n++) {
    const pos = srcAt(n) * sampleRate;
    const next = srcAt(n + 1) * sampleRate;
    const step = Math.abs(next - pos);
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]!;
      let v: number;
      if (step <= 1.5) v = sampleAt(ch, pos);
      else {
        // reading faster than ~1.5x: average the samples this output sample spans (anti-alias)
        const k = Math.min(64, Math.ceil(step));
        let sum = 0;
        for (let j = 0; j < k; j++) sum += sampleAt(ch, pos + ((j + 0.5) / k - 0.5) * step);
        v = sum / k;
      }
      out[c]![n] = v;
    }
  }
  return out;
}

/** Pitch preserved: WSOLA overlap-add of rate-1 grains placed along srcAt. */
/**
 * A SourceMap that evaluates `exact` every `every` samples and interpolates linearly between
 * (speed curves are smooth; this keeps the integral out of the per-sample loop).
 */
export function sampledMap(exact: SourceMap, outFrames: number, every = 32): SourceMap {
  const n = Math.ceil((outFrames + GRAIN) / every) + 2;
  const tab = new Float64Array(n);
  for (let i = 0; i < n; i++) tab[i] = exact(i * every);
  return (s: number) => {
    if (s <= 0) return exact(s);
    const f = s / every;
    const i = Math.floor(f);
    if (i + 1 >= n) return exact(s);
    return tab[i]! + (tab[i + 1]! - tab[i]!) * (f - i);
  };
}

export function stretchMapped(channels: readonly Float32Array[], sampleRate: number, outFrames: number, srcAt: SourceMap): Float32Array[] {
  const nCh = channels.length;
  const out = channels.map(() => new Float32Array(outFrames + GRAIN));
  const len = channels[0]?.length ?? 0;
  if (!len) return out.map((o) => o.subarray(0, outFrames));
  // mono guide signal for the similarity search
  const guide = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) guide[i]! += ch[i]! / nCh;

  let prevStart = Number.NaN; // source start of the previous grain (samples)
  for (let k = 0; ; k++) {
    const outStart = k * HOP - HOP; // first grain is centred on output sample 0
    if (outStart >= outFrames) break;
    const centre = outStart + GRAIN / 2;
    const ideal = Math.round(srcAt(centre) * sampleRate - GRAIN / 2);
    let start = ideal;
    if (Number.isFinite(prevStart)) {
      // the natural continuation of the previous grain, one hop later
      const natural = prevStart + HOP;
      start = bestMatch(guide, natural, ideal, SEEK);
    }
    prevStart = start;
    for (let c = 0; c < nCh; c++) {
      const src = channels[c]!;
      const dst = out[c]!;
      for (let i = 0; i < GRAIN; i++) {
        const o = outStart + i;
        if (o < 0 || o >= dst.length) continue;
        const si = start + i;
        if (si < 0 || si >= len) continue;
        dst[o]! += src[si]! * hann[i]!;
      }
    }
  }
  return out.map((o) => o.subarray(0, outFrames));
}

/**
 * The start in [ideal − radius, ideal + radius] whose first half-grain correlates best with the
 * half-grain that follows the previous grain at `natural` (decimated by 4 for speed).
 */
function bestMatch(guide: Float32Array, natural: number, ideal: number, radius: number): number {
  const L = HOP;
  const n = guide.length;
  let best = ideal;
  let bestScore = -Infinity;
  for (let d = -radius; d <= radius; d += 2) {
    const s = ideal + d;
    let score = 0;
    let e = 1e-9;
    for (let i = 0; i < L; i += 4) {
      const a = natural + i;
      const b = s + i;
      const x = a >= 0 && a < n ? guide[a]! : 0;
      const y = b >= 0 && b < n ? guide[b]! : 0;
      score += x * y;
      e += y * y;
    }
    score /= Math.sqrt(e);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}
