/**
 * The Color page stage (Adjust › Color, DaVinci Resolve–style): model → shader parameters and the
 * CPU reference the GLSL (./colorStageGlsl.ts) mirrors line by line. It runs inside the shared
 * colour pass right after the Lift / Gamma / Gain / Offset wheels (see ./math.ts gradePixel), so
 * the player and the export get the same pixels.
 *
 * Order and formulas (v = one channel, sRGB-encoded 0..1 unless noted; Y = Rec.709 luma):
 *  0. CST (input colour space → Rec.709 display): log decode → scene linear (→ AWG3→709 matrix for
 *     LogC3) → tone map T(x) = x'(1 + x'/64)/(1 + x'), x' = 1.2x → sRGB encode. "Rec.709 → Log"
 *     re-encodes the display-linear picture with ARRI LogC3 (a flat, log-ish image).
 *     The qualifier keys on the picture right after this step (the stage input).
 *  1. Temp / Tint — linear light: c_lin · g, g = white(6500 K − temp) / white(6500 K) (CIE Planckian
 *     locus, Kim et al. 2002 cubic) × tint gains [1 + k/2, 1 − k, 1 + k/2] (k = 0.3 · tint/100),
 *     normalised to luma(g) = 1 so mid grey keeps its brightness.
 *  2. Contrast c around pivot p — a power S-curve per channel that keeps 0 → 0 and 1 → 1:
 *     v < p ? p·(v/p)^c : 1 − (1−p)·((1−v)/(1−p))^c   (slope c at the pivot, no clipping).
 *  3. Shadows s / Highlights h: Y += 0.25·s·Ŝ(Y) + 0.25·h·Ĥ(Y), Ŝ = 9.48·Y(1−Y)³ (peak 1 at
 *     Y = ¼), Ĥ = 9.48·Y³(1−Y) (peak 1 at Y = ¾); the luma change is added to R, G and B.
 *  4. Midtone detail: += md · D · 4Y(1−Y), D = source luma minus its 12/1080-radius ring average
 *     (the Clarity kernel): local contrast in the mid-tones (negative softens).
 *  5. Log wheels: += wS·S + wM·M + wH·H with wS = 1 − smoothstep(low ∓ 0.12, Y),
 *     wH = smoothstep(high ∓ 0.12, Y), wM = 1 − wS − wH; each wheel vector = 0.25·chroma + 0.25·luma.
 *  6. Color boost b (vibrance): chroma × max(0, 1 + 0.8·b·(1 − S_hsv)).
 *  7. Saturation and Hue: one luma-preserving matrix H(θ)·S(s), S = (1−s)·[luma rows] + s·I,
 *     H = the Rec.709 hue rotation (as SVG feColorMatrix hueRotate), θ = (hue − 50)/50 · 180°.
 *  8. HSL curves: hue rotation by (HH − ½)·360°, chroma × (1 + (2HS − 1)) · 2LS · 2SS,
 *     luma × 2^(2HL − 1) — hue-driven parts weighted by a chroma key so greys stay grey.
 *  9. Qualifier: matte = hue window (soft, wraps 360°) · sat band · lum band (each optional),
 *     invert, clean black / white, × power window; out = mix(out, secondary(out), matte), where
 *     secondary = exposure + temp/tint gains in linear light → contrast (pivot 0.435) → sat·hue
 *     matrix. Show matte outputs the matte as grey.
 * Every step is skipped when neutral; `colorStageParams()` returns null when the whole page is.
 */
import type { ColorPage, QualifierSettings } from '../../model/colorPage';
import { bakeHslCurves, hslCurvesAreNeutral, sampleHueRow, sampleLinRow } from './hslCurves';
import { clamp01, luma, maskAlpha, rgbToHsv, smoothstep, srgbToLinear, linearToSrgb } from './math';
import { maskParams, wheelChroma, type MaskParams, type Vec3 } from './params';

export const CK = {
  SHADOWS: 0.25,
  HIGHLIGHTS: 0.25,
  /** 1 / max(Y(1−Y)³) */
  TONE_NORM: 9.481,
  MID_DETAIL: 1.0,
  BOOST: 0.8,
  LOG_CHROMA: 0.25,
  LOG_LUMA: 0.25,
  LOG_SOFT: 0.12,
  TINT: 0.3,
  /** Reference white for Temp (K). */
  T0: 6500,
  /** Tone map pre-gain and white-ish (CST). */
  TM_GAIN: 1.2,
  TM_W2: 64,
  SEC_PIVOT: 0.435,
} as const;

