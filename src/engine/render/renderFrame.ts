/**
 * THE compositor. Draws one FrameState (from getFrameState) onto a 2D context. Used by the
 * player (every animation frame) and the exporter (every output frame), so they match.
 *
 * It never recomputes timing / animation / transition math: everything comes from the ops.
 * It only knows how to turn an op into pixels: transform, blend, opacity, wipe clip rect,
 * the colour pass, blur and text.
 *
 * Colour: with `opts.grader` (WebGL2, or the CPU fallback) every non-neutral clip goes through
 * the shared colour pipeline (engine/color): media are graded in source space (cropped, at the
 * size they are drawn) and then drawn with their transform; text is drawn on the scratch layer
 * and the layer is graded. Without a grader (unit tests) the legacy approximation is used:
 * CSS filter + tone passes.
 */
import { noise, type MaskShape } from '../animations';
import { gradeParams, type GradeParams } from '../color/params';
import { requestLut } from '../color/lutLibrary';
import type { AnimFx, DrawOp, FrameState, MediaDrawOp, TextDrawOp } from '../frameState';
import { chromaKeyPixels, chromaParams } from './chroma';
import { cssFilter, tonePasses, type TonePass } from './color';
import { applyMask, maskGeometry } from './mask';
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
/** Per-axis scale of an op (ops built before Uniform scale existed only carry `scale`). */
export const axisScale = (tf: VisualOp['transform']): { x: number; y: number } => ({ x: tf.scaleX ?? tf.scale, y: tf.scaleY ?? tf.scale });

export function projectBox(op: VisualOp, local: LocalBox, W: number, H: number): DrawnBox {
  const tf = op.transform;
  const ax = axisScale(tf);
  const sx = ax.x * (tf.flipH ? -1 : 1);
  const sy = ax.y * (tf.flipV ? -1 : 1);
  const a = (tf.rotation * Math.PI) / 180;
  const lx = local.ox * sx;
  const ly = local.oy * sy;
  return {
    clipId: op.clipId,
    cx: W / 2 + tf.x + lx * Math.cos(a) - ly * Math.sin(a),
    cy: H / 2 + tf.y + lx * Math.sin(a) + ly * Math.cos(a),
    w: Math.abs(local.w * ax.x),
    h: Math.abs(local.h * ax.y),
    rotation: tf.rotation,
  };
}

function applyOpTransform(ctx: Ctx2D, op: VisualOp, W: number, H: number, scale: number, box: LocalBox): void {
  const tf = op.transform;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(W / 2 + tf.x, H / 2 + tf.y);
  if (tf.rotation) ctx.rotate((tf.rotation * Math.PI) / 180);
  const ax = axisScale(tf);
  ctx.scale(ax.x * (tf.flipH ? -1 : 1), ax.y * (tf.flipV ? -1 : 1));
  const fx = op.fx;
  if (fx && (fx.sx !== 1 || fx.sy !== 1 || fx.skewX || fx.skewY)) {
    // animation: non-uniform scale + skew around a pivot of the clip box (3D-style flips, jelly…)
    const px = box.ox + fx.pivotX * box.w;
    const py = box.oy + fx.pivotY * box.h;
    const rad = Math.PI / 180;
    ctx.translate(px, py);
    ctx.transform(fx.sx, Math.tan(clampSkew(fx.skewY) * rad) * fx.sx, Math.tan(clampSkew(fx.skewX) * rad) * fx.sy, fx.sy, 0, 0);
    ctx.translate(-px, -py);
  }
}

const clampSkew = (deg: number) => Math.max(-80, Math.min(80, deg));

/** Clips to the animation mask (box fractions; groups intersect, shapes within a group unite). */
function clipToMasks(ctx: Ctx2D, masks: MaskShape[][], box: LocalBox): void {
  const x0 = box.ox - box.w / 2;
  const y0 = box.oy - box.h / 2;
  const X = (u: number) => x0 + u * box.w;
  const Y = (v: number) => y0 + v * box.h;
  for (const group of masks) {
    ctx.beginPath();
    for (const m of group) {
      if (m.kind === 'rect') {
        if (m.w > 0 && m.h > 0) ctx.rect(X(m.x), Y(m.y), m.w * box.w, m.h * box.h);
      } else if (m.kind === 'circle') {
        const r = Math.max(0, m.r) * Math.hypot(box.w, box.h);
        ctx.moveTo(X(m.cx) + r, Y(m.cy));
        ctx.arc(X(m.cx), Y(m.cy), r, 0, Math.PI * 2);
      } else if (m.pts.length >= 3) {
        ctx.moveTo(X(m.pts[0]![0]), Y(m.pts[0]![1]));
        for (const [u, v] of m.pts.slice(1)) ctx.lineTo(X(u), Y(v));
        ctx.closePath();
      }
    }
    ctx.clip();
  }
}

