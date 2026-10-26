/**
 * The colour pipeline in plain TypeScript: the reference the GLSL shader (./shader.ts) mirrors
 * line by line, the CPU fallback when WebGL2 is unavailable, and what the unit tests check.
 *
 * Order (CapCut: filter look first, then the Adjust tab top to bottom):
 *   1. LUT (trilinear, intensity, optional skin protection)
 *   2. look grayscale / sepia (Filters library)
 *   3. white balance (temp / tint) and exposure — linear light
 *   4. brightness (mid-tone gamma), contrast (around 0.5)
 *   5. tone: shadows / highlights / whites / blacks / brilliance (luminance-weighted)
 *   6. HSL (8 ranges)          7. saturation
 *   8. curves (master, then R/G/B)   9. colour wheels (lift / gain / gamma / offset, Lum Mix)
 *   9b. Adjust › Color page (./colorStage.ts: CST, primaries, log wheels, HSL curves, qualifier)
 *  10. fade   11. clarity + sharpen (detail from the source)   12. vignette   13. grain
 *  14. mask: mix(original, graded, maskAlpha)
 * All values are sRGB-encoded 0..1 except stage 3.
 */
import { sampleTable } from './curves';
import { applyColorStage } from './colorStage';
import { sampleLut, type Lut3D } from './cube';
import { K, type GradeParams, type MaskParams, type Vec3 } from './params';

export const LUMA709: Vec3 = [0.2126, 0.7152, 0.0722];

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampV = (c: Vec3): Vec3 => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
export const luma = (c: Vec3) => c[0] * LUMA709[0] + c[1] * LUMA709[1] + c[2] * LUMA709[2];
const mixN = (a: number, b: number, t: number) => a + (b - a) * t;
const mixV = (a: Vec3, b: Vec3, t: number): Vec3 => [mixN(a[0], b[0], t), mixN(a[1], b[1], t), mixN(a[2], b[2], t)];
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// ---------------------------------------------------------------- HSV / HSL

export function rgbToHsv(c: Vec3): Vec3 {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === c[0]) h = ((c[1] - c[2]) / d) % 6;
    else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx > 1e-6 ? d / mx : 0, mx];
}

export function rgbToHsl(c: Vec3): Vec3 {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const h = rgbToHsv(c)[0];
  const s = d < 1e-6 ? 0 : d / (1 - Math.abs(2 * l - 1) + 1e-6);
  return [h, clamp01(s), l];
}

export function hslToRgb(h: number, s: number, l: number): Vec3 {
  const C = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((((h % 360) + 360) % 360) / 60);
  const X = C * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [C, X, 0];
  else if (hp < 2) [r, g, b] = [X, C, 0];
  else if (hp < 3) [r, g, b] = [0, C, X];
  else if (hp < 4) [r, g, b] = [0, X, C];
  else if (hp < 5) [r, g, b] = [X, 0, C];
  else [r, g, b] = [C, 0, X];
  const m = l - C / 2;
  return [r + m, g + m, b + m];
}

/** HSL range centres (degrees), in HSL_RANGES order. */
export const HSL_CENTRES = [0, 30, 60, 120, 180, 240, 270, 300];

/**
 * Weights of the 8 ranges at hue h: a tent between the two neighbouring centres, so the weights
 * always sum to 1 and a hue exactly on a centre belongs to that range only.
 */
export function hslWeights(h: number): number[] {
  const w = new Array(8).fill(0) as number[];
  const hh = ((h % 360) + 360) % 360;
  for (let i = 0; i < 8; i++) {
    const a = HSL_CENTRES[i]!;
    const b = i === 7 ? 360 : HSL_CENTRES[i + 1]!;
    if (hh >= a && hh < b) {
      const t = (hh - a) / (b - a);
      w[i] = 1 - t;
      w[(i + 1) % 8] = t;
      break;
    }
  }
  return w;
}

// ---------------------------------------------------------------- stages