/** CST ids as the shader sees them. */
export const CST_IDS = { none: 0, 'arri-logc3': 1, 'sony-slog3': 2, 'pana-vlog': 3, 'rec709-to-log': 4 } as const;

export interface QualParams {
  /** [on, centre°, half width°, soft°] */
  hue: [number, number, number, number];
  /** [on, low, high, soft], 0..1 */
  sat: [number, number, number, number];
  lum: [number, number, number, number];
  invert: boolean;
  cleanBlack: number;
  cleanWhite: number;
  window: MaskParams | null;
  /** Linear-light gains: exposure × temp/tint. */
  gain: Vec3;
  contrast: number;
  /** Row-major sat·hue matrix. */
  mat: Float32Array;
  showMatte: boolean;
}

export interface ColorStageParams {
  cst: number;
  /** Linear-light white balance gains, or null. */
  wb: Vec3 | null;
  contrast: number;
  pivot: number;
  /** -1..1 */
  shadows: number;
  highlights: number;
  midDetail: number;
  log: { s: Vec3; m: Vec3; h: Vec3; low: number; high: number } | null;
  boost: number;
  /** Row-major 3×3 saturation · hue matrix, or null. */
  satHue: Float32Array | null;
  /** HSL curves table (./hslCurves.ts), or null. */
  curves: Float32Array | null;
  curvesKey: string;
  qual: QualParams | null;
}

// ---------------------------------------------------------------- white balance

/** CIE 1931 xy of a Planckian radiator (Kim et al. 2002), 1667..25000 K. */
export function planckianXy(T: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, T));
  const x =
    t <= 4000
      ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y =
    t <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** Linear sRGB of the white of temperature T (Y = 1). */
export function kelvinRgb(T: number): Vec3 {
  const [x, y] = planckianXy(T);
  const X = x / y;
  const Z = (1 - x - y) / y;
  return [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z];
}

