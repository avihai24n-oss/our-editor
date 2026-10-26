/**
 * Resolve-style HSL curves (Hue vs Hue / Sat / Lum, Lum vs Sat, Sat vs Sat): smooth curves through
 * the control points (y = 0.5 neutral), baked into one float table the shader samples as a
 * 256 × 2 RGBA16F texture:
 *   row 0, texel i: [HueHue, HueSat, HueLum](hue = i / 256 · 360°, periodic) and LumSat(x = i / 255)
 *   row 1, texel i: [SatSat(x = i / 255), 0, 0, 0]
 * Hue curves wrap around (the point at 350° and the one at 10° are neighbours).
 */
import type { CurvePoint } from '../../model/types';
import type { HslCurvesSettings } from '../../model/colorPage';

export const HSL_CURVE_SIZE = 256;

/** Monotone (Fritsch–Carlson) cubic through sorted points; flat outside [x0, xn]. No clamping of x. */
function hermite(p: readonly CurvePoint[]): (x: number) => number {
  const n = p.length;
  if (n === 0) return () => 0.5;
  if (n === 1) return () => p[0]!.y;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(p[i + 1]!.x - p[i]!.x);
    m.push((p[i + 1]!.y - p[i]!.y) / dx[i]!);
  }
  const t: number[] = new Array(n);
  t[0] = m[0]!;
  t[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    const a = m[i - 1]!;
    const b = m[i]!;
    t[i] = a * b <= 0 ? 0 : (a + b) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const s = m[i]!;
    if (s === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / s;
    const b = t[i + 1]! / s;
    const h = a * a + b * b;
    if (h > 9) {
      const k = 3 / Math.sqrt(h);
      t[i] = k * a * s;
      t[i + 1] = k * b * s;
    }
  }
  return (x: number) => {
    if (x <= p[0]!.x) return p[0]!.y;
    if (x >= p[n - 1]!.x) return p[n - 1]!.y;
    let i = 0;
    while (i < n - 2 && x > p[i + 1]!.x) i++;
    const h = dx[i]!;
    const u = (x - p[i]!.x) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p[i]!.y + (u3 - 2 * u2 + u) * h * t[i]! + (-2 * u3 + 3 * u2) * p[i + 1]!.y + (u3 - u2) * h * t[i + 1]!;
  };
}

/** Sorted, de-duplicated (by x, or x mod 1 when periodic) copy of the points. */
export function cleanPoints(points: readonly CurvePoint[], periodic: boolean): CurvePoint[] {
  const pts = points
    .filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y))
    .map((q) => ({ x: periodic ? ((q.x % 1) + 1) % 1 : Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) }))
    .sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - q.x) < 1e-6) last.y = q.y;
    else out.push(q);
  }
  return out;
}

/** f(x) of one HSL curve (0.5 everywhere for an empty list). Hue curves: x in 0..1 wraps. */
export function hslCurveFn(points: readonly CurvePoint[], periodic: boolean): (x: number) => number {
  const p = cleanPoints(points, periodic);
  if (!p.length) return () => 0.5;
  if (!periodic) return hermite(p);
  if (p.length === 1) return () => p[0]!.y;
  const ext = [...p.map((q) => ({ x: q.x - 1, y: q.y })), ...p, ...p.map((q) => ({ x: q.x + 1, y: q.y }))];
  const f = hermite(ext);
  return (x: number) => f(((x % 1) + 1) % 1);
}

export const isFlatCurve = (points: readonly CurvePoint[]): boolean => points.every((q) => Math.abs(q.y - 0.5) < 1e-4);

export function hslCurvesAreNeutral(c: HslCurvesSettings): boolean {
  return isFlatCurve(c.hueHue) && isFlatCurve(c.hueSat) && isFlatCurve(c.hueLum) && isFlatCurve(c.lumSat) && isFlatCurve(c.satSat);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The 256 × 2 RGBA float table (see the file comment). */
export function bakeHslCurves(c: HslCurvesSettings): Float32Array {
  const N = HSL_CURVE_SIZE;
  const hh = hslCurveFn(c.hueHue, true);
  const hs = hslCurveFn(c.hueSat, true);
  const hl = hslCurveFn(c.hueLum, true);
  const ls = hslCurveFn(c.lumSat, false);
  const ss = hslCurveFn(c.satSat, false);
  const out = new Float32Array(N * 2 * 4);
  for (let i = 0; i < N; i++) {
    const hx = i / N;
    const lx = i / (N - 1);
    out[i * 4] = clamp01(hh(hx));
    out[i * 4 + 1] = clamp01(hs(hx));
    out[i * 4 + 2] = clamp01(hl(hx));
    out[i * 4 + 3] = clamp01(ls(lx));
    out[(N + i) * 4] = clamp01(ss(lx));
  }
  return out;
}

/** Hue-row sample at hue `deg` (periodic linear filter, like GL REPEAT + LINEAR). Returns [HH, HS, HL]. */
export function sampleHueRow(t: Float32Array, deg: number): [number, number, number] {
  const N = HSL_CURVE_SIZE;
  const x = ((((deg / 360) % 1) + 1) % 1) * N;
  const i0 = Math.floor(x) % N;
  const i1 = (i0 + 1) % N;
  const f = x - Math.floor(x);
  return [0, 1, 2].map((k) => t[i0 * 4 + k]! * (1 - f) + t[i1 * 4 + k]! * f) as [number, number, number];
}

/** Non-periodic sample (x 0..1) of row `row`, channel `ch` (like GL CLAMP + LINEAR at texel centres). */
export function sampleLinRow(t: Float32Array, row: number, ch: number, x: number): number {
  const N = HSL_CURVE_SIZE;
  const p = clamp01(x) * (N - 1);
  const i = Math.min(N - 2, Math.floor(p));
  const f = p - i;
  const b = row * N;
  return t[(b + i) * 4 + ch]! * (1 - f) + t[(b + i + 1) * 4 + ch]! * f;
}