/** CSS Filter Effects grayscale / sepia matrices, applied with an amount. */
export function applyLook(c: Vec3, grayscale: number, sepia: number): Vec3 {
  let o = c;
  if (grayscale > 0) {
    const a = 1 - grayscale;
    o = [
      (0.2126 + 0.7874 * a) * o[0] + (0.7152 - 0.7152 * a) * o[1] + (0.0722 - 0.0722 * a) * o[2],
      (0.2126 - 0.2126 * a) * o[0] + (0.7152 + 0.2848 * a) * o[1] + (0.0722 - 0.0722 * a) * o[2],
      (0.2126 - 0.2126 * a) * o[0] + (0.7152 - 0.7152 * a) * o[1] + (0.0722 + 0.9278 * a) * o[2],
    ];
  }
  if (sepia > 0) {
    const a = 1 - sepia;
    o = [
      (0.393 + 0.607 * a) * o[0] + (0.769 - 0.769 * a) * o[1] + (0.189 - 0.189 * a) * o[2],
      (0.349 - 0.349 * a) * o[0] + (0.686 + 0.314 * a) * o[1] + (0.168 - 0.168 * a) * o[2],
      (0.272 - 0.272 * a) * o[0] + (0.534 - 0.534 * a) * o[1] + (0.131 + 0.869 * a) * o[2],
    ];
  }
  return clampV(o);
}

/** Temp / tint as linear-light channel gains with the luminance restored, then exposure in EV. */
export function applyWhiteBalanceExposure(c: Vec3, temp: number, tint: number, exposure: number): Vec3 {
  if (!temp && !tint && !exposure) return c;
  let l: Vec3 = [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
  if (temp || tint) {
    const g: Vec3 = [1 + K.TEMP_GAIN * temp + 0.5 * K.TINT_GAIN * tint, 1 - K.TINT_GAIN * tint, 1 - K.TEMP_GAIN * temp + 0.5 * K.TINT_GAIN * tint];
    const before = luma(l);
    const w: Vec3 = [l[0] * g[0], l[1] * g[1], l[2] * g[2]];
    const after = luma(w);
    const k = after > 1e-6 ? before / after : 1;
    l = [w[0] * k, w[1] * k, w[2] * k];
  }
  if (exposure) {
    const e = Math.pow(2, exposure * K.EXPOSURE_EV);
    l = [l[0] * e, l[1] * e, l[2] * e];
  }
  return clampV([linearToSrgb(Math.max(0, l[0])), linearToSrgb(Math.max(0, l[1])), linearToSrgb(Math.max(0, l[2]))]);
}

export function applyBrightnessContrast(c: Vec3, brightness: number, contrast: number): Vec3 {
  let o = c;
  if (brightness) {
    const e = Math.pow(2, -brightness * K.BRIGHT_GAMMA);
    o = [Math.pow(o[0], e), Math.pow(o[1], e), Math.pow(o[2], e)];
  }
  if (contrast) {
    const f = 1 + contrast * K.CONTRAST;
    o = [(o[0] - 0.5) * f + 0.5, (o[1] - 0.5) * f + 0.5, (o[2] - 0.5) * f + 0.5];
  }
  return clampV(o);
}

/** Luminance-weighted tone: each slider moves the pixel's luma by a bell over its tonal range. */
export function toneDelta(Y: number, p: Pick<GradeParams, 'shadows' | 'highlights' | 'whites' | 'blacks' | 'brilliance'>): number {
  const wS = Y * (1 - Y) * (1 - Y) * 6.75; // peak 1 at Y = 1/3
  const wH = Y * Y * (1 - Y) * 6.75; // peak 1 at Y = 2/3
  return (
    K.SHADOWS * p.shadows * wS +
    K.HIGHLIGHTS * p.highlights * wH +
    K.WHITES * p.whites * Y * Y * Y +
    K.BLACKS * p.blacks * (1 - Y) * (1 - Y) * (1 - Y) +
    K.BRILLIANCE * p.brilliance * (wS - wH)
  );
}

export function applyTone(c: Vec3, p: GradeParams): Vec3 {
  if (!p.shadows && !p.highlights && !p.whites && !p.blacks && !p.brilliance) return c;
  const Y = luma(c);
  const d = toneDelta(Y, p);
  return clampV([c[0] + d, c[1] + d, c[2] + d]);
}

export function applyHsl(c: Vec3, hsl: Float32Array): Vec3 {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const chromaW = smoothstep(0.02, 0.2, mx - mn);
  if (chromaW <= 0) return c;
  const [h, s, l] = rgbToHsl(c);
  const w = hslWeights(h);
  let dh = 0;
  let ds = 0;
  let dl = 0;
  for (let i = 0; i < 8; i++) {
    dh += w[i]! * hsl[i * 3]!;
    ds += w[i]! * hsl[i * 3 + 1]!;
    dl += w[i]! * hsl[i * 3 + 2]!;
  }
  const h2 = h + dh * K.HSL_HUE_DEG * chromaW;
  const s2 = clamp01(s * Math.max(0, 1 + ds));
  const lAmt = dl * K.HSL_LIGHT * chromaW;
  const l2 = clamp01(lAmt > 0 ? l + (1 - l) * lAmt : l + l * lAmt);
  return clampV(hslToRgb(h2, s2, l2));
}

export function applySaturation(c: Vec3, s: number): Vec3 {
  if (!s) return c;
  const Y = luma(c);
  const k = 1 + s;
  return clampV([Y + (c[0] - Y) * k, Y + (c[1] - Y) * k, Y + (c[2] - Y) * k]);
}

export function applyCurves(c: Vec3, table: Uint8Array): Vec3 {
  return [sampleTable(table, 0, c[0]), sampleTable(table, 1, c[1]), sampleTable(table, 2, c[2])];
}

/** One channel through lift → gain → gamma → offset. */
const wheelCh = (v: number, lift: number, gain: number, gamma: number, offset: number) => Math.pow(Math.max((v + lift * (1 - v)) * gain, 0), gamma) + offset;

export function applyWheels(c: Vec3, w: NonNullable<GradeParams['wheels']>): Vec3 {
  const o: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) o[i] = clamp01(wheelCh(c[i]!, w.lift[i]!, w.gain[i]!, w.gamma[i]!, w.offset[i]!));
  if (!(w.lumMix > 0)) return o;
  // Lum Mix: chroma-only wheel per channel, then the master curve on the luma only
  const ch: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) ch[i] = clamp01(wheelCh(c[i]!, w.liftC[i]!, w.gainC[i]!, w.gammaC[i]!, w.offsetC[i]!));
  const Y = luma(ch);
  const d = clamp01(wheelCh(Y, w.master[0], w.master[1], w.master[2], w.master[3])) - Y;
  return [0, 1, 2].map((i) => clamp01(mixN(o[i]!, ch[i]! + d, w.lumMix))) as Vec3;
}

