/**
 * Speed curves (CapCut Speed › Curve). Pure math, no DOM.
 *
 * A curve is a list of points over the clip's NORMALISED OUTPUT time x ∈ [0, 1] (0 = clip start
 * on the timeline, 1 = clip end). Each point has a speed v (0.1x … 10x) and an optional slope s
 * of log10(v) per unit x (0 = flat, the default; non-zero slopes only appear on pieces cut out of a
 * curve by split / trim). Between two points the curve is a cubic Hermite in log10(v), so the
 * curve is smooth, flat at every authored point (like CapCut's beats), and stays inside
 * [min(v0, v1), max(v0, v1)] when both slopes are 0.
 *
 * For a clip of timeline duration D the source (media) offset at local time τ ∈ [0, D] is
 *     src(τ) = ∫₀^τ v(t / D) dt = D · F(τ / D),   F(x) = ∫₀^x v(u) du.
 * So the source span is S = D · F(1) = D · mean, and D = S / mean (mean = F(1)).
 *
 * Cubic Hermite segments are closed under affine re-parametrisation, so cutting a curve at any x
 * (split, trim) gives an EXACT curve for each piece: `sliceCurve`.
 */

export interface SpeedCurvePoint {
  /** Normalised output time 0..1. The first point is at 0 and the last at 1. */
  x: number;
  /** Speed multiplier (CapCut range 0.1 … 10). */
  v: number;
  /** Slope of log10(v) per unit x leaving the point (and arriving, unless `sl` is set). Omitted = 0. */
  s?: number;
  /** Slope arriving at the point, when it differs from `s` (a flat extension after a cut). */
  sl?: number;
}

export type CurvePresetId = 'custom' | 'montage' | 'hero' | 'bullet' | 'jump-cut' | 'flash-in' | 'flash-out';

export interface SpeedCurve {
  /** Which tile is selected in the inspector. Editing points keeps the preset id (CapCut). */
  preset: CurvePresetId;
  points: SpeedCurvePoint[];
}

export const CURVE_SPEED_MIN = 0.1;
export const CURVE_SPEED_MAX = 10;
/** Smallest distance between two neighbouring points (normalised). */
export const CURVE_MIN_GAP = 0.02;

type P = [x: number, v: number];
const pts = (list: P[]): SpeedCurvePoint[] => list.map(([x, v]) => ({ x, v }));

/**
 * Preset shapes. Measured from CapCut desktop's preset thumbnails (docs/capcut-screens/05):
 * the thumbnails share the editor's axes — centre line 1x, dashed guides at √10 ≈ 3.16x and
 * 1/√10 ≈ 0.32x, edges 10x / 0.1x — and each peak / valley / plateau is a point here.
 */
export const CURVE_PRESETS: { id: CurvePresetId; label: string; points: SpeedCurvePoint[] }[] = [
  { id: 'custom', label: 'Custom', points: pts([[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1, 1]]) },
  { id: 'montage', label: 'Montage', points: pts([[0, 1], [0.1, 1], [0.43, 3.7], [0.68, 0.25], [0.81, 1], [1, 1]]) },
  { id: 'hero', label: 'Hero', points: pts([[0, 1], [0.27, 2.7], [0.33, 2.7], [0.48, 0.3], [0.63, 2.7], [0.69, 2.7], [1, 1]]) },
  { id: 'bullet', label: 'Bullet', points: pts([[0, 2.7], [0.3, 2.7], [0.48, 0.27], [0.72, 2.7], [1, 2.7]]) },
  { id: 'jump-cut', label: 'Jump cut', points: pts([[0, 0.35], [0.34, 0.35], [0.5, 3], [0.66, 0.35], [1, 0.35]]) },
  { id: 'flash-in', label: 'Flash in', points: pts([[0, 3], [0.31, 3], [0.66, 1], [1, 1]]) },
  { id: 'flash-out', label: 'Flash out', points: pts([[0, 1], [0.34, 1], [0.69, 3], [1, 3]]) },
];

export const presetLabel = (id: CurvePresetId): string => CURVE_PRESETS.find((p) => p.id === id)?.label ?? 'Curve';

/** A fresh copy of a preset's curve. */
export function presetCurve(id: CurvePresetId): SpeedCurve {
  const p = CURVE_PRESETS.find((x) => x.id === id) ?? CURVE_PRESETS[0]!;
  return { preset: p.id, points: p.points.map((q) => ({ ...q })) };
}

// ---------------------------------------------------------------- evaluation

const LN10 = Math.LN10;