/** Animation additions to the CSS filter (brightness / hue / glow). `k` = target px per project px. */
export function fxFilter(fx: AnimFx | null | undefined, k: number): string {
  if (!fx) return '';
  const parts: string[] = [];
  if (Math.abs(fx.brightness - 1) > 1e-3) parts.push(`brightness(${Math.round(fx.brightness * 1000) / 1000})`);
  const hue = ((fx.hue % 360) + 360) % 360;
  if (hue > 1e-3) parts.push(`hue-rotate(${Math.round(hue * 10) / 10}deg)`);
  if (fx.glow > 1e-3) parts.push(`drop-shadow(0 0 ${Math.round(40 * fx.glow * k * 10) / 10}px rgba(255,255,255,${Math.round(fx.glow * 900) / 1000}))`);
  return parts.join(' ');
}

const needsGlitch = (fx: AnimFx | null | undefined): fx is AnimFx => !!fx && (fx.rgbSplit > 0.5 || fx.slices > 0.5);

/** Scratch canvases for the glitch passes (channel split needs two). */
const glitchA = createLayerProvider();
const glitchB = createLayerProvider();
const glitchC = createLayerProvider();

/**
 * Draws `src` (a full-target layer holding one clip) onto ctx with the glitch effects:
 * RGB split (red left, blue right, recombined additively) then horizontal slice offsets.
 * Deterministic in fx.seed, so preview and export match.
 */
function drawGlitched(ctx: Ctx2D, src: CanvasImageSource, fx: AnimFx, tw: number, th: number, k: number): void {
  let image: CanvasImageSource = src;
  const d = fx.rgbSplit * k;
  if (d > 0.5) {
    const acc = glitchA.get(tw, th);
    const ch = glitchB.get(tw, th);
    if (acc && ch) {
      resetCtx(acc);
      acc.clearRect(0, 0, tw, th);
      const channels: [string, number][] = [
        ['#ff0000', -d],
        ['#00ff00', 0],
        ['#0000ff', d],
      ];
      for (const [color, off] of channels) {
        resetCtx(ch);
        ch.clearRect(0, 0, tw, th);
        ch.drawImage(src, off, 0);
        ch.globalCompositeOperation = 'multiply';
        ch.fillStyle = color;
        ch.fillRect(0, 0, tw, th);
        ch.globalCompositeOperation = 'destination-in';
        ch.drawImage(src, off, 0);
        acc.globalCompositeOperation = 'lighter';
        acc.drawImage(ch.canvas as CanvasImageSource, 0, 0);
      }
      resetCtx(acc);
      image = acc.canvas as CanvasImageSource;
    }
  }
  const amp = fx.slices * k;
  if (amp > 0.5) {
    const n = 12;
    const bh = th / n;
    for (let i = 0; i < n; i++) {
      const r = noise(fx.seed, i);
      const off = Math.abs(r) > 0.35 ? r * amp : 0;
      const y = Math.floor(i * bh);
      const h = Math.ceil((i + 1) * bh) - y;
      ctx.drawImage(image, 0, y, tw, h, off, y, tw, h);
    }
  } else {
    ctx.drawImage(image, 0, 0);
  }
}

/** Chroma key works on a copy no bigger than this (px per side). */
export const CHROMA_MAX_SIDE = 2048;
let chromaCtx: Ctx2D | null | undefined;
function chromaScratch(w: number, h: number): Ctx2D | null {
  if (chromaCtx === undefined) {
    chromaCtx = null;
    const opts = { willReadFrequently: true };
    if (typeof OffscreenCanvas !== 'undefined') chromaCtx = new OffscreenCanvas(w, h).getContext('2d', opts) as Ctx2D | null;
    else if (typeof document !== 'undefined') chromaCtx = document.createElement('canvas').getContext('2d', opts) as Ctx2D | null;
  }
  if (!chromaCtx) return null;
  if (chromaCtx.canvas.width !== w) chromaCtx.canvas.width = w;
  if (chromaCtx.canvas.height !== h) chromaCtx.canvas.height = h;
  return chromaCtx;
}