/** Temp (K shift, + = warmer) and tint (−100..100, + = magenta) as linear-light gains with luma 1; null when neutral. */
export function wbGains(temp: number, tint: number): Vec3 | null {
  if (!temp && !tint) return null;
  let g: Vec3 = [1, 1, 1];
  if (temp) {
    const a = kelvinRgb(CK.T0 - temp);
    const b = kelvinRgb(CK.T0);
    g = [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
  }
  if (tint) {
    const k = (CK.TINT * tint) / 100;
    g = [g[0] * (1 + k / 2), g[1] * (1 - k), g[2] * (1 + k / 2)];
  }
  const y = luma(g);
  return [g[0] / y, g[1] / y, g[2] / y];
}

// ---------------------------------------------------------------- matrices

/** Row-major luma-preserving hue rotation (Rec.709 weights; SVG feColorMatrix hueRotate). */
export function hueMatrix(deg: number): number[] {
  const a = Math.cos((deg * Math.PI) / 180);
  const b = Math.sin((deg * Math.PI) / 180);
  return [
    0.2126 + 0.7874 * a - 0.2126 * b, 0.7152 - 0.7152 * a - 0.7152 * b, 0.0722 - 0.0722 * a + 0.9278 * b,
    0.2126 - 0.2126 * a + 0.143 * b, 0.7152 + 0.2848 * a + 0.14 * b, 0.0722 - 0.0722 * a - 0.283 * b,
    0.2126 - 0.2126 * a - 0.7874 * b, 0.7152 - 0.7152 * a + 0.7152 * b, 0.0722 + 0.9278 * a + 0.0722 * b,
  ];
}

/** Row-major saturation matrix around Rec.709 luma (s = 1 neutral). */
export function satMatrix(s: number): number[] {
  const L = [0.2126, 0.7152, 0.0722];
  const m: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m.push((1 - s) * L[c]! + (r === c ? s : 0));
  return m;
}

export function mul3(a: readonly number[], b: readonly number[]): number[] {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return o;
}

export const applyMat = (m: ArrayLike<number>, c: Vec3): Vec3 => [
  m[0]! * c[0] + m[1]! * c[1] + m[2]! * c[2],
  m[3]! * c[0] + m[4]! * c[1] + m[5]! * c[2],
  m[6]! * c[0] + m[7]! * c[1] + m[8]! * c[2],
];

/** sat · hue matrix (null when both are neutral). `sat` 1 = neutral, `hueDeg` 0 = neutral. */
export function satHueMatrix(sat: number, hueDeg: number): Float32Array | null {
  if (Math.abs(sat - 1) < 1e-5 && Math.abs(hueDeg) < 1e-4) return null;
  return new Float32Array(mul3(hueMatrix(hueDeg), satMatrix(sat)));
}

// ---------------------------------------------------------------- params

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function logVec(w: { x: number; y: number; luma: number }): Vec3 {
  const c = wheelChroma(w);
  const l = (clamp(w.luma, -100, 100) / 100) * CK.LOG_LUMA;
  return [c[0] * CK.LOG_CHROMA + l, c[1] * CK.LOG_CHROMA + l, c[2] * CK.LOG_CHROMA + l];
}
const zero = (v: Vec3) => Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6 && Math.abs(v[2]) < 1e-6;

const qualCache = new Map<string, Float32Array>();
const curveCache = new Map<string, Float32Array>();

function qualParams(q: QualifierSettings): QualParams | null {
  if (!q.enabled) return null;
  const c = q.correction;
  const wb = wbGains(c.temp, c.tint) ?? [1, 1, 1];
  const e = Math.pow(2, clamp(c.exposure, -3, 3));
  const gain: Vec3 = [wb[0] * e, wb[1] * e, wb[2] * e];
  const sat = clamp(c.saturation, 0, 200) / 100;
  const mat = satHueMatrix(sat, clamp(c.hue, -180, 180));
  const neutral = zero([gain[0] - 1, gain[1] - 1, gain[2] - 1]) && Math.abs(c.contrast - 1) < 1e-4 && !mat;
  if (neutral && !q.showMatte) return null;
  const key = `${sat},${c.hue}`;
  let m = qualCache.get(key);
  if (!m) {
    m = mat ?? new Float32Array(satMatrix(1));
    if (qualCache.size > 32) qualCache.clear();
    qualCache.set(key, m);
  }
  const r = (x: { on: boolean; low: number; high: number; soft: number }): [number, number, number, number] => [
    x.on ? 1 : 0,
    clamp(x.low, 0, 100) / 100,
    clamp(x.high, 0, 100) / 100,
    clamp(x.soft, 0, 100) / 100,
  ];
  return {
    hue: [q.hue.on ? 1 : 0, ((q.hue.center % 360) + 360) % 360, clamp(q.hue.width, 0, 360) / 2, clamp(q.hue.soft, 0, 180)],
    sat: r(q.sat),
    lum: r(q.lum),
    invert: !!q.invert,
    cleanBlack: clamp(q.cleanBlack, 0, 50) / 100,
    cleanWhite: clamp(q.cleanWhite, 0, 50) / 100,
    window: maskParams(q.window),
    gain,
    contrast: clamp(c.contrast, 0, 2),
    mat: m,
    showMatte: !!q.showMatte,
  };
}

/** The Color page's shader parameters, or null when it changes no pixel. */
export function colorStageParams(cp: ColorPage | undefined | null): ColorStageParams | null {
  if (!cp || !cp.enabled) return null;
  const pr = cp.primaries;
  const on = pr.enabled;
  const lw = cp.logWheels;
  let log: ColorStageParams['log'] = null;
  if (lw.enabled) {
    const s = logVec(lw.shadow);
    const m = logVec(lw.midtone);
    const h = logVec(lw.highlight);
    if (!zero(s) || !zero(m) || !zero(h)) log = { s, m, h, low: clamp(lw.low, 0, 1), high: clamp(lw.high, 0, 1) };
  }
  let curves: Float32Array | null = null;
  let curvesKey = '';
  const hc = cp.hslCurves;
  if (hc.enabled && !hslCurvesAreNeutral(hc)) {
    curvesKey = JSON.stringify([hc.hueHue, hc.hueSat, hc.hueLum, hc.lumSat, hc.satSat]);
    curves = curveCache.get(curvesKey) ?? null;
    if (!curves) {
      curves = bakeHslCurves(hc);
      if (curveCache.size > 32) curveCache.clear();
      curveCache.set(curvesKey, curves);
    }
  }
  const p: ColorStageParams = {
    cst: CST_IDS[cp.cst.input] ?? 0,
    wb: on ? wbGains(clamp(pr.temp, -4000, 4000), clamp(pr.tint, -100, 100)) : null,
    contrast: on ? clamp(pr.contrast, 0, 2) : 1,
    pivot: clamp(pr.pivot, 0.02, 0.98),
    shadows: on ? clamp(pr.shadows, -100, 100) / 100 : 0,
    highlights: on ? clamp(pr.highlights, -100, 100) / 100 : 0,
    midDetail: on ? clamp(pr.midDetail, -100, 100) / 100 : 0,
    log,
    boost: on ? clamp(pr.colorBoost, -100, 100) / 100 : 0,
    satHue: on ? satHueMatrix(clamp(pr.saturation, 0, 100) / 50, ((clamp(pr.hue, 0, 100) - 50) / 50) * 180) : null,
    curves,
    curvesKey,
    qual: qualParams(cp.qualifier),
  };
  const neutral =
    !p.cst && !p.wb && Math.abs(p.contrast - 1) < 1e-5 && !p.shadows && !p.highlights && !p.midDetail && !p.log && !p.boost && !p.satHue && !p.curves && !p.qual;
  return neutral ? null : p;
}

// ---------------------------------------------------------------- CPU reference

export function logc3Decode(t: number): number {
  return t > 0.149658 ? (Math.pow(10, (t - 0.385537) / 0.24719) - 0.052272) / 5.555556 : (t - 0.092809) / 5.367655;
}
export function logc3Encode(x: number): number {
  return x > 0.010591 ? 0.24719 * Math.log10(5.555556 * x + 0.052272) + 0.385537 : 5.367655 * x + 0.092809;
}
export function slog3Decode(t: number): number {
  return t >= 171.2102946929 / 1023 ? Math.pow(10, (t * 1023 - 420) / 261.5) * 0.19 - 0.01 : ((t * 1023 - 95) * 0.01125) / (171.2102946929 - 95);
}
export function vlogDecode(t: number): number {
  return t < 0.181 ? (t - 0.125) / 5.6 : Math.pow(10, (t - 0.598206) / 0.241514) - 0.00873;
}
/** ARRI Wide Gamut 3 → Rec.709 (linear, D65). Row-major. */
export const AWG3_TO_709 = [1.617523, -0.537287, -0.080237, -0.070573, 1.334613, -0.26404, -0.021102, -0.226954, 1.248056];

export function toneMap(x: number): number {
  const v = Math.max(0, x) * CK.TM_GAIN;
  return (v * (1 + v / CK.TM_W2)) / (1 + v);
}

export function applyCst(c: Vec3, id: number): Vec3 {
  if (!id) return c;
  if (id === 4) return [logc3Encode(srgbToLinear(c[0])), logc3Encode(srgbToLinear(c[1])), logc3Encode(srgbToLinear(c[2]))].map(clamp01) as Vec3;
  const dec = id === 1 ? logc3Decode : id === 2 ? slog3Decode : vlogDecode;
  let l: Vec3 = [dec(c[0]), dec(c[1]), dec(c[2])];
  if (id === 1) l = applyMat(AWG3_TO_709, l);
  return [linearToSrgb(clamp01(toneMap(l[0]))), linearToSrgb(clamp01(toneMap(l[1]))), linearToSrgb(clamp01(toneMap(l[2])))];
}

/** Power S-curve contrast around the pivot (per channel; 0 and 1 stay put). */
export function contrastPivot(v: number, c: number, p: number): number {
  const x = clamp01(v);
  return x < p ? p * Math.pow(x / p, c) : 1 - (1 - p) * Math.pow((1 - x) / (1 - p), c);
}

const clampV = (c: Vec3): Vec3 => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];

