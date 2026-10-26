/**
 * Adjust › Color: the DaVinci Resolve–style colour page of a clip (`clip.grade.color`).
 *
 * The Lift / Gamma / Gain / Offset wheels themselves are the existing `grade.wheels` (one wheel
 * system, shown both in Adjust › Color wheel and in Adjust › Color › Primaries); this object holds
 * everything else of the Color page: the primaries bar (contrast + pivot, temp / tint, saturation,
 * hue, lum mix, colour boost, shadows / highlights, midtone detail), the log wheels, the HSL
 * curves, one qualifier secondary (HSL key + power window → correction) and the input colour space
 * transform. The maths is in engine/color/colorStage.ts.
 *
 * Added on 26 Oct 2026 (branch color-grade). Older projects get `migrateColorPage` (below): the
 * defaults change no pixel, and `lumMix` is 0 for them so their colour wheels keep rendering the
 * way they did (new clips use Resolve's default 100).
 */
import type { AdjustMask, Clip, CurvePoint, WheelValue } from './types';

/** Resolve's primaries bar. Every default is neutral. */
export interface PrimariesSettings {
  enabled: boolean;
  /** 0..2, 1 = neutral (Resolve 0.000..2.000). Power S-curve around `pivot`, never clips. */
  contrast: number;
  /** 0..1 (display-referred), default 0.435 like Resolve. */
  pivot: number;
  /** White balance shift in Kelvin, −4000..4000 (positive = warmer). Linear light. */
  temp: number;
  /** −100..100 (positive = magenta). Linear light. */
  tint: number;
  /** 0..100, 50 = neutral (Resolve). */
  saturation: number;
  /** 0..100, 50 = neutral; 0 / 100 = ∓180° hue rotation. */
  hue: number;
  /**
   * 0..100: how the master (luminance) sliders of the Lift / Gamma / Gain / Offset wheels act.
   * 100 = Y-only (luminance changes, saturation kept); 0 = applied to R, G and B alike.
   */
  lumMix: number;
  /** −100..100: vibrance (boosts low-saturation colours more than saturated ones). */
  colorBoost: number;
  /** −100..100: lifts / lowers the darker tones. */
  shadows: number;
  /** −100..100: raises / recovers the brighter tones. */
  highlights: number;
  /** −100..100: midtone local contrast (negative softens). */
  midDetail: number;
}

/** Log wheels: offsets limited to a tonal range (shadow < low ≤ midtone ≤ high < highlight). */
export interface LogWheelsSettings {
  enabled: boolean;
  shadow: WheelValue;
  midtone: WheelValue;
  highlight: WheelValue;
  /** 0..1, default 0.333 (Resolve "Low Range"). */
  low: number;
  /** 0..1, default 0.55 (Resolve "High Range"). */
  high: number;
}

export type HslCurveId = 'hueHue' | 'hueSat' | 'hueLum' | 'lumSat' | 'satSat';

/**
 * Resolve's HSL curves. Points: x = input (hue 0..1 = 0..360°, or luma / saturation 0..1),
 * y = 0.5 is neutral. Hue curves wrap around. An empty list is the flat (neutral) curve.
 *  - Hue vs Hue: y 0..1 = −180°..+180° hue shift.
 *  - Hue vs Sat, Lum vs Sat, Sat vs Sat: saturation × 2y (0 = grey, 1 = double).
 *  - Hue vs Lum: luminance × 2^(2y − 1).
 */
export interface HslCurvesSettings {
  enabled: boolean;
  hueHue: CurvePoint[];
  hueSat: CurvePoint[];
  hueLum: CurvePoint[];
  lumSat: CurvePoint[];
  satSat: CurvePoint[];
}

/** One qualifier range (sat / lum): 0..100, soft = edge width. */
export interface QualRange {
  on: boolean;
  low: number;
  high: number;
  soft: number;
}

/** The correction applied inside the qualifier matte. Every default is neutral. */
export interface SecondaryCorrection {
  /** EV, −3..3. */
  exposure: number;
  /** 0..2, 1 neutral, pivot 0.435. */
  contrast: number;
  /** 0..200 %, 100 neutral. */
  saturation: number;
  /** Degrees −180..180. */
  hue: number;
  /** Kelvin shift −4000..4000. */
  temp: number;
  /** −100..100. */
  tint: number;
}

/** Qualifier secondary: HSL key ∩ power window → correction (Resolve's 2nd node in one panel). */
export interface QualifierSettings {
  enabled: boolean;
  hue: { on: boolean; center: number; width: number; soft: number };
  sat: QualRange;
  lum: QualRange;
  invert: boolean;
  /** Matte finesse: clip the matte's low / high end (0..50). */
  cleanBlack: number;
  cleanWhite: number;
  /** Shows the matte (white = selected) instead of the picture, for this clip. */
  showMatte: boolean;
  /** Power window for the secondary (same shapes and units as Adjust › Mask). */
  window: AdjustMask;
  correction: SecondaryCorrection;
}

