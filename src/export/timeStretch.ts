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
 * - `stretchMapped` — "Change audio pitch" OFF (CapCut's default): WSOLA time-stretch, from
 *   ./audioDsp (one implementation for standard speed and curves). Pitch is preserved.
 */

export type { SourceMap } from './audioDsp';
import type { SourceMap } from './audioDsp';

/** Look-ahead margin of sampledMap's table (one WSOLA frame). */
const GRAIN = 2048;


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

/**
 * Pitch preserved: the project's single WSOLA implementation lives in ./audioDsp (shared with the
 * standard-speed path); re-exported here so the mix code has one import for both renderers.
 */
export { stretchMapped } from './audioDsp';
