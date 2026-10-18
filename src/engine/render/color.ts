/**
 * ColorOps (Adjust + filter, CapCut slider units) → canvas operations. Pure.
 *
 * Two kinds of output:
 * 1. `cssFilter()` — a CSS filter string for `ctx.filter` (brightness, contrast, saturation,
 *    grayscale, sepia, blur). GPU-accelerated in Chrome on both canvas kinds.
 * 2. `tonePasses()` — fills drawn with `source-atop` over the clip's own pixels (on a scratch
 *    layer, so they never touch other layers): temperature, tint, fade (matte) and vignette.
 *
 * Highlights / Shadows / Sharpen are approximations in v1 (no per-pixel tone curve or
 * convolution); a WebGL colour pass is on the v2 backlog.
 */
import type { ColorOps } from '../frameState';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Combined brightness / contrast / saturation factors (1 = neutral). Exported for tests. */
export function colorFactors(c: ColorOps): { brightness: number; contrast: number; saturate: number } {
  const exposure = Math.pow(2, clamp(c.exposure, -50, 50) / 50); // −50 → ½ stop… +50 → ×2
  const brightness = 1 + clamp(c.brightness, -50, 50) / 100; // 0.5 … 1.5
  const highlights = 1 + clamp(c.highlights, -50, 50) / 500; // ±10 %
  const shadows = 1 + clamp(c.shadows, -50, 50) / 400; // ±12.5 %
  const contrast =
    (1 + clamp(c.contrast, -50, 50) / 100) * // 0.5 … 1.5
    (1 + clamp(c.highlights, -50, 50) / 400) *
    (1 - clamp(c.shadows, -50, 50) / 400) *
    (1 + clamp(c.sharpen, 0, 100) / 1000); // sharpen stand-in: a touch of contrast
  const saturate = 1 + clamp(c.saturation, -50, 50) / 50; // 0 … 2
  return { brightness: exposure * brightness * highlights * shadows, contrast, saturate };
}

/** CSS filter for ctx.filter. `blurPx` is in TARGET pixels. Returns 'none' when neutral. */
export function cssFilter(c: ColorOps, blurPx: number): string {
  const f = colorFactors(c);
  const parts: string[] = [];
  if (Math.abs(f.brightness - 1) > 1e-3) parts.push(`brightness(${round(f.brightness)})`);
  if (Math.abs(f.contrast - 1) > 1e-3) parts.push(`contrast(${round(f.contrast)})`);
  if (Math.abs(f.saturate - 1) > 1e-3) parts.push(`saturate(${round(f.saturate)})`);
  if (c.grayscale > 1e-3) parts.push(`grayscale(${round(clamp(c.grayscale, 0, 1))})`);
  if (c.sepia > 1e-3) parts.push(`sepia(${round(clamp(c.sepia, 0, 1))})`);
  if (blurPx > 0.05) parts.push(`blur(${round(blurPx)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

export type TonePass =
  | { kind: 'fill'; color: string; alpha: number }
  | { kind: 'vignette'; alpha: number };

/** Colour passes drawn with `source-atop` on the clip's layer, in order. Empty = none needed. */
export function tonePasses(c: ColorOps): TonePass[] {
  const out: TonePass[] = [];
  const temp = clamp(c.temperature, -50, 50);
  if (Math.abs(temp) > 0.5) {
    out.push({ kind: 'fill', color: temp > 0 ? '#ff9628' : '#2878ff', alpha: round((Math.abs(temp) / 50) * 0.22) });
  }
  const tint = clamp(c.tint, -50, 50);
  if (Math.abs(tint) > 0.5) {
    out.push({ kind: 'fill', color: tint > 0 ? '#ff28c8' : '#28dc5a', alpha: round((Math.abs(tint) / 50) * 0.15) });
  }
  const fade = clamp(c.fade, 0, 100);
  if (fade > 0.5) out.push({ kind: 'fill', color: '#808080', alpha: round((fade / 100) * 0.4) });
  const vig = clamp(c.vignette, 0, 100);
  if (vig > 0.5) out.push({ kind: 'vignette', alpha: round((vig / 100) * 0.85) });
  return out;
}
