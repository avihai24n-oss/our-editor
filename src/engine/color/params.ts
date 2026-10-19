/**
 * ColorOps (model units: CapCut slider values) → GradeParams (normalised numbers the shader and
 * the CPU path consume). Pure. `gradeParams()` returns null when the result would be the identity,
 * so neutral clips skip the colour pass entirely.
 *
 * Every tuning constant lives in K and is pasted into the GLSL source, so the GPU and the CPU
 * reference (./math.ts) can never drift apart.
 */
import { HSL_RANGES } from '../../model/catalog';
import type { AdjustMaskShape, ColorGrade, WheelValue } from '../../model/types';
import type { ColorOps } from '../frameState';
import { bakeCurvesTable, curvesAreIdentity } from './curves';

export const K = {
  /** Exposure ±50 → ±1.5 EV in linear light. */
  EXPOSURE_EV: 1.5,
  /** White balance channel gains in linear light (then luminance is restored). */
  TEMP_GAIN: 0.3,
  TINT_GAIN: 0.2,
  /** Brightness ±50 → mid-tone gamma exponent 2^(∓0.6). */
  BRIGHT_GAMMA: 0.6,
  /** Contrast ±50 → slope 1 ± 0.5 around mid grey 0.5. */
  CONTRAST: 0.5,
  SHADOWS: 0.35,
  HIGHLIGHTS: 0.35,
  WHITES: 0.3,
  BLACKS: 0.3,
  BRILLIANCE: 0.25,
  /** HSL hue ±100 → ±30°. */
  HSL_HUE_DEG: 30,
  HSL_LIGHT: 0.5,
  FADE_LIFT: 0.2,
  FADE_COMPRESS: 0.3,
  SHARPEN: 1.5,
  CLARITY: 0.8,
  /** Kernel radii as a fraction of the clip height (resolution independent: 1/1080 = 1 px at 1080p). */
  SHARPEN_RADIUS: 1.5 / 1080,
  CLARITY_RADIUS: 12 / 1080,
  VIGNETTE: 0.85,
  GRAIN: 0.12,
  /** Grain cells per clip height. */
  GRAIN_CELLS: 720,
  WHEEL_LIFT: 0.3,
  WHEEL_LIFT_LUMA: 0.25,
  WHEEL_GAIN: 0.6,
  WHEEL_GAIN_LUMA: 0.5,
  WHEEL_GAMMA: 0.8,
  WHEEL_GAMMA_LUMA: 0.8,
  WHEEL_OFFSET: 0.2,
  WHEEL_OFFSET_LUMA: 0.2,
  /** Skin protection keeps this much of the original on a full skin match. */
  SKIN_PROTECT: 0.85,
} as const;

export type Vec3 = [number, number, number];

export interface MaskParams {
  /** 1 linear, 2 mirror, 3 circle, 4 rectangle. */
  shape: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Radians, clockwise on screen. */
  rot: number;
  /** Feather width in clip-height units. */
  feather: number;
  roundness: number;
  invert: boolean;
}

export interface WheelParams {
  lift: Vec3;
  gain: Vec3;
  /** Per-channel exponent. */
  gamma: Vec3;
  offset: Vec3;
}