export type CstInput = 'none' | 'arri-logc3' | 'sony-slog3' | 'pana-vlog' | 'rec709-to-log';

/** Colour space transform, the first operation of the Color page. */
export interface CstSettings {
  input: CstInput;
}

export interface ColorPage {
  /** Bypass for the whole Color page (the wheels in `grade.wheels` have their own checkbox). */
  enabled: boolean;
  primaries: PrimariesSettings;
  logWheels: LogWheelsSettings;
  hslCurves: HslCurvesSettings;
  qualifier: QualifierSettings;
  cst: CstSettings;
}

// ---------------------------------------------------------------- defaults

export const PIVOT_DEFAULT = 0.435;

export const defaultPrimaries = (): PrimariesSettings => ({
  enabled: true,
  contrast: 1,
  pivot: PIVOT_DEFAULT,
  temp: 0,
  tint: 0,
  saturation: 50,
  hue: 50,
  lumMix: 100,
  colorBoost: 0,
  shadows: 0,
  highlights: 0,
  midDetail: 0,
});

const wheel0 = (): WheelValue => ({ x: 0, y: 0, luma: 0 });

export const defaultLogWheels = (): LogWheelsSettings => ({
  enabled: true,
  shadow: wheel0(),
  midtone: wheel0(),
  highlight: wheel0(),
  low: 0.333,
  high: 0.55,
});

export const defaultHslCurves = (): HslCurvesSettings => ({ enabled: true, hueHue: [], hueSat: [], hueLum: [], lumSat: [], satSat: [] });

export const defaultQualifierWindow = (): AdjustMask => ({
  shape: 'none',
  x: 0,
  y: 0,
  width: 0.5,
  height: 0.5,
  rotation: 0,
  feather: 30,
  roundness: 0,
  invert: false,
});

export const defaultCorrection = (): SecondaryCorrection => ({ exposure: 0, contrast: 1, saturation: 100, hue: 0, temp: 0, tint: 0 });

export const defaultQualifier = (): QualifierSettings => ({
  enabled: false,
  hue: { on: true, center: 25, width: 40, soft: 20 },
  sat: { on: true, low: 10, high: 100, soft: 10 },
  lum: { on: true, low: 0, high: 100, soft: 10 },
  invert: false,
  cleanBlack: 0,
  cleanWhite: 0,
  showMatte: false,
  window: defaultQualifierWindow(),
  correction: defaultCorrection(),
});

export const defaultColorPage = (): ColorPage => ({
  enabled: true,
  primaries: defaultPrimaries(),
  logWheels: defaultLogWheels(),
  hslCurves: defaultHslCurves(),
  qualifier: defaultQualifier(),
  cst: { input: 'none' },
});

// ---------------------------------------------------------------- migration / normalisation

const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function wheel(v: unknown): WheelValue {
  const o = obj(v);
  return { x: num(o.x, 0, -1, 1), y: num(o.y, 0, -1, 1), luma: num(o.luma, 0, -100, 100) };
}

function points(v: unknown): CurvePoint[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p) => p && typeof p === 'object' && Number.isFinite((p as CurvePoint).x) && Number.isFinite((p as CurvePoint).y))
    .map((p) => ({ x: num((p as CurvePoint).x, 0, 0, 1), y: num((p as CurvePoint).y, 0.5, 0, 1) }))
    .sort((a, b) => a.x - b.x);
}

function range(v: unknown, d: QualRange): QualRange {
  const o = obj(v);
  return { on: bool(o.on, d.on), low: num(o.low, d.low, 0, 100), high: num(o.high, d.high, 0, 100), soft: num(o.soft, d.soft, 0, 100) };
}

const CST_INPUTS: readonly CstInput[] = ['none', 'arri-logc3', 'sony-slog3', 'pana-vlog', 'rec709-to-log'];
const MASK_SHAPES = ['none', 'linear', 'mirror', 'circle', 'rectangle'];

/**
 * A complete, valid ColorPage from anything (missing / malformed fields get their defaults).
 * `legacyLumMix`: the value used when lumMix is missing (0 for documents saved before the Color
 * page existed, so their wheels render as before).
 */