export function applyFade(c: Vec3, f: number): Vec3 {
  if (!f) return c;
  const k = 1 - K.FADE_COMPRESS * f;
  const b = K.FADE_LIFT * f;
  return [b + c[0] * k, b + c[1] * k, b + c[2] * k];
}

/** Elliptical vignette over the clip box: 1 in the centre, 1 − 0.85·v in the corners. */
export function vignetteFactor(u: number, v: number, amount: number): number {
  if (!amount) return 1;
  const d = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2) / Math.SQRT2;
  return 1 - amount * K.VIGNETTE * smoothstep(0.3, 1.0, d);
}

/** pcg3d integer hash → 0..1. Same bits as the GLSL version. */
export function hash3(x: number, y: number, z: number): number {
  let a = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  let b = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  let c = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  a = (a + Math.imul(b, c)) >>> 0;
  b = (b + Math.imul(c, a)) >>> 0;
  c = (c + Math.imul(a, b)) >>> 0;
  a ^= a >>> 16;
  b ^= b >>> 16;
  c ^= c >>> 16;
  a = (a + Math.imul(b, c)) >>> 0;
  return a / 4294967296;
}

export function grainNoise(u: number, v: number, aspect: number, seed: number): number {
  const gx = Math.floor(u * aspect * K.GRAIN_CELLS);
  const gy = Math.floor(v * K.GRAIN_CELLS);
  return hash3(gx, gy, seed) - 0.5;
}

