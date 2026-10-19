/**
 * Video › Remove BG › Chroma key (non-AI). A pixel's distance from the key colour is measured
 * in the chroma plane (BT.601 Cb/Cr, 0..255 units), so lighting changes on the green screen
 * matter less than hue. distance ≤ threshold → transparent; then a linear ramp of `softness`
 * units back to opaque. Pure pixel maths, shared by preview and export via renderFrame.
 */
import type { ChromaKey } from '../../model/types';

export interface ChromaParams {
  cb: number;
  cr: number;
  /** Fully keyed at or below this chroma distance. */
  threshold: number;
  /** Width of the soft ramp after the threshold (≥ 1). */
  softness: number;
}

/** Intensity 100 keys everything within this chroma distance of the key (pure green ↔ grey ≈ 136). */
export const CHROMA_MAX_THRESHOLD = 110;
/** Shadow 100 adds a soft edge this wide (chroma units). */
export const CHROMA_MAX_SOFTNESS = 80;

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.replace(/./g, '$&$&') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 255, 0];
}

export const cbOf = (r: number, g: number, b: number): number => 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
export const crOf = (r: number, g: number, b: number): number => 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

export function chromaParams(k: Pick<ChromaKey, 'color' | 'intensity' | 'shadow'>): ChromaParams {
  const [r, g, b] = hexToRgb(k.color);
  return {
    cb: cbOf(r, g, b),
    cr: crOf(r, g, b),
    threshold: (Math.min(100, Math.max(0, k.intensity)) / 100) * CHROMA_MAX_THRESHOLD,
    softness: 1 + (Math.min(100, Math.max(0, k.shadow)) / 100) * CHROMA_MAX_SOFTNESS,
  };
}

/** Alpha multiplier 0..1 for one pixel. */
export function chromaAlpha(p: ChromaParams, r: number, g: number, b: number): number {
  const d = Math.hypot(cbOf(r, g, b) - p.cb, crOf(r, g, b) - p.cr);
  if (d <= p.threshold) return 0;
  return Math.min(1, (d - p.threshold) / p.softness);
}

/**
 * Keys RGBA pixels in place. Partly keyed pixels also lose the key colour's spill (their chroma is
 * pulled toward neutral by the amount removed).
 */
export function chromaKeyPixels(data: Uint8ClampedArray, p: ChromaParams): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = chromaAlpha(p, r, g, b);
    if (a >= 1) continue;
    data[i + 3] = Math.round(data[i + 3]! * a);
    if (a > 0) {
      // despill: blend toward the pixel's own luma by (1 - a)
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const k = 1 - a;
      data[i] = r + (y - r) * k;
      data[i + 1] = g + (y - g) * k;
      data[i + 2] = b + (y - b) * k;
    }
  }
}
