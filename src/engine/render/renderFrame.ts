/**
 * THE compositor. Draws one FrameState (from getFrameState) onto a 2D context. Used by the
 * player (every animation frame) and the exporter (every output frame), so they match.
 *
 * It never recomputes timing / animation / transition math: everything comes from the ops.
 * It only knows how to turn an op into pixels: transform, blend, opacity, wipe clip rect,
 * CSS colour filter + blur, tone passes (temperature/tint/fade/vignette) and text.
 */
import type { DrawOp, FrameState, MediaDrawOp, TextDrawOp } from '../frameState';
import { cssFilter, tonePasses, type TonePass } from './color';
import { fontString, layoutText, type TextLayout } from './textLayout';
import type { Ctx2D, DrawnBox, RenderOptions, SourceImage } from './types';

/** Text wraps at this fraction of the canvas width (local px, before clip scale). */
export const TEXT_WRAP_FRACTION = 0.9;

type VisualOp = MediaDrawOp | TextDrawOp;

/** Local (pre-transform) box of an op: size and centre offset. */
interface LocalBox {
  w: number;
  h: number;
  ox: number;
  oy: number;
}

export function mediaLocalBox(op: MediaDrawOp): LocalBox {
  const { left, right, top, bottom } = op.crop;
  const l = clamp01(left);
  const r = clamp01(right);
  const t = clamp01(top);
  const b = clamp01(bottom);
  const wf = Math.max(0, 1 - l - r);
  const hf = Math.max(0, 1 - t - b);
  return { w: op.fitWidth * wf, h: op.fitHeight * hf, ox: ((l - r) / 2) * op.fitWidth, oy: ((t - b) / 2) * op.fitHeight };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v || 0));

/** Box in project px after the op transform (for hit testing / selection). */
export function projectBox(op: VisualOp, local: LocalBox, W: number, H: number): DrawnBox {
  const tf = op.transform;
  const sx = tf.scale * (tf.flipH ? -1 : 1);
  const sy = tf.scale * (tf.flipV ? -1 : 1);
  const a = (tf.rotation * Math.PI) / 180;
  const lx = local.ox * sx;
  const ly = local.oy * sy;
  return {
    clipId: op.clipId,
    cx: W / 2 + tf.x + lx * Math.cos(a) - ly * Math.sin(a),
    cy: H / 2 + tf.y + lx * Math.sin(a) + ly * Math.cos(a),
    w: Math.abs(local.w * tf.scale),
    h: Math.abs(local.h * tf.scale),
    rotation: tf.rotation,
  };
}

function applyOpTransform(ctx: Ctx2D, op: VisualOp, W: number, H: number, scale: number): void {
  const tf = op.transform;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(W / 2 + tf.x, H / 2 + tf.y);
  if (tf.rotation) ctx.rotate((tf.rotation * Math.PI) / 180);
  ctx.scale(tf.scale * (tf.flipH ? -1 : 1), tf.scale * (tf.flipV ? -1 : 1));
}

function drawMedia(ctx: Ctx2D, op: MediaDrawOp, src: SourceImage, box: LocalBox): void {
  const { left, top, right, bottom } = op.crop;
  const sx = clamp01(left) * src.width;
  const sy = clamp01(top) * src.height;
  const sw = Math.max(1, src.width * (1 - clamp01(left) - clamp01(right)));
  const sh = Math.max(1, src.height * (1 - clamp01(top) - clamp01(bottom)));
  ctx.drawImage(src.image, sx, sy, sw, sh, box.ox - box.w / 2, box.oy - box.h / 2, box.w, box.h);
}

function drawMissing(ctx: Ctx2D, box: LocalBox): void {
  ctx.fillStyle = '#5a1d1d';
  ctx.fillRect(box.ox - box.w / 2, box.oy - box.h / 2, box.w, box.h);
  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.max(12, Math.round(Math.min(box.w, box.h) / 12))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Media lost', box.ox, box.oy);
}