export interface GradeParams {
  lut: { id: string; intensity: number; protectSkin: boolean } | null;
  grayscale: number;
  sepia: number;
  /** -1..1 */
  temp: number;
  tint: number;
  exposure: number;
  brightness: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  brilliance: number;
  saturation: number;
  /** 0..1 */
  sharpen: number;
  clarity: number;
  grain: number;
  fade: number;
  vignette: number;
  /** 8 bands × (hue, saturation, lightness), each -1..1, in HSL_RANGES order; null = neutral. */
  hsl: Float32Array | null;
  /** RGBA8 256-entry table (see bakeCurvesTable); null = identity. */
  curves: Uint8Array | null;
  /** Cache key of the curves table. */
  curvesKey: string;
  wheels: WheelParams | null;
  mask: MaskParams | null;
  /** Grain seed (changes per frame; the same frame gets the same grain in preview and export). */
  seed: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const bi = (v: number) => clamp((v || 0) / 50, -1, 1);
const uni = (v: number) => clamp((v || 0) / 100, 0, 1);

const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

/** Pure hue (degrees) at full saturation, sRGB 0..1. */
export function hueRgb(deg: number): Vec3 {
  const h = (((deg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

/**
 * Colour direction of a wheel puck: the pure hue at the puck angle minus its own luminance
 * (a zero-luma chroma vector), scaled by the puck distance. Angle 0 = right (red), counter-clockwise.
 */
export function wheelChroma(w: Pick<WheelValue, 'x' | 'y'>): Vec3 {
  const r = Math.min(1, Math.hypot(w.x, w.y));
  if (r < 1e-6) return [0, 0, 0];
  const deg = (Math.atan2(w.y, w.x) * 180) / Math.PI;
  const c = hueRgb(deg);
  const y = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
  return [(c[0] - y) * r, (c[1] - y) * r, (c[2] - y) * r];
}

const wheelIsNeutral = (w: WheelValue) => Math.hypot(w.x, w.y) < 1e-4 && Math.abs(w.luma) < 1e-3;

export function wheelParams(g: ColorGrade['wheels']): WheelParams | null {
  if (!g.enabled || (wheelIsNeutral(g.lift) && wheelIsNeutral(g.gamma) && wheelIsNeutral(g.gain) && wheelIsNeutral(g.offset))) return null;
  const map = (w: WheelValue, kc: number, kl: number): Vec3 => {
    const v = wheelChroma(w);
    const l = clamp(w.luma / 100, -1, 1) * kl;
    return [v[0] * kc + l, v[1] * kc + l, v[2] * kc + l];
  };
  const lift = map(g.lift, K.WHEEL_LIFT, K.WHEEL_LIFT_LUMA);
  const gain = map(g.gain, K.WHEEL_GAIN, K.WHEEL_GAIN_LUMA).map((v) => 1 + v) as Vec3;
  const gamma = map(g.gamma, K.WHEEL_GAMMA, K.WHEEL_GAMMA_LUMA).map((v) => Math.pow(2, -v)) as Vec3;
  const offset = map(g.offset, K.WHEEL_OFFSET, K.WHEEL_OFFSET_LUMA);
  return { lift, gain, gamma, offset };
}

const SHAPES: Record<AdjustMaskShape, number> = { none: 0, linear: 1, mirror: 2, circle: 3, rectangle: 4 };

export function maskParams(m: ColorGrade['mask']): MaskParams | null {
  const shape = SHAPES[m.shape] ?? 0;
  if (!shape) return null;
  return {
    shape,
    cx: clamp(m.x, -2, 2),
    cy: clamp(m.y, -2, 2),
    w: clamp(m.width, 0.001, 4),
    h: clamp(m.height, 0.001, 4),
    rot: (m.rotation * Math.PI) / 180,
    feather: (clamp(m.feather, 0, 100) / 100) * 0.5,
    roundness: clamp(m.roundness, 0, 100) / 100,
    invert: !!m.invert,
  };
}

export function hslParams(h: ColorGrade['hsl']): Float32Array | null {
  if (!h.enabled) return null;
  const out = new Float32Array(24);
  let any = false;
  HSL_RANGES.forEach((r, i) => {
    const b = h.bands[r.id];
    if (!b) return;
    out[i * 3] = clamp(b.hue / 100, -1, 1);
    out[i * 3 + 1] = clamp(b.saturation / 100, -1, 1);
    out[i * 3 + 2] = clamp(b.lightness / 100, -1, 1);
    if (b.hue || b.saturation || b.lightness) any = true;
  });
  return any ? out : null;
}

/** Curves table cache: the same settings object/content reuse one baked table. */
const curveCache = new Map<string, Uint8Array>();

/**
 * Builds the shader parameters for one op. `lutAvailable(id)` says whether the LUT is loaded
 * (a LUT that is not in this browser is skipped, like CapCut's "LUT missing").
 */
export function gradeParams(c: ColorOps, seed = 0, lutAvailable: (id: string) => boolean = () => true): GradeParams | null {
  const g = c.grade;
  const lut =
    g && g.lut.enabled && g.lut.lutId && g.lut.intensity > 0 && lutAvailable(g.lut.lutId)
      ? { id: g.lut.lutId, intensity: clamp(g.lut.intensity, 0, 1), protectSkin: !!g.lut.protectSkin }
      : null;
  let curves: Uint8Array | null = null;
  let curvesKey = '';
  if (g && g.curves.enabled && !curvesAreIdentity(g.curves)) {
    curvesKey = JSON.stringify([g.curves.master, g.curves.red, g.curves.green, g.curves.blue]);
    curves = curveCache.get(curvesKey) ?? null;
    if (!curves) {
      curves = bakeCurvesTable(g.curves);
      if (curveCache.size > 64) curveCache.clear();
      curveCache.set(curvesKey, curves);
    }
  }
  const p: GradeParams = {
    lut,
    grayscale: clamp(c.grayscale || 0, 0, 1),
    sepia: clamp(c.sepia || 0, 0, 1),
    temp: bi(c.temperature),
    tint: bi(c.tint),
    exposure: bi(c.exposure),
    brightness: bi(c.brightness),
    contrast: bi(c.contrast),
    highlights: bi(c.highlights),
    shadows: bi(c.shadows),
    whites: bi(c.whites),
    blacks: bi(c.blacks),
    brilliance: bi(c.brilliance),
    saturation: bi(c.saturation),
    sharpen: uni(c.sharpen),
    clarity: uni(c.clarity),
    grain: uni(c.grain),
    fade: uni(c.fade),
    vignette: uni(c.vignette),
    hsl: g ? hslParams(g.hsl) : null,
    curves,
    curvesKey,
    wheels: g ? wheelParams(g.wheels) : null,
    mask: g ? maskParams(g.mask) : null,
    seed: seed >>> 0,
  };
  return isNeutralParams(p) ? null : p;
}

const SCALARS = [
  'grayscale',
  'sepia',
  'temp',
  'tint',
  'exposure',
  'brightness',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'brilliance',
  'saturation',
  'sharpen',
  'clarity',
  'grain',
  'fade',
  'vignette',
] as const;

/** True when the params change no pixel (a mask alone changes nothing). */
export function isNeutralParams(p: GradeParams): boolean {
  return !p.lut && !p.hsl && !p.curves && !p.wheels && SCALARS.every((k) => Math.abs(p[k]) < 1e-4);
}

/** True when the pass needs neighbour samples (sharpen / clarity). */
export const needsNeighbours = (p: GradeParams): boolean => p.sharpen > 0 || p.clarity > 0;