/** `pxPerLocal` = output px per local px (sizes the chroma-key copy to what is shown). */
function drawMedia(ctx: Ctx2D, op: MediaDrawOp, src: SourceImage, box: LocalBox, pxPerLocal: { x: number; y: number }): void {
  const { left, top, right, bottom } = op.crop;
  const sx = clamp01(left) * src.width;
  const sy = clamp01(top) * src.height;
  const sw = Math.max(1, src.width * (1 - clamp01(left) - clamp01(right)));
  const sh = Math.max(1, src.height * (1 - clamp01(top) - clamp01(bottom)));
  if (op.chroma) {
    const w = Math.max(1, Math.min(CHROMA_MAX_SIDE, Math.round(box.w * pxPerLocal.x), Math.round(sw)));
    const h = Math.max(1, Math.min(CHROMA_MAX_SIDE, Math.round(box.h * pxPerLocal.y), Math.round(sh)));
    const c = chromaScratch(w, h);
    if (c) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'copy';
      c.drawImage(src.image, sx, sy, sw, sh, 0, 0, w, h);
      c.globalCompositeOperation = 'source-over';
      const img = c.getImageData(0, 0, w, h);
      chromaKeyPixels(img.data, chromaParams(op.chroma));
      c.putImageData(img, 0, 0);
      ctx.drawImage(c.canvas as CanvasImageSource, 0, 0, w, h, box.ox - box.w / 2, box.oy - box.h / 2, box.w, box.h);
      return;
    }
  }
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

/** Typewriter: keeps the full layout (lines stay put) and cuts the text after `reveal` of its characters. */
export function revealLayout(L: TextLayout, reveal: number, measure: (t: string) => number): TextLayout {
  if (reveal >= 1) return L;
  const total = L.lines.reduce((n, l) => n + [...l.text].length, 0);
  let left = Math.floor(Math.max(0, reveal) * total + 1e-9);
  const lines = L.lines.map((l) => {
    const chars = [...l.text];
    const take = Math.max(0, Math.min(chars.length, left));
    left -= take;
    if (take === chars.length) return l;
    const text = chars.slice(0, take).join('');
    return { ...l, text, width: text ? measure(text) : 0 };
  });
  return { ...L, lines };
}

/** Draws a laid-out text block in local coordinates (block centred on 0,0). */
function drawText(ctx: Ctx2D, op: TextDrawOp, Lfull: TextLayout, shadowScale: number): void {
  const s = op.style;
  let L = Lfull;
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
  if (op.fx && op.fx.reveal < 1) L = revealLayout(Lfull, op.fx.reveal, (t) => ctx.measureText(t).width);
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

/** Grain seed for frame time t: one value per 1/30 s, identical in preview and export. */
export const grainSeed = (t: number): number => Math.max(0, Math.floor((t / 1_000_000) * 30));

const MAX_GRADE_PX = 4096;

const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 };

/** Grades the visible part of a media source at the size it is drawn. Null = could not grade. */
function gradeMedia(op: MediaDrawOp, src: SourceImage, box: LocalBox, k: number, params: GradeParams, opts: RenderOptions): { image: CanvasImageSource; w: number; h: number } | null {
  const l = clamp01(op.crop.left);
  const t = clamp01(op.crop.top);
  const cw = Math.max(1e-4, 1 - l - clamp01(op.crop.right));
  const ch = Math.max(1e-4, 1 - t - clamp01(op.crop.bottom));
  const ax = axisScale(op.transform); // uniform scale or separate width / height (Video › Basic)
  const w = Math.max(1, Math.min(MAX_GRADE_PX, Math.ceil(Math.min(src.width * cw, box.w * Math.abs(ax.x) * k))));
  const h = Math.max(1, Math.min(MAX_GRADE_PX, Math.ceil(Math.min(src.height * ch, box.h * Math.abs(ax.y) * k))));
  const image = opts.grader!.grade({
    source: src.image,
    sourceWidth: src.width,
    sourceHeight: src.height,
    crop: { x: l, y: t, w: cw, h: ch },
    outWidth: w,
    outHeight: h,
    aspect: box.w / box.h,
    params,
  });
  return image ? { image, w, h } : null;
}

/**
 * Draws `fs` onto `ctx`, whose canvas is `fs.width * scale` × `fs.height * scale` pixels.
 * Returns the box of every visual op in draw order (project px), for hit testing.
 */
export function renderFrame(ctx: Ctx2D, fs: FrameState, opts: RenderOptions): DrawnBox[] {
  const k = opts.scale;
  ctx.save();
  resetCtx(ctx);
  ctx.fillStyle = fs.background || '#000000';
  ctx.fillRect(0, 0, fs.width * k, fs.height * k);
  ctx.restore();
  return drawOps(ctx, fs.ops, fs, opts, 0);
}

