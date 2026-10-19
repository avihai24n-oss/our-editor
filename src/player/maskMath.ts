/**
 * Pure maths for the on-canvas mask handles (Video › Mask open + a masked clip selected).
 * Converts between the mask's model values (fractions of the clip's picture, see ClipMask) and
 * project px on the canvas, given where the compositor drew the clip (its DrawnBox) and its flips.
 */
import type { ClipMask } from '../model/types';

export interface Pt {
  x: number;
  y: number;
}

/** Where the clip's picture is on the canvas (DrawnBox + mirror flags). */
export interface ClipFrame {
  cx: number;
  cy: number;
  /** Picture size on the canvas (after scale). */
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

/** The mask's box on the canvas: centre, size and rotation (degrees). */
export interface MaskFrame {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

const rad = (d: number) => (d * Math.PI) / 180;
const rot = (p: Pt, deg: number): Pt => {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
};
const sgn = (flip: boolean) => (flip ? -1 : 1);

export function maskScreenFrame(m: ClipMask, f: ClipFrame): MaskFrame {
  const local = { x: m.x * f.w * sgn(f.flipH), y: m.y * f.h * sgn(f.flipV) };
  const off = rot(local, f.rotation);
  const mirrored = f.flipH !== f.flipV;
  return { cx: f.cx + off.x, cy: f.cy + off.y, w: m.width * f.w, h: m.height * f.h, rotation: f.rotation + (mirrored ? -m.rotation : m.rotation) };
}

/** Mask x / y (fractions) that put the mask centre at canvas point `pt`. */
export function maskPositionAt(f: ClipFrame, pt: Pt): { x: number; y: number } {
  const q = rot({ x: pt.x - f.cx, y: pt.y - f.cy }, -f.rotation);
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x: f.w ? r((q.x / f.w) * sgn(f.flipH)) : 0, y: f.h ? r((q.y / f.h) * sgn(f.flipV)) : 0 };
}

/** Mask width / height (fractions) whose corner sits at canvas point `pt` (centre stays). */
export function maskSizeAt(m: ClipMask, f: ClipFrame, pt: Pt): { width: number; height: number } {
  const mf = maskScreenFrame(m, f);
  const q = rot({ x: pt.x - mf.cx, y: pt.y - mf.cy }, -mf.rotation);
  const r = (v: number) => Math.max(0.01, Math.round(v * 10000) / 10000);
  return { width: f.w ? r((2 * Math.abs(q.x)) / f.w) : m.width, height: f.h ? r((2 * Math.abs(q.y)) / f.h) : m.height };
}

/** Mask rotation after dragging its rotate handle from `from` to `to` around the mask centre. */
export function maskRotationFromDrag(startRotation: number, f: ClipFrame, centre: Pt, from: Pt, to: Pt): number {
  const a0 = Math.atan2(from.y - centre.y, from.x - centre.x);
  const a1 = Math.atan2(to.y - centre.y, to.x - centre.x);
  const d = ((a1 - a0) * 180) / Math.PI;
  let r = startRotation + (f.flipH !== f.flipV ? -d : d);
  r = ((((r + 180) % 360) + 360) % 360) - 180;
  return Math.round(r * 10) / 10;
}

/** Feather after dragging its handle by `dist` canvas px away from the shape (`ref` px = 100). */
export function featherFromDrag(start: number, dist: number, ref: number): number {
  if (ref <= 0) return start;
  return Math.max(0, Math.min(100, Math.round(start + (dist / ref) * 100)));
}
