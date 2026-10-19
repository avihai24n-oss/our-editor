/**
 * Video › Mask (CapCut's non-AI masks: Linear, Mirror, Circle, Rectangle, Heart, Star).
 *
 * Pure geometry (unit-tested) plus one canvas routine, `applyMask`, that the compositor calls on
 * a clip's scratch layer while the clip's own transform is still set, so the mask moves, scales
 * and rotates with the picture. Preview and export share it through renderFrame.
 *
 * Local coordinates = the clip's picture box at scale 1 (project px, centred on the picture
 * centre like `mediaLocalBox`). A mask's centre / size are fractions of that box (see ClipMask).
 */
import type { ClipMask } from '../../model/types';
import type { Ctx2D } from './types';

export interface Pt {
  x: number;
  y: number;
}

/** The picture box the mask is relative to (same shape as renderFrame's LocalBox). */
export interface MaskBox {
  w: number;
  h: number;
  ox: number;
  oy: number;
}

/** A mask resolved to local px. */
export interface MaskGeom {
  shape: Exclude<ClipMask['shape'], 'none'>;
  cx: number;
  cy: number;
  /** Radians, clockwise. */
  rot: number;
  w: number;
  h: number;
  /** Width of the soft edge in local px (0 = hard). */
  feather: number;
  /** Rectangle corner radius in local px. */
  radius: number;
  invert: boolean;
}

/**
 * Feather 100 = a soft edge as wide as half the shape's shorter side (closed shapes) or half the
 * picture's shorter side (Linear / Mirror, whose size does not bound them).
 */
export const FEATHER_FRACTION = 0.5;

export function maskGeometry(mask: ClipMask, box: MaskBox): MaskGeom | null {
  if (mask.shape === 'none' || box.w <= 0 || box.h <= 0) return null;
  const w = Math.max(0, mask.width) * box.w;
  const h = Math.max(0, mask.height) * box.h;
  const open = mask.shape === 'linear' || mask.shape === 'mirror';
  const ref = open ? Math.min(box.w, box.h) : Math.min(w, h);
  const f = Math.min(100, Math.max(0, mask.feather)) / 100;
  return {
    shape: mask.shape,
    cx: box.ox + mask.x * box.w,
    cy: box.oy + mask.y * box.h,
    rot: (mask.rotation * Math.PI) / 180,
    w,
    h,
    feather: f * FEATHER_FRACTION * ref,
    radius: mask.shape === 'rectangle' ? (Math.min(100, Math.max(0, mask.roundCorners)) / 100) * (Math.min(w, h) / 2) : 0,
    invert: mask.invert,
  };
}

/** Five-point star inscribed in a w×h box, top point up, clockwise (10 vertices). */
export function starPoints(w: number, h: number, inner = 0.4): Pt[] {
  const pts: Pt[] = [];
  // the star's own bounds: x ∈ [-sin72, sin72] = ±0.951, y ∈ [-1, cos36] = [-1, 0.809]
  const sx = w / 2 / Math.sin((72 * Math.PI) / 180);
  const sy = h / (1 + Math.cos((36 * Math.PI) / 180));
  const yShift = (1 - Math.cos((36 * Math.PI) / 180)) / 2; // centre the bounds vertically
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 1 : inner;
    pts.push({ x: Math.sin(a) * r * sx, y: (-Math.cos(a) * r + yShift) * sy });
  }
  return pts;
}

/** Heart inscribed in a w×h box (classic parametric heart), point down, 72 vertices. */
export function heartPoints(w: number, h: number, n = 72): Pt[] {
  const raw: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    raw.push({ x: 16 * Math.pow(Math.sin(t), 3), y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) });
  }
  const minX = Math.min(...raw.map((p) => p.x));
  const maxX = Math.max(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const maxY = Math.max(...raw.map((p) => p.y));
  return raw.map((p) => ({ x: ((p.x - minX) / (maxX - minX) - 0.5) * w, y: ((p.y - minY) / (maxY - minY) - 0.5) * h }));
}

