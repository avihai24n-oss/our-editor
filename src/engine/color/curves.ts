/**
 * Tone curves: monotone cubic Hermite interpolation (Fritsch–Carlson) through the control points,
 * baked into 256-entry tables. Monotone points give a monotone curve with no overshoot, so a
 * curve never folds back on itself or rings past its neighbours.
 */
import type { CurvePoint, CurvesSettings } from '../../model/types';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Sorted, de-duplicated, clamped copy of the points; always has an entry at x=0 and x=1. */
export function normalizeCurve(points: readonly CurvePoint[]): CurvePoint[] {
  const pts = points
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6) last.y = p.y;
    else out.push(p);
  }
  if (!out.length) return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
  if (out[0]!.x > 0) out.unshift({ x: 0, y: out[0]!.y });
  if (out[out.length - 1]!.x < 1) out.push({ x: 1, y: out[out.length - 1]!.y });
  return out;
}

/** True when the curve is the identity diagonal. */
export function isIdentityCurve(points: readonly CurvePoint[]): boolean {
  return points.every((p) => Math.abs(p.x - p.y) < 1e-4);
}

/**
 * Returns f(x) for the monotone cubic through `points` (Fritsch–Carlson tangents).
 * Outside [x0, xn] the curve is flat (end values).
 */
export function monotoneCurve(points: readonly CurvePoint[]): (x: number) => number {
  const p = normalizeCurve(points);
  const n = p.length;
  if (n === 1) return () => p[0]!.y;
  const dx: number[] = [];
  const m: number[] = []; // secant slopes
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
  // Fritsch–Carlson: limit the tangents so each segment stays monotone
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
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return h00 * p[i]!.y + h10 * h * t[i]! + h01 * p[i + 1]!.y + h11 * h * t[i + 1]!;
  };
}

/** 256 samples of a curve, 0..1. */
export function bakeCurve(points: readonly CurvePoint[]): Float32Array {
  const f = monotoneCurve(points);
  const out = new Float32Array(256);
  for (let i = 0; i < 256; i++) out[i] = clamp01(f(i / 255));
  return out;
}

/**
 * The full Curves section as one RGBA8 table (256 × 4 bytes): entry i of channel c is
 * channelCurve(masterCurve(i / 255)). The master (luma) curve runs first, then R / G / B.
 */
export function bakeCurvesTable(c: CurvesSettings): Uint8Array {
  const master = monotoneCurve(c.master);
  const ch = [monotoneCurve(c.red), monotoneCurve(c.green), monotoneCurve(c.blue)];
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const m = clamp01(master(i / 255));
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(clamp01(ch[k]!(m)) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function curvesAreIdentity(c: CurvesSettings): boolean {
  return isIdentityCurve(c.master) && isIdentityCurve(c.red) && isIdentityCurve(c.green) && isIdentityCurve(c.blue);
}

/** Samples a baked table like the GPU does (linear filter between the 256 entries). */
export function sampleTable(table: Uint8Array, channel: number, v: number): number {
  const x = clamp01(v) * 255;
  const i = Math.min(254, Math.floor(x));
  const f = x - i;
  return ((table[i * 4 + channel]! * (1 - f) + table[(i + 1) * 4 + channel]! * f) / 255);
}