function wbApply(c: Vec3, g: Vec3): Vec3 {
  return clampV([linearToSrgb(Math.max(0, srgbToLinear(c[0]) * g[0])), linearToSrgb(Math.max(0, srgbToLinear(c[1]) * g[1])), linearToSrgb(Math.max(0, srgbToLinear(c[2]) * g[2]))]);
}

export function applyHslCurvesPx(c: Vec3, t: Float32Array): Vec3 {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const cw = smoothstep(0.02, 0.15, mx - mn);
  const [h, s] = rgbToHsv(c);
  const Y = luma(c);
  const [hh, hs, hl] = sampleHueRow(t, h);
  const ls = sampleLinRow(t, 0, 3, Y);
  const ss = sampleLinRow(t, 1, 0, s);
  const rot = applyMat(hueMatrix((hh - 0.5) * 360 * cw), c);
  const sat = (1 + (2 * hs - 1) * cw) * 2 * ls * 2 * ss;
  const yl = Y * Math.pow(2, (2 * hl - 1) * cw);
  return clampV([yl + (rot[0] - Y) * sat, yl + (rot[1] - Y) * sat, yl + (rot[2] - Y) * sat]);
}

const band = (x: number, lo: number, hi: number, soft: number) => smoothstep(lo - soft - 1e-4, lo, x) * (1 - smoothstep(hi, hi + soft + 1e-4, x));