/** Offscreen layers for compound clips, one per nesting depth (a nested frame is drawn before its parent op uses it). */
const nestedLayers: { get(width: number, height: number): Ctx2D | null }[] = [];

/**
 * Compound clip (⌥G): draws the nested sequence's ops onto a transparent offscreen layer of the
 * target size. The caller then draws the layer like an image covering the canvas, through the
 * compound clip's own transform / opacity / blend / colour.
 */
function renderNested(op: MediaDrawOp, fs: FrameState, opts: RenderOptions, depth: number): SourceImage | null {
  const nested = op.nested;
  if (!nested) return null;
  const k = opts.scale;
  const tw = Math.max(1, Math.round(fs.width * k));
  const th = Math.max(1, Math.round(fs.height * k));
  const provider = (nestedLayers[depth] ??= createLayerProvider());
  const layer = provider.get(tw, th);
  if (!layer) return null;
  layer.save();
  resetCtx(layer);
  layer.clearRect(0, 0, tw, th);
  layer.restore();
  drawOps(layer, nested.ops, { ...fs, t: nested.t }, opts, depth + 1);
  return { image: layer.canvas as CanvasImageSource, width: tw, height: th };
}

/** Draws ops onto ctx (no background). Returns the boxes of the visual ops, for hit testing. */
function drawOps(ctx: Ctx2D, list: readonly DrawOp[], fs: FrameState, opts: RenderOptions, depth: number): DrawnBox[] {
  const { width: W, height: H } = fs;
  const k = opts.scale;
  const tw = W * k;
  const th = H * k;
  const boxes: DrawnBox[] = [];

  ctx.save();
  resetCtx(ctx);

  for (const op of list) {
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
      src = op.nested ? renderNested(op, fs, opts, depth) : opts.sources.get(op);
    } else {
      resetCtx(ctx);
      textLayout = layoutTextOp(ctx, op, W);
      local = { w: textLayout.width, h: textLayout.height, ox: 0, oy: 0 };
    }
    const isBackground = op.kind === 'media' && op.role === 'background';
    if (!isBackground) boxes.push(projectBox(op, local, W, H));

    const alpha = Math.min(1, Math.max(0, op.transform.opacity));
    if (alpha <= 0 || local.w <= 0 || local.h <= 0) continue;
    if (op.kind === 'media' && !src) continue;
    if (isBackground && src === 'missing') continue;
    if (op.clipRect && (op.clipRect.w <= 0 || op.clipRect.h <= 0)) continue;

    // ---- colour: the shared pipeline when a grader is available, else the CSS approximation.
    // Order per clip: grade (source space) → chroma key → transform / animation → mask → blend.
    const params = opts.grader && src !== 'missing' ? gradeParams(op.color, grainSeed(fs.t), opts.lutReady ?? requestLut) : null;
    let graded: { image: CanvasImageSource; w: number; h: number } | null = null;
    if (params && op.kind === 'media' && src && src !== 'missing') graded = gradeMedia(op, src, local, k, params, opts);
    const gpuText = !!params && op.kind === 'text' && !!opts.layers;
    const legacy = !graded && !gpuText;
    const baseFilter = legacy ? cssFilter(op.color, op.blur * k) : op.blur * k > 0.05 ? `blur(${Math.round(op.blur * k * 1000) / 1000}px)` : 'none';
    // animation light (brightness / hue / glow) on top of the graded pixels
    const extraFilter = fxFilter(op.fx, k);
    const filter = extraFilter ? (baseFilter === 'none' ? extraFilter : `${baseFilter} ${extraFilter}`) : baseFilter;
    const passes = legacy && src !== 'missing' ? tonePasses(op.color) : [];
    // the clip's own mask (Video › Mask); the Adjust mask only limits the grade (inside params)
    const mask = op.kind === 'media' && op.mask && src !== 'missing' ? maskGeometry(op.mask, local) : null;
    const linearBurn = op.blendMode === 'linear-burn';
    const glitch = needsGlitch(op.fx) ? op.fx : null;
    const layer = passes.length || mask || linearBurn || gpuText || glitch ? opts.layers?.get(tw, th) ?? null : null;
    const target = layer ?? ctx;
    const ax = axisScale(op.transform);

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
    applyOpTransform(target, op, W, H, k, local);
    if (op.fx && op.fx.masks.length) clipToMasks(target, op.fx.masks, local);
    if (op.kind === 'media') {
      if (src === 'missing') drawMissing(target, local);
      else if (graded) drawMedia(target, { ...op, crop: NO_CROP }, { image: graded.image, width: graded.w, height: graded.h }, local, { x: k * Math.abs(ax.x), y: k * Math.abs(ax.y) });
      else if (src) drawMedia(target, op, src, local, { x: k * Math.abs(ax.x), y: k * Math.abs(ax.y) });
    } else if (textLayout) {
      drawText(target, op, textLayout, k * op.transform.scale);
    }
    if (layer && passes.length) drawTonePasses(target, passes, local);
    if (layer && mask) applyMask(target, mask, k * Math.sqrt(Math.abs(ax.x * ax.y)));
    target.restore();

    // text through the colour pass: grade the whole layer (vignette / mask relative to the canvas)
    let layerImage: CanvasImageSource | null = layer ? (layer.canvas as CanvasImageSource) : null;
    if (layer && gpuText && params) {
      const g = opts.grader!.grade({
        source: layer.canvas as CanvasImageSource,
        sourceWidth: tw,
        sourceHeight: th,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        outWidth: tw,
        outHeight: th,
        aspect: tw / th,
        params,
      });
      if (g) layerImage = g;
    }

    // ---- composite the layer
    if (layer && linearBurn) {
      let burnSource = layerImage ?? (layer.canvas as CanvasImageSource);
      if (glitch) {
        // glitch first (on its own layer), then linear-burn the result
        const g = glitchC.get(tw, th);
        if (g) {
          resetCtx(g);
          g.clearRect(0, 0, tw, th);
          drawGlitched(g, burnSource, glitch, tw, th, k);
          burnSource = g.canvas as CanvasImageSource;
        }
      }
      compositeLinearBurn(ctx, burnSource, layer.canvas.width, layer.canvas.height, opts.scratch?.get(tw, th) ?? inverseScratch(Math.round(tw), Math.round(th)), alpha, op.clipRect, tw, th);
    } else if (layer) {
      ctx.save();
      resetCtx(ctx);
      if (op.clipRect) clipToRect(ctx, op.clipRect, tw, th);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = op.composite;
      if (glitch) drawGlitched(ctx, layerImage ?? (layer.canvas as CanvasImageSource), glitch, tw, th, k);
      else ctx.drawImage(layerImage ?? (layer.canvas as CanvasImageSource), 0, 0, tw, th);
      ctx.restore();
    }
  }
  ctx.restore();
  return boxes;
}

