/**
 * Pure geometry for the player: letterboxing, rotated boxes, hit testing and the on-canvas
 * transform gestures (move / scale / rotate with snapping). Project pixels unless noted.
 */
import type { DrawnBox } from './types';

export interface Pt {
  x: number;
  y: number;
}

/** Largest W×H box that fits in the container with `margin` px around it. */
export function letterbox(containerW: number, containerH: number, W: number, H: number, margin = 12): { width: number; height: number; k: number } {
  const k = Math.max(0, Math.min((containerW - margin * 2) / W, (containerH - margin * 2) / H));
  return { width: W * k, height: H * k, k };
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Corners of a rotated box, clockwise from top-left. */
export function boxCorners(b: Pick<DrawnBox, 'cx' | 'cy' | 'w' | 'h' | 'rotation'>): [Pt, Pt, Pt, Pt] {
  const c = Math.cos(rad(b.rotation));
  const s = Math.sin(rad(b.rotation));
  const p = (lx: number, ly: number): Pt => ({ x: b.cx + lx * c - ly * s, y: b.cy + lx * s + ly * c });
  const hw = b.w / 2;
  const hh = b.h / 2;
  return [p(-hw, -hh), p(hw, -hh), p(hw, hh), p(-hw, hh)];
}

export function pointInBox(pt: Pt, b: Pick<DrawnBox, 'cx' | 'cy' | 'w' | 'h' | 'rotation'>): boolean {
  const c = Math.cos(rad(-b.rotation));
  const s = Math.sin(rad(-b.rotation));
  const dx = pt.x - b.cx;
  const dy = pt.y - b.cy;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

/** Topmost box under the point (boxes are in draw order, bottom → top). */
export function hitTest(boxes: readonly DrawnBox[], pt: Pt): DrawnBox | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i]!;
    if (pointInBox(pt, b)) return b;
  }
  return null;
}

/** Move gesture with centre snapping. Returns the new transform x/y and which guides are active. */
export function moveWithSnap(
  start: Pt,
  delta: Pt,
  /** Snap distance in project px (e.g. 8 screen px / k). */
  threshold: number,
): { x: number; y: number; guideX: boolean; guideY: boolean } {
  let x = start.x + delta.x;
  let y = start.y + delta.y;
  const guideX = Math.abs(x) <= threshold;
  const guideY = Math.abs(y) <= threshold;
  if (guideX) x = 0;
  if (guideY) y = 0;
  return { x: Math.round(x), y: Math.round(y), guideX, guideY };
}

/** Corner drag: scale proportional to the pointer's distance from the box centre. */
export function scaleFromDrag(startScale: number, centre: Pt, from: Pt, to: Pt, min = 0.01, max = 4): number {
  const d0 = Math.hypot(from.x - centre.x, from.y - centre.y);
  const d1 = Math.hypot(to.x - centre.x, to.y - centre.y);
  if (d0 < 1e-6) return startScale;
  const s = startScale * (d1 / d0);
  return Math.min(max, Math.max(min, Math.round(s * 1000) / 1000));
}

/** Rotate handle drag. Snaps to multiples of 90° within `snapDeg`. Result in (-180, 180]. */
export function rotateFromDrag(startRotation: number, centre: Pt, from: Pt, to: Pt, snapDeg = 4): number {
  const a0 = Math.atan2(from.y - centre.y, from.x - centre.x);
  const a1 = Math.atan2(to.y - centre.y, to.x - centre.x);
  let r = startRotation + ((a1 - a0) * 180) / Math.PI;
  r = ((((r + 180) % 360) + 360) % 360) - 180;
  if (r === -180) r = 180;
  const nearest = Math.round(r / 90) * 90;
  if (Math.abs(r - nearest) <= snapDeg) r = nearest === -180 ? 180 : nearest;
  return Math.round(r * 10) / 10;
}