/** Mask coverage 0..1 at clip-box uv (0..1, y down). `aspect` = box width / height. */
export function maskAlpha(m: MaskParams | null, u: number, v: number, aspect: number): number {
  if (!m) return 1;
  const qx = (u - 0.5 - m.cx) * aspect;
  const qy = v - 0.5 - m.cy;
  const cs = Math.cos(m.rot);
  const sn = Math.sin(m.rot);
  const x = qx * cs + qy * sn;
  const y = -qx * sn + qy * cs;
  const hw = (m.w * aspect) / 2;
  const hh = m.h / 2;
  let sd = 0;
  if (m.shape === 1) sd = y;
  else if (m.shape === 2) sd = Math.abs(y) - hh;
  else if (m.shape === 3) sd = (Math.hypot(x / hw, y / hh) - 1) * Math.min(hw, hh);
  else {
    const rr = m.roundness * Math.min(hw, hh);
    const dx = Math.abs(x) - hw + rr;
    const dy = Math.abs(y) - hh + rr;
    sd = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - rr;
  }
  const a = m.feather > 1e-4 ? 1 - smoothstep(-m.feather / 2, m.feather / 2, sd) : sd <= 0 ? 1 : 0;
  return m.invert ? 1 - a : a;
}

/** Skin-tone key (hue ≈ 25°, moderate saturation, not too dark), 0..1. */
export function skinWeight(c: Vec3): number {
  const [h, s, v] = rgbToHsv(c);
  const hh = h > 300 ? h - 360 : h;
  const hueW = 1 - smoothstep(0, 25, Math.abs(hh - 25));
  const satW = smoothstep(0.1, 0.2, s) * (1 - smoothstep(0.6, 0.75, s));
  const valW = smoothstep(0.2, 0.35, v);
  return hueW * satW * valW;
}

export function applyLut(c: Vec3, lut: Lut3D, intensity: number, protectSkin: boolean): Vec3 {
  const o = sampleLut(lut, c[0], c[1], c[2]);
  const k = intensity * (protectSkin ? 1 - K.SKIN_PROTECT * skinWeight(c) : 1);
  return clampV(mixV(c, o, k));
}

export interface PixelEnv {
  /** Clip-box uv (0..1, y down) — vignette, grain and mask. */
  u: number;
  v: number;
  aspect: number;
  lut?: Lut3D | null;
  /** Source-luma high-pass at the sharpen / clarity radius (0 when not available). */
  detailSharpen?: number;
  detailClarity?: number;
}

/** Grades one pixel. `c` is sRGB 0..1. */
export function gradePixel(c: Vec3, p: GradeParams, env: PixelEnv): Vec3 {
  const orig = c;
  let o = c;
  if (p.lut && env.lut) o = applyLut(o, env.lut, p.lut.intensity, p.lut.protectSkin);
  o = applyLook(o, p.grayscale, p.sepia);
  o = applyWhiteBalanceExposure(o, p.temp, p.tint, p.exposure);
  o = applyBrightnessContrast(o, p.brightness, p.contrast);
  o = applyTone(o, p);
  if (p.hsl) o = applyHsl(o, p.hsl);
  o = applySaturation(o, p.saturation);
  if (p.curves) o = applyCurves(o, p.curves);
  if (p.wheels) o = applyWheels(o, p.wheels);
  if (p.color) o = applyColorStage(o, p.color, { u: env.u, v: env.v, aspect: env.aspect, detail: env.detailClarity ?? 0 });
  o = applyFade(o, p.fade);
  if (p.sharpen || p.clarity) {
    const Y = luma(o);
    const d = K.SHARPEN * p.sharpen * (env.detailSharpen ?? 0) + K.CLARITY * p.clarity * (env.detailClarity ?? 0) * 4 * Y * (1 - Y);
    o = clampV([o[0] + d, o[1] + d, o[2] + d]);
  }
  if (p.vignette) {
    const f = vignetteFactor(env.u, env.v, p.vignette);
    o = [o[0] * f, o[1] * f, o[2] * f];
  }
  if (p.grain) {
    const n = grainNoise(env.u, env.v, env.aspect, p.seed) * K.GRAIN * p.grain;
    o = clampV([o[0] + n, o[1] + n, o[2] + n]);
  }
  const a = maskAlpha(p.mask, env.u, env.v, env.aspect);
  return a >= 1 ? o : mixV(orig, o, a);
}