let invCtx: Ctx2D | null | undefined;
function inverseScratch(w: number, h: number): Ctx2D | null {
  if (invCtx === undefined) {
    invCtx = null;
    if (typeof OffscreenCanvas !== 'undefined') invCtx = new OffscreenCanvas(w, h).getContext('2d') as Ctx2D | null;
    else if (typeof document !== 'undefined') invCtx = document.createElement('canvas').getContext('2d');
  }
  if (!invCtx) return null;
  if (invCtx.canvas.width !== w) invCtx.canvas.width = w;
  if (invCtx.canvas.height !== h) invCtx.canvas.height = h;
  return invCtx;
}

/**
 * Linear burn (result = dst + src − 1, faded by opacity) with Canvas 2D primitives:
 * invert dst · add the inverted source (lighter, × opacity) · invert again
 * = 1 − ((1 − dst) + α(1 − src)) = dst − α(1 − src), clamped at 0.
 */
function compositeLinearBurn(ctx: Ctx2D, source: CanvasImageSource, w: number, h: number, inv: Ctx2D | null, alpha: number, rect: VisualOp['clipRect'], tw: number, th: number): void {
  if (!inv) {
    // no second scratch canvas: multiply is the closest single-pass look
    ctx.save();
    resetCtx(ctx);
    if (rect) clipToRect(ctx, rect, tw, th);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(source, 0, 0);
    ctx.restore();
    return;
  }
  // inverted source with the source's own coverage
  inv.save();
  resetCtx(inv);
  inv.globalCompositeOperation = 'copy';
  inv.drawImage(source, 0, 0);
  inv.globalCompositeOperation = 'difference';
  inv.fillStyle = '#ffffff';
  inv.fillRect(0, 0, w, h);
  inv.globalCompositeOperation = 'destination-in';
  inv.drawImage(source, 0, 0);
  inv.restore();

  ctx.save();
  resetCtx(ctx);
  if (rect) clipToRect(ctx, rect, tw, th);
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tw, th);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.drawImage(inv.canvas as CanvasImageSource, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'difference';
  ctx.fillRect(0, 0, tw, th);
  ctx.restore();
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