/** Qualifier matte 0..1 of the stage-input pixel `k` at clip uv. */
export function qualMatte(k: Vec3, q: QualParams, u: number, v: number, aspect: number): number {
  const [h, s] = rgbToHsv(k);
  const Y = luma(k);
  let m = 1;
  if (q.hue[0]) {
    const d = Math.abs((((h - q.hue[1] + 540) % 360) + 360) % 360 - 180);
    const mx = Math.max(k[0], k[1], k[2]);
    const mn = Math.min(k[0], k[1], k[2]);
    m *= (1 - smoothstep(q.hue[2], q.hue[2] + q.hue[3] + 1e-3, d)) * smoothstep(0.01, 0.06, mx - mn);
  }
  if (q.sat[0]) m *= band(s, q.sat[1], q.sat[2], q.sat[3]);
  if (q.lum[0]) m *= band(Y, q.lum[1], q.lum[2], q.lum[3]);
  if (q.invert) m = 1 - m;
  if (q.cleanBlack || q.cleanWhite) m = clamp01((m - q.cleanBlack) / Math.max(0.01, 1 - q.cleanBlack - q.cleanWhite));
  if (q.window) m *= maskAlpha(q.window, u, v, aspect);
  return m;
}

export function secondaryPx(c: Vec3, q: QualParams): Vec3 {
  let o = wbApply(c, q.gain);
  if (Math.abs(q.contrast - 1) > 1e-5) o = [contrastPivot(o[0], q.contrast, CK.SEC_PIVOT), contrastPivot(o[1], q.contrast, CK.SEC_PIVOT), contrastPivot(o[2], q.contrast, CK.SEC_PIVOT)];
  return clampV(applyMat(q.mat, o));
}

export interface StageEnv {
  u: number;
  v: number;
  aspect: number;
  /** Source-luma high-pass at the clarity radius (midtone detail). */
  detail: number;
}

/** The Color page on one pixel (sRGB 0..1). */
export function applyColorStage(c: Vec3, p: ColorStageParams, env: StageEnv): Vec3 {
  let o = p.cst ? applyCst(c, p.cst) : c;
  const keyIn = o;
  if (p.wb) o = wbApply(o, p.wb);
  if (Math.abs(p.contrast - 1) > 1e-5) o = [contrastPivot(o[0], p.contrast, p.pivot), contrastPivot(o[1], p.contrast, p.pivot), contrastPivot(o[2], p.contrast, p.pivot)];
  if (p.shadows || p.highlights) {
    const Y = luma(o);
    const d = CK.TONE_NORM * (CK.SHADOWS * p.shadows * Y * (1 - Y) ** 3 + CK.HIGHLIGHTS * p.highlights * Y ** 3 * (1 - Y));
    o = clampV([o[0] + d, o[1] + d, o[2] + d]);
  }
  if (p.midDetail) {
    const Y = luma(o);
    const d = CK.MID_DETAIL * p.midDetail * env.detail * 4 * Y * (1 - Y);
    o = clampV([o[0] + d, o[1] + d, o[2] + d]);
  }
  if (p.log) {
    const Y = luma(o);
    const wS = 1 - smoothstep(p.log.low - CK.LOG_SOFT, p.log.low + CK.LOG_SOFT, Y);
    const wH = smoothstep(p.log.high - CK.LOG_SOFT, p.log.high + CK.LOG_SOFT, Y);
    const wM = Math.max(0, 1 - wS - wH);
    o = clampV([0, 1, 2].map((i) => o[i]! + wS * p.log!.s[i]! + wM * p.log!.m[i]! + wH * p.log!.h[i]!) as Vec3);
  }
  if (p.boost) {
    const mx = Math.max(o[0], o[1], o[2]);
    const mn = Math.min(o[0], o[1], o[2]);
    const s = mx > 1e-6 ? (mx - mn) / mx : 0;
    const f = Math.max(0, 1 + CK.BOOST * p.boost * (1 - s));
    const Y = luma(o);
    o = clampV([Y + (o[0] - Y) * f, Y + (o[1] - Y) * f, Y + (o[2] - Y) * f]);
  }
  if (p.satHue) o = clampV(applyMat(p.satHue, o));
  if (p.curves) o = applyHslCurvesPx(o, p.curves);
  if (p.qual) {
    const m = qualMatte(keyIn, p.qual, env.u, env.v, env.aspect);
    if (p.qual.showMatte) return [m, m, m];
    if (m > 0) {
      const s = secondaryPx(o, p.qual);
      o = [o[0] + (s[0] - o[0]) * m, o[1] + (s[1] - o[1]) * m, o[2] + (s[2] - o[2]) * m];
    }
  }
  return o;
}