/** Segment index i such that points[i].x <= x <= points[i+1].x (clamped to the ends). */
function segmentOf(points: readonly SpeedCurvePoint[], x: number): number {
  const n = points.length;
  if (x <= points[0]!.x) return 0;
  if (x >= points[n - 1]!.x) return n - 2;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.x <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** log10(speed) and its derivative d/dx inside segment i. */
function hermite(points: readonly SpeedCurvePoint[], i: number, x: number): { L: number; dL: number } {
  const a = points[i]!;
  const b = points[i + 1]!;
  const h = b.x - a.x;
  if (h <= 0) return { L: Math.log10(b.v), dL: 0 };
  const u = (x - a.x) / h;
  const L0 = Math.log10(a.v);
  const L1 = Math.log10(b.v);
  const m0 = (a.s ?? 0) * h;
  const m1 = (b.sl ?? b.s ?? 0) * h;
  const u2 = u * u;
  const u3 = u2 * u;
  const L = (2 * u3 - 3 * u2 + 1) * L0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * L1 + (u3 - u2) * m1;
  const dLdu = (6 * u2 - 6 * u) * L0 + (3 * u2 - 4 * u + 1) * m0 + (-6 * u2 + 6 * u) * L1 + (3 * u2 - 2 * u) * m1;
  return { L, dL: dLdu / h };
}

/**
 * Speed at normalised time x. Outside [0, 1] the end speeds continue (flat), which is how a clip
 * keeps reading its source past its edges (transition windows).
 */
export function curveSpeedAt(curve: SpeedCurve, x: number): number {
  const p = curve.points;
  if (x <= 0) return p[0]!.v;
  if (x >= 1) return p[p.length - 1]!.v;
  return Math.pow(10, hermite(p, segmentOf(p, x), x).L);
}

/** d/dx log10(speed) at x (for slicing); `left` = the slope arriving at x. */
function curveLogSlopeAt(curve: SpeedCurve, x: number, left = false): number {
  const p = curve.points;
  let i = segmentOf(p, x);
  if (left && i > 0 && x <= p[i]!.x) i -= 1;
  return hermite(p, i, x).dL;
}

// Gauss–Legendre, 8 nodes on [-1, 1].
const GL_X = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498, 0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620, 0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

/** ∫ speed over [x0, x1] inside segment i (one Gauss–Legendre pass). */
function glSegment(points: readonly SpeedCurvePoint[], i: number, x0: number, x1: number): number {
  const half = (x1 - x0) / 2;
  if (half <= 0) return 0;
  const mid = (x0 + x1) / 2;
  let sum = 0;
  for (let k = 0; k < 8; k++) sum += GL_W[k]! * Math.exp(hermite(points, i, mid + half * GL_X[k]!).L * LN10);
  return sum * half;
}

/** Sub-intervals per segment for the cumulative table. */
const SUB = 16;

interface Table {
  /** cum[i * SUB + j] = F at the start of sub-interval j of segment i; last entry = F(1). */
  cum: Float64Array;
}

const tables = new WeakMap<readonly SpeedCurvePoint[], Table>();

function table(curve: SpeedCurve): Table {
  const p = curve.points;
  let t = tables.get(p);
  if (t) return t;
  const n = p.length - 1;
  const cum = new Float64Array(n * SUB + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = p[i]!.x;
    const h = (p[i + 1]!.x - a) / SUB;
    for (let j = 0; j < SUB; j++) {
      cum[i * SUB + j] = acc;
      acc += glSegment(p, i, a + j * h, a + (j + 1) * h);
    }
  }
  cum[n * SUB] = acc;
  t = { cum };
  tables.set(p, t);
  return t;
}

/** F(x) = ∫₀^x speed(u) du for x in [0, 1]; beyond the ends the end speeds continue. */
export function curveIntegral(curve: SpeedCurve, x: number): number {
  const p = curve.points;
  const { cum } = table(curve);
  const n = p.length - 1;
  if (x <= 0) return x * p[0]!.v;
  if (x >= 1) return cum[n * SUB]! + (x - 1) * p[n]!.v;
  const i = segmentOf(p, x);
  const a = p[i]!.x;
  const h = (p[i + 1]!.x - a) / SUB;
  const j = h > 0 ? Math.min(SUB - 1, Math.floor((x - a) / h)) : 0;
  const x0 = a + j * h;
  return cum[i * SUB + j]! + glSegment(p, i, x0, x);
}

/** Mean speed over the clip = F(1). Output duration D = sourceSpan / mean. */
export const curveMean = (curve: SpeedCurve): number => curveIntegral(curve, 1);

/** Inverse of F: the x where F(x) = y (F is strictly increasing). Extrapolates past the ends. */
export function curveIntegralInverse(curve: SpeedCurve, y: number): number {
  const p = curve.points;
  const total = curveMean(curve);
  if (y <= 0) return y / p[0]!.v;
  if (y >= total) return 1 + (y - total) / p[p.length - 1]!.v;
  const { cum } = table(curve);
  // binary search the table for the sub-interval
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= y) lo = mid;
    else hi = mid;
  }
  const i = Math.floor(lo / SUB);
  const j = lo % SUB;
  const a = p[i]!.x;
  const h = (p[i + 1]!.x - a) / SUB;
  let xl = a + j * h;
  let xr = a + (j + 1) * h;
  // safeguarded Newton inside [xl, xr]
  let x = xl + (h * (y - cum[lo]!)) / Math.max(1e-12, cum[hi]! - cum[lo]!);
  for (let k = 0; k < 40; k++) {
    const f = curveIntegral(curve, x) - y;
    if (Math.abs(f) < 1e-13) break;
    if (f > 0) xr = x;
    else xl = x;
    const d = curveSpeedAt(curve, x);
    let nx = x - f / d;
    if (!(nx > xl && nx < xr)) nx = (xl + xr) / 2;
    if (Math.abs(nx - x) < 1e-15) break;
    x = nx;
  }
  return x;
}