export function pointInPolygon(pt: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Point in the mask's own frame (centred, unrotated). */
export function toMaskFrame(g: Pick<MaskGeom, 'cx' | 'cy' | 'rot'>, p: Pt): Pt {
  const dx = p.x - g.cx;
  const dy = p.y - g.cy;
  const c = Math.cos(-g.rot);
  const s = Math.sin(-g.rot);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Inside the hard (unfeathered, non-inverted) shape? Linear keeps the side above its line. */
function insideShape(g: MaskGeom, q: Pt): boolean {
  switch (g.shape) {
    case 'linear':
      return q.y <= 0;
    case 'mirror':
      return Math.abs(q.y) <= g.h / 2;
    case 'circle': {
      if (g.w <= 0 || g.h <= 0) return false;
      const nx = q.x / (g.w / 2);
      const ny = q.y / (g.h / 2);
      return nx * nx + ny * ny <= 1;
    }
    case 'rectangle': {
      const hw = g.w / 2;
      const hh = g.h / 2;
      if (Math.abs(q.x) > hw || Math.abs(q.y) > hh) return false;
      const r = g.radius;
      const dx = Math.abs(q.x) - (hw - r);
      const dy = Math.abs(q.y) - (hh - r);
      return dx <= 0 || dy <= 0 || dx * dx + dy * dy <= r * r;
    }
    case 'heart':
      return pointInPolygon(q, heartPoints(g.w, g.h));
    case 'star':
      return pointInPolygon(q, starPoints(g.w, g.h));
  }
}

/**
 * Mask opacity (0..1) at a local point, ignoring feather on closed shapes (where the soft edge is
 * a blur). Linear / Mirror feathers are exact (linear ramps centred on the edge).
 */
export function maskAlphaAt(g: MaskGeom, p: Pt): number {
  const q = toMaskFrame(g, p);
  let a: number;
  if ((g.shape === 'linear' || g.shape === 'mirror') && g.feather > 0) {
    const d = g.shape === 'linear' ? q.y : Math.abs(q.y) - g.h / 2; // signed distance, <0 inside
    a = Math.min(1, Math.max(0, 0.5 - d / g.feather));
  } else a = insideShape(g, q) ? 1 : 0;
  return g.invert ? 1 - a : a;
}

// ---------------------------------------------------------------- canvas

/** Big enough to cover any canvas from any mask centre (local px). */
const FAR = 1e5;

function traceShape(ctx: Ctx2D, g: MaskGeom): void {
  ctx.beginPath();
  switch (g.shape) {
    case 'circle':
      ctx.ellipse(0, 0, Math.max(0.01, g.w / 2), Math.max(0.01, g.h / 2), 0, 0, Math.PI * 2);
      break;
    case 'rectangle': {
      const x = -g.w / 2;
      const y = -g.h / 2;
      const r = Math.min(g.radius, g.w / 2, g.h / 2);
      if (r > 0 && typeof (ctx as CanvasRenderingContext2D).roundRect === 'function') ctx.roundRect(x, y, g.w, g.h, r);
      else ctx.rect(x, y, g.w, g.h);
      break;
    }
    case 'heart':
    case 'star': {
      const pts = g.shape === 'heart' ? heartPoints(g.w, g.h) : starPoints(g.w, g.h);
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      break;
    }
    default:
      break;
  }
}

/**
 * Cuts the clip already drawn on `ctx` (a scratch layer holding only this clip) down to the mask.
 * The context must still carry the clip's transform (local px → canvas px). `pxPerLocal` = canvas
 * px per local px (render scale × clip scale), used to size the feather blur.
 */
export function applyMask(ctx: Ctx2D, g: MaskGeom, pxPerLocal: number): void {
  ctx.save();
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.translate(g.cx, g.cy);
  if (g.rot) ctx.rotate(g.rot);
  const on = 'rgba(0,0,0,1)';
  const off = 'rgba(0,0,0,0)';

  if (g.shape === 'linear' || g.shape === 'mirror') {
    ctx.globalCompositeOperation = 'destination-in';
    const inside = g.invert ? off : on;
    const outside = g.invert ? on : off;
    if (g.shape === 'linear') {
      const f = Math.max(g.feather, 1e-3);
      const grad = ctx.createLinearGradient(0, -f / 2, 0, f / 2);
      grad.addColorStop(0, inside);
      grad.addColorStop(1, outside);
      ctx.fillStyle = g.feather > 0 ? grad : on;
      if (g.feather > 0) ctx.fillRect(-FAR, -FAR, FAR * 2, FAR * 2);
      else if (g.invert) ctx.fillRect(-FAR, 0, FAR * 2, FAR);
      else ctx.fillRect(-FAR, -FAR, FAR * 2, FAR);
    } else {
      const f = g.feather;
      const half = g.h / 2;
      if (f > 0) {
        const span = g.h + f;
        const grad = ctx.createLinearGradient(0, -half - f / 2, 0, half + f / 2);
        const a = Math.min(0.5, f / span);
        grad.addColorStop(0, outside);
        grad.addColorStop(a, inside);
        grad.addColorStop(1 - a, inside);
        grad.addColorStop(1, outside);
        ctx.fillStyle = grad;
        ctx.fillRect(-FAR, -FAR, FAR * 2, FAR * 2);
      } else if (g.invert) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = on;
        ctx.fillRect(-FAR, -half, FAR * 2, g.h);
      } else {
        ctx.fillStyle = on;
        ctx.fillRect(-FAR, -half, FAR * 2, g.h);
      }
    }
    ctx.restore();
    return;
  }

  // closed shapes: keep the inside (destination-in) or cut it out (destination-out, invert)
  ctx.globalCompositeOperation = g.invert ? 'destination-out' : 'destination-in';
  const blurPx = (g.feather * pxPerLocal) / 4; // gaussian sigma: the ramp spans ≈ ±2σ
  if (blurPx > 0.25) ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
  ctx.fillStyle = on;
  traceShape(ctx, g);
  ctx.fill();
  ctx.restore();
}