export function normalizeColorPage(raw: unknown, legacyLumMix = 100): ColorPage {
  const d = defaultColorPage();
  const r = obj(raw);
  const p = obj(r.primaries);
  const lw = obj(r.logWheels);
  const hc = obj(r.hslCurves);
  const q = obj(r.qualifier);
  const qh = obj(q.hue);
  const qw = obj(q.window);
  const qc = obj(q.correction);
  const dp = d.primaries;
  const dq = d.qualifier;
  return {
    enabled: bool(r.enabled, true),
    primaries: {
      enabled: bool(p.enabled, true),
      contrast: num(p.contrast, dp.contrast, 0, 2),
      pivot: num(p.pivot, dp.pivot, 0, 1),
      temp: num(p.temp, 0, -4000, 4000),
      tint: num(p.tint, 0, -100, 100),
      saturation: num(p.saturation, 50, 0, 100),
      hue: num(p.hue, 50, 0, 100),
      lumMix: num(p.lumMix, legacyLumMix, 0, 100),
      colorBoost: num(p.colorBoost, 0, -100, 100),
      shadows: num(p.shadows, 0, -100, 100),
      highlights: num(p.highlights, 0, -100, 100),
      midDetail: num(p.midDetail, 0, -100, 100),
    },
    logWheels: {
      enabled: bool(lw.enabled, true),
      shadow: wheel(lw.shadow),
      midtone: wheel(lw.midtone),
      highlight: wheel(lw.highlight),
      low: num(lw.low, d.logWheels.low, 0, 1),
      high: num(lw.high, d.logWheels.high, 0, 1),
    },
    hslCurves: {
      enabled: bool(hc.enabled, true),
      hueHue: points(hc.hueHue),
      hueSat: points(hc.hueSat),
      hueLum: points(hc.hueLum),
      lumSat: points(hc.lumSat),
      satSat: points(hc.satSat),
    },
    qualifier: {
      enabled: bool(q.enabled, false),
      hue: { on: bool(qh.on, true), center: num(qh.center, dq.hue.center, 0, 360), width: num(qh.width, dq.hue.width, 0, 360), soft: num(qh.soft, dq.hue.soft, 0, 180) },
      sat: range(q.sat, dq.sat),
      lum: range(q.lum, dq.lum),
      invert: bool(q.invert, false),
      cleanBlack: num(q.cleanBlack, 0, 0, 50),
      cleanWhite: num(q.cleanWhite, 0, 0, 50),
      showMatte: bool(q.showMatte, false),
      window: {
        ...dq.window,
        shape: (MASK_SHAPES.includes(qw.shape as string) ? qw.shape : 'none') as AdjustMask['shape'],
        x: num(qw.x, 0, -2, 2),
        y: num(qw.y, 0, -2, 2),
        width: num(qw.width, dq.window.width, 0.001, 4),
        height: num(qw.height, dq.window.height, 0.001, 4),
        rotation: num(qw.rotation, 0, -360, 360),
        feather: num(qw.feather, dq.window.feather, 0, 100),
        roundness: num(qw.roundness, 0, 0, 100),
        invert: bool(qw.invert, false),
      },
      correction: {
        exposure: num(qc.exposure, 0, -3, 3),
        contrast: num(qc.contrast, 1, 0, 2),
        saturation: num(qc.saturation, 100, 0, 200),
        hue: num(qc.hue, 0, -180, 180),
        temp: num(qc.temp, 0, -4000, 4000),
        tint: num(qc.tint, 0, -100, 100),
      },
    },
    cst: { input: CST_INPUTS.includes(obj(r.cst).input as CstInput) ? (obj(r.cst).input as CstInput) : 'none' },
  };
}

/** Structural check: true when `v` already has every ColorPage field (so migration keeps the object). */
function isComplete(v: unknown): boolean {
  const r = obj(v);
  const q = obj(r.qualifier);
  return (
    typeof r.enabled === 'boolean' &&
    typeof obj(r.primaries).lumMix === 'number' &&
    typeof obj(r.primaries).midDetail === 'number' &&
    typeof obj(r.logWheels).high === 'number' &&
    Array.isArray(obj(r.hslCurves).satSat) &&
    typeof q.showMatte === 'boolean' &&
    typeof obj(q.window).shape === 'string' &&
    typeof obj(q.correction).tint === 'number' &&
    typeof obj(r.cst).input === 'string'
  );
}

/**
 * color-grade: fills `grade.color` on visual clips. Runs before migrateGrade, so a clip saved
 * before the Color page gets lumMix 0 (its wheels keep their old look); a partial ColorPage is
 * completed. Returns the same object when nothing is missing.
 */
export function migrateColorPage(c: Clip): Clip {
  if (c.type === 'audio') return c;
  const g = (c as unknown as { grade?: Record<string, unknown> }).grade;
  if (!g || typeof g !== 'object') return c; // migrateGrade builds the whole grade (with defaults)
  if (isComplete(g.color)) return c;
  const color = normalizeColorPage(g.color, g.color === undefined ? 0 : 100);
  return { ...c, grade: { ...g, color } } as Clip;
}