// ---------------------------------------------------------------- editing helpers

/** Copies the curve; sorts, clamps speeds and the end points to x = 0 / 1. */
export function normalizeCurve(curve: SpeedCurve): SpeedCurve {
  const points = curve.points
    .map((q) => ({
      x: Math.min(1, Math.max(0, q.x)),
      v: Math.min(CURVE_SPEED_MAX, Math.max(CURVE_SPEED_MIN, q.v)),
      ...(q.s ? { s: q.s } : {}),
      ...(q.sl !== undefined && q.sl !== (q.s ?? 0) ? { sl: q.sl } : {}),
    }))
    .sort((a, b) => a.x - b.x);
  if (points.length < 2) return presetCurve(curve.preset);
  points[0]!.x = 0;
  points[points.length - 1]!.x = 1;
  return { preset: curve.preset, points };
}

/**
 * The part [a, b] of a curve, re-normalised to [0, 1]. Exact: every Hermite segment piece is
 * re-expressed with rescaled slopes, and new end points carry the value and slope at the cut.
 */
export function sliceCurve(curve: SpeedCurve, a: number, b: number): SpeedCurve {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(1, Math.max(a, b));
  const w = hi - lo;
  if (w <= 1e-9) {
    const v = curveSpeedAt(curve, lo);
    return { preset: curve.preset, points: [{ x: 0, v }, { x: 1, v }] };
  }
  const eps = 1e-9;
  const slopes = (s: number, sl: number | undefined): Pick<SpeedCurvePoint, 's' | 'sl'> => {
    const out: Pick<SpeedCurvePoint, 's' | 'sl'> = {};
    if (Math.abs(s) > 1e-12) out.s = s;
    if (sl !== undefined && Math.abs(sl - s) > 1e-12) out.sl = sl;
    return out;
  };
  const out: SpeedCurvePoint[] = [{ x: 0, v: curveSpeedAt(curve, lo), ...slopes(curveLogSlopeAt(curve, lo) * w, undefined) }];
  for (const q of curve.points) {
    if (q.x <= lo + eps || q.x >= hi - eps) continue;
    out.push({ x: (q.x - lo) / w, v: q.v, ...slopes((q.s ?? 0) * w, q.sl !== undefined ? q.sl * w : undefined) });
  }
  out.push({ x: 1, v: curveSpeedAt(curve, hi), ...slopes(curveLogSlopeAt(curve, hi, true) * w, undefined) });
  return { preset: curve.preset, points: out };
}

/**
 * A curve of duration D extended by `before` / `after` µs of output time at the end speeds
 * (trimming a curve clip outwards). Returns the new curve over D + before + after.
 */
export function extendCurve(curve: SpeedCurve, D: number, before: number, after: number): SpeedCurve {
  const b = Math.max(0, before);
  const f = Math.max(0, after);
  if (b === 0 && f === 0) return curve;
  const D2 = D + b + f;
  const k = D2 / D;
  const n = curve.points.length;
  const out: SpeedCurvePoint[] = [];
  if (b > 0) out.push({ x: 0, v: curve.points[0]!.v });
  curve.points.forEach((q, i) => {
    let so = (q.s ?? 0) * k; // leaving
    let si = (q.sl ?? q.s ?? 0) * k; // arriving
    if (i === 0 && b > 0) si = 0; // the new flat part arrives flat
    if (i === n - 1 && f > 0) so = 0; // and leaves flat
    const p: SpeedCurvePoint = { x: (b + q.x * D) / D2, v: q.v };
    if (Math.abs(so) > 1e-12) p.s = so;
    if (Math.abs(si - so) > 1e-12) p.sl = si;
    out.push(p);
  });
  if (f > 0) out.push({ x: 1, v: curve.points[n - 1]!.v });
  out[0]!.x = 0;
  out[out.length - 1]!.x = 1;
  return { preset: curve.preset, points: out };
}

/** True when two curves have the same points (ignores the preset id). */
export function sameCurvePoints(a: SpeedCurve | null | undefined, b: SpeedCurve | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.points.length !== b.points.length) return false;
  return a.points.every((p, i) => {
    const q = b.points[i]!;
    return (
      Math.abs(p.x - q.x) < 1e-9 &&
      Math.abs(p.v - q.v) < 1e-9 &&
      Math.abs((p.s ?? 0) - (q.s ?? 0)) < 1e-9 &&
      Math.abs((p.sl ?? p.s ?? 0) - (q.sl ?? q.s ?? 0)) < 1e-9
    );
  });
}

/** Log-scale position 0 (0.1x, bottom) … 1 (10x, top) of a speed in the curve editor. */
export const speedToCurveY = (v: number): number => (Math.log10(Math.min(CURVE_SPEED_MAX, Math.max(CURVE_SPEED_MIN, v))) + 1) / 2;
export const curveYToSpeed = (y: number): number => Math.pow(10, Math.min(1, Math.max(0, y)) * 2 - 1);