function setLetterSpacing(ctx: Ctx2D, px: number): void {
  const c = ctx as Ctx2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`;
}

export function layoutTextOp(ctx: Ctx2D, op: TextDrawOp, W: number): TextLayout {
  ctx.font = fontString(op.style);
  setLetterSpacing(ctx, op.style.letterSpacing || 0);
  return layoutText(op.style, op.lines, (t) => ctx.measureText(t).width, W * TEXT_WRAP_FRACTION);
}

/** Draws a laid-out text block in local coordinates (block centred on 0,0). */
function drawText(ctx: Ctx2D, op: TextDrawOp, L: TextLayout, shadowScale: number): void {
  const s = op.style;
  if (s.background.enabled && s.background.opacity > 0) {
    ctx.save();
    ctx.globalAlpha *= Math.min(1, Math.max(0, s.background.opacity));
    ctx.fillStyle = s.background.color;
    const r = Math.min(L.height / 2, s.fontSize * 0.2);
    ctx.beginPath();
    if (typeof (ctx as CanvasRenderingContext2D).roundRect === 'function') ctx.roundRect(-L.width / 2, -L.height / 2, L.width, L.height, r);
    else ctx.rect(-L.width / 2, -L.height / 2, L.width, L.height);
    ctx.fill();
    ctx.restore();
  }
  ctx.font = fontString(s);
  setLetterSpacing(ctx, s.letterSpacing || 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const shadowOn = s.shadow.enabled;
  const setShadow = (on: boolean) => {
    ctx.shadowColor = on ? s.shadow.color : 'transparent';
    ctx.shadowBlur = on ? s.shadow.blur * shadowScale : 0;
    ctx.shadowOffsetX = on ? s.shadow.offsetX * shadowScale : 0;
    ctx.shadowOffsetY = on ? s.shadow.offsetY * shadowScale : 0;
  };
  const strokeOn = s.stroke.enabled && s.stroke.width > 0;
  if (strokeOn) {
    setShadow(shadowOn);
    ctx.strokeStyle = s.stroke.color;
    ctx.lineWidth = s.stroke.width * 2; // the fill covers the inner half
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    for (const l of L.lines) if (l.text) ctx.strokeText(l.text, l.x, l.y);
  }
  setShadow(shadowOn && !strokeOn);
  ctx.fillStyle = s.color;
  for (const l of L.lines) if (l.text) ctx.fillText(l.text, l.x, l.y);
  setShadow(false);
  if (s.underline) {
    const th = Math.max(1, s.fontSize / 15);
    for (const l of L.lines) if (l.width > 0) ctx.fillRect(l.x, l.y + s.fontSize * 0.45, l.width, th);
  }
}

function drawTonePasses(ctx: Ctx2D, passes: TonePass[], box: LocalBox): void {
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-atop';
  const x = box.ox - box.w / 2;
  const y = box.oy - box.h / 2;
  // fills cover generously (blur and text strokes may bleed past the box); source-atop keeps them on the clip
  const pad = Math.max(box.w, box.h);
  for (const p of passes) {
    ctx.globalAlpha = p.alpha;
    if (p.kind === 'fill') {
      ctx.fillStyle = p.color;
      ctx.fillRect(x - pad, y - pad, box.w + pad * 2, box.h + pad * 2);
    } else {
      const r = Math.hypot(box.w, box.h) / 2;
      const g = ctx.createRadialGradient(box.ox, box.oy, r * 0.35, box.ox, box.oy, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, box.w, box.h);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function resetCtx(ctx: Ctx2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
}

function clipToRect(ctx: Ctx2D, r: NonNullable<VisualOp['clipRect']>, tw: number, th: number): void {
  ctx.beginPath();
  ctx.rect(r.x * tw, r.y * th, r.w * tw, r.h * th);
  ctx.clip();
}

/**
 * Draws `fs` onto `ctx`, whose canvas is `fs.width * scale` × `fs.height * scale` pixels.
 * Returns the box of every visual op in draw order (project px), for hit testing.
 */
export function renderFrame(ctx: Ctx2D, fs: FrameState, opts: RenderOptions): DrawnBox[] {
  const { width: W, height: H } = fs;
  const k = opts.scale;
  const tw = W * k;
  const th = H * k;
  const boxes: DrawnBox[] = [];

  ctx.save();
  resetCtx(ctx);
  ctx.fillStyle = fs.background || '#000000';
  ctx.fillRect(0, 0, tw, th);

  for (const op of fs.ops as DrawOp[]) {
    if (op.kind === 'fill') {
      resetCtx(ctx);
      ctx.globalAlpha = Math.min(1, Math.max(0, op.opacity));
      ctx.fillStyle = op.color;
      ctx.fillRect(0, 0, tw, th);
      continue;
    }

    // ---- measure
    let local: LocalBox;
    let textLayout: TextLayout | null = null;
    let src: SourceImage | 'missing' | null = null;
    if (op.kind === 'media') {
      local = mediaLocalBox(op);
      src = opts.sources.get(op);
    } else {
      resetCtx(ctx);
      textLayout = layoutTextOp(ctx, op, W);
      local = { w: textLayout.width, h: textLayout.height, ox: 0, oy: 0 };
    }
    boxes.push(projectBox(op, local, W, H));

    const alpha = Math.min(1, Math.max(0, op.transform.opacity));
    if (alpha <= 0 || local.w <= 0 || local.h <= 0) continue;
    if (op.kind === 'media' && !src) continue;
    if (op.clipRect && (op.clipRect.w <= 0 || op.clipRect.h <= 0)) continue;

    const filter = cssFilter(op.color, op.blur * k);
    const passes = src === 'missing' ? [] : tonePasses(op.color);
    const layer = passes.length ? opts.layers?.get(tw, th) ?? null : null;
    const target = layer ?? ctx;

    // ---- draw the clip (directly, or onto the scratch layer)
    target.save();
    resetCtx(target);
    if (layer) layer.clearRect(0, 0, tw, th);
    else {
      if (op.clipRect) clipToRect(target, op.clipRect, tw, th);
      target.globalAlpha = alpha;
      target.globalCompositeOperation = op.composite;
    }
    target.filter = filter;
    applyOpTransform(target, op, W, H, k);
    if (op.kind === 'media') {
      if (src === 'missing') drawMissing(target, local);
      else if (src) drawMedia(target, op, src, local);
    } else if (textLayout) {
      drawText(target, op, textLayout, k * op.transform.scale);
    }
    if (layer) drawTonePasses(target, passes, local);
    target.restore();

    // ---- composite the layer
    if (layer) {
      ctx.save();
      resetCtx(ctx);
      if (op.clipRect) clipToRect(ctx, op.clipRect, tw, th);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = op.composite;
      ctx.drawImage(layer.canvas as CanvasImageSource, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
  return boxes;
}

/** Default LayerProvider: one reusable OffscreenCanvas (or <canvas>) resized on demand. */
export function createLayerProvider(): { get(width: number, height: number): Ctx2D | null } {
  let ctx: Ctx2D | null = null;
  return {
    get(width, height) {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      if (!ctx) {
        if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(w, h).getContext('2d');
        else if (typeof document !== 'undefined') {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          ctx = c.getContext('2d');
        }
        if (!ctx) return null;
      }
      if (ctx.canvas.width !== w) ctx.canvas.width = w;
      if (ctx.canvas.height !== h) ctx.canvas.height = h;
      return ctx;
    },
  };
}
