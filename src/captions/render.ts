/**
 * Draws a caption (a TextDrawOp carrying `caption`) on a 2D canvas, word by word. Called by the
 * shared compositor (engine/render/renderFrame.ts), so the player and the export match.
 *
 * Layout: words are measured one by one (each with its own direction, so Hebrew and English both
 * read right and punctuation lands on the correct side), wrapped into at most `maxLines` lines
 * of `maxWidth` × canvas width (the font shrinks to fit, MakePodcast's one-line fit, down to half
 * size), and ordered right-to-left when the caption is Hebrew. The block is centred on (0, 0) in
 * the op's local coordinates; the title-safe clamp moves the block via the box offset.
 */
import type { Ctx2D } from '../engine/render/types';
import { HORMOZI_SPRING, WORD_POP_SPRING, activeWordIndex, spring, wordState, type CaptionFrame } from './frame';
import { isRTL } from './model';
import type { CaptionStyle } from './types';
import './fonts';

export interface CaptionWordBox {
  /** Index in CaptionFrame.words. */
  index: number;
  text: string;
  rtl: boolean;
  /** Left edge and vertical centre, local px. */
  x: number;
  y: number;
  w: number;
}

export interface CaptionLayout {
  words: CaptionWordBox[];
  /** Block box (local px): size and centre offset. */
  box: { w: number; h: number; ox: number; oy: number };
  fontSize: number;
  font: string;
  lineHeightPx: number;
}

type OpLike = { caption?: CaptionFrame; transform: { x: number; y: number; scale: number; scaleX?: number; scaleY?: number; rotation: number } };

export const captionFont = (s: Pick<CaptionStyle, 'italic' | 'fontWeight' | 'fontFamily'>, size: number): string => {
  const fam = /["',]/.test(s.fontFamily) ? s.fontFamily : `"${s.fontFamily}"`;
  return `${s.italic ? 'italic ' : ''}${Math.round(s.fontWeight) || 400} ${Math.max(1, Math.round(size * 100) / 100)}px ${fam}, "Heebo", system-ui, sans-serif`;
};

const display = (s: CaptionStyle, text: string) => (s.uppercase ? text.toLocaleUpperCase() : text);

/** Extra horizontal room a word reserves for the Highlight Box (MakePodcast: padding 0 0.1em). */
const boxPad = (s: CaptionStyle, size: number) => (s.animation === 'box' ? Math.round(size * 0.1) : 0);

function setDir(ctx: Ctx2D, rtl: boolean): void {
  const c = ctx as Ctx2D & { direction?: CanvasDirection };
  if ('direction' in c) c.direction = rtl ? 'rtl' : 'ltr';
}

/** Lays the caption out. `W`, `H` = canvas size in project px. */
export function layoutCaption(ctx: Ctx2D, op: OpLike, W: number, H: number): CaptionLayout {
  const cap = op.caption!;
  const s = cap.style;
  const all = cap.words.map((w, index) => ({ index, text: display(s, w.text) }));
  let shown = all;
  if (s.animation === 'word-pop') {
    const i = activeWordIndex(cap.words, cap.now);
    shown = i >= 0 ? [all[i]!] : [];
  }
  const maxW = Math.max(10, s.maxWidth * W);
  const maxLines = Math.max(1, Math.round(s.maxLines) || 1);
  let size = Math.max(4, s.fontSize);
  let lines: { items: { index: number; text: string; rtl: boolean; w: number }[]; w: number }[] = [];
  let gap = 0;
  let pad = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    ctx.font = captionFont(s, size);
    gap = s.wordSpacing * size;
    pad = boxPad(s, size);
    const items = shown.map((w) => {
      const rtl = isRTL(w.text);
      setDir(ctx, rtl);
      return { ...w, rtl, w: ctx.measureText(w.text).width + pad * 2 };
    });
    lines = [];
    let cur: typeof items = [];
    let curW = 0;
    for (const it of items) {
      const next = cur.length ? curW + gap + it.w : it.w;
      if (cur.length && next > maxW) {
        lines.push({ items: cur, w: curW });
        cur = [it];
        curW = it.w;
      } else {
        cur.push(it);
        curW = next;
      }
    }
    if (cur.length) lines.push({ items: cur, w: curW });
    const widest = Math.max(0, ...lines.map((l) => l.w));
    if ((lines.length <= maxLines && widest <= maxW) || size <= s.fontSize * 0.5) break;
    size = Math.max(s.fontSize * 0.5, size * Math.min(0.94, lines.length > maxLines ? Math.sqrt(maxLines / lines.length) : maxW / widest));
  }
  const lineHeightPx = size * (s.lineHeight > 0 ? s.lineHeight : 1.15);
  const contentW = Math.max(0, ...lines.map((l) => l.w));
  const bg = s.background.enabled && s.background.opacity > 0;
  const padX = bg ? Math.round(size * 0.35) : Math.round(size * 0.1);
  const padY = bg ? Math.round(size * 0.18) : Math.round(size * 0.05);
  const boxW = lines.length ? contentW + padX * 2 : 0;
  const boxH = lines.length ? lines.length * lineHeightPx + padY * 2 : 0;
  const words: CaptionWordBox[] = [];
  lines.forEach((l, li) => {
    const y = -boxH / 2 + padY + (li + 0.5) * lineHeightPx;
    const left = s.align === 'left' ? -contentW / 2 : s.align === 'right' ? contentW / 2 - l.w : -l.w / 2;
    // Hebrew captions run right to left: the first word sits at the right end of the line
    let x = cap.rtl ? left + l.w : left;
    for (const it of l.items) {
      if (cap.rtl) {
        x -= it.w;
        words.push({ index: it.index, text: it.text, rtl: it.rtl, x: x + pad, y, w: it.w - pad * 2 });
        x -= gap;
      } else {
        words.push({ index: it.index, text: it.text, rtl: it.rtl, x: x + pad, y, w: it.w - pad * 2 });
        x += it.w + gap;
      }
    }
  });
  // title-safe: keep the block inside 5 % of each edge (unrotated estimate, project px)
  let ox = 0;
  let oy = 0;
  if (s.safeArea && boxW > 0) {
    const tf = op.transform;
    const sx = Math.abs(tf.scaleX ?? tf.scale) || 1;
    const sy = Math.abs(tf.scaleY ?? tf.scale) || 1;
    const cx = W / 2 + tf.x;
    const cy = H / 2 + tf.y;
    const hw = (boxW * sx) / 2;
    const hh = (boxH * sy) / 2;
    const mx = W * 0.05;
    const my = H * 0.05;
    const clampC = (c: number, half: number, lo: number, hi: number) => (hi - lo < half * 2 ? (lo + hi) / 2 : Math.min(hi - half, Math.max(lo + half, c)));
    if (!tf.rotation) {
      ox = (clampC(cx, hw, mx, W - mx) - cx) / sx;
      oy = (clampC(cy, hh, my, H - my) - cy) / sy;
    }
  }
  if (ox || oy) for (const w of words) ((w.x += ox), (w.y += oy));
  return { words, box: { w: boxW, h: boxH, ox, oy }, fontSize: size, font: captionFont(s, size), lineHeightPx };
}

/** #rgb / #rrggbb / rgba() → rgba with alpha `a` (glow layers). */
export function withAlpha(color: string, a: number): string {
  const h = color.trim();
  if (h.startsWith('#')) {
    const f = h.length === 4 ? h.slice(1).replace(/./g, '$&$&') : h.slice(1, 7);
    const n = parseInt(f, 16) || 0;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = h.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1]!.split(',').map((x) => x.trim());
    return `rgba(${r},${g},${b},${a})`;
  }
  return h;
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (typeof (ctx as CanvasRenderingContext2D).roundRect === 'function') ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, h / 2, w / 2)));
  else ctx.rect(x, y, w, h);
}

interface WordLook {
  color: string;
  alpha: number;
  scale: number;
  dy: number;
  /** karaoke fill: fraction of the word in the highlight colour (0..1), from the reading start. */
  fill: number;
  boxed: boolean;
}

/** How a word looks at `now` for the style's animation (pure). */
export function wordLook(s: CaptionStyle, frame: CaptionFrame, index: number): WordLook {
  const w = frame.words[index]!;
  const st = wordState(w, frame.now);
  const look: WordLook = { color: s.color, alpha: 1, scale: 1, dy: 0, fill: 0, boxed: false };
  const active = st.phase === 'active';
  switch (s.animation) {
    case 'highlight':
      if (active) look.color = s.highlightColor;
      break;
    case 'box':
      look.boxed = active;
      break;
    case 'word-pop':
      // MakePodcast: scale 0.5 → 1 on a spring from the word's start; in glow mode the word takes the highlight fill
      look.scale = 0.5 + 0.5 * spring(st.since, WORD_POP_SPRING);
      if (s.glow) look.color = s.highlightColor;
      break;
    case 'pop-highlight':
      if (active) {
        look.color = s.highlightColor;
        look.scale = 0.86 + 0.14 * spring(st.since, HORMOZI_SPRING);
      }
      break;
    case 'karaoke-fill':
      look.fill = st.phase === 'past' ? 1 : active ? st.progress : 0;
      break;
    case 'bounce':
      if (active) {
        look.color = s.highlightColor;
        const p = Math.min(1, Math.max(0, st.since / 0.3));
        look.dy = -Math.sin(Math.PI * p) * 0.16;
        look.scale = 1 + 0.08 * Math.sin(Math.PI * p);
      }
      break;
    case 'reveal':
      if (st.phase === 'future') look.alpha = 0;
      else {
        const p = Math.min(1, Math.max(0, st.since / 0.12));
        look.alpha = p;
        look.scale = 0.9 + 0.1 * p;
        if (active) look.color = s.highlightColor === s.color ? s.color : s.highlightColor;
      }
      break;
    case 'none':
    default:
      break;
  }
  return look;
}

/**
 * Draws the laid-out caption in local coordinates (block centred on 0,0 + box offset).
 * `shadowScale` = target px per project px (shadows ignore the canvas transform).
 */
export function drawCaption(ctx: Ctx2D, op: OpLike, L: CaptionLayout, shadowScale: number): void {
  const frame = op.caption!;
  const s = frame.style;
  if (!L.words.length) return;
  const size = L.fontSize;
  if (s.background.enabled && s.background.opacity > 0) {
    ctx.save();
    ctx.globalAlpha *= Math.min(1, Math.max(0, s.background.opacity));
    ctx.fillStyle = s.background.color;
    roundRect(ctx, L.box.ox - L.box.w / 2, L.box.oy - L.box.h / 2, L.box.w, L.box.h, s.background.radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.font = L.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const pad = boxPad(s, size);
  const strokeOn = s.stroke.enabled && s.stroke.width > 0;
  for (const wb of L.words) {
    const look = wordLook(s, frame, wb.index);
    if (look.alpha <= 0.001) continue;
    ctx.save();
    ctx.globalAlpha *= look.alpha;
    const cx = wb.x + wb.w / 2;
    ctx.translate(cx, wb.y + look.dy * size);
    if (look.scale !== 1) ctx.scale(look.scale, look.scale);
    ctx.translate(-wb.w / 2, 0);
    setDir(ctx, wb.rtl);
    if (look.boxed) {
      // MakePodcast Highlight Box: the spoken word on a rounded box in the highlight colour, no shadow
      ctx.fillStyle = s.highlightColor;
      roundRect(ctx, -pad, -size * 0.575, wb.w + pad * 2, size * 1.15, pad);
      ctx.fill();
    }
    const shadowFor = (_color: string) => {
      if (s.glow) return null;
      if (look.boxed || !s.shadow.enabled) return null;
      return { color: s.shadow.color, blur: s.shadow.blur, x: s.shadow.offsetX, y: s.shadow.offsetY };
    };
    const setShadow = (sh: { color: string; blur: number; x: number; y: number } | null) => {
      ctx.shadowColor = sh ? sh.color : 'transparent';
      ctx.shadowBlur = sh ? sh.blur * shadowScale : 0;
      ctx.shadowOffsetX = sh ? sh.x * shadowScale : 0;
      ctx.shadowOffsetY = sh ? sh.y * shadowScale : 0;
    };
    const paint = (color: string, withEffects: boolean) => {
      if (withEffects && s.glow && !look.boxed) {
        // MakePodcast glowShadow: three halos at 10 / 22 / 40 % of the size, 80 % alpha, in the word's colour
        for (const m of [0.4, 0.22, 0.1]) {
          ctx.shadowColor = withAlpha(color, 0.8);
          ctx.shadowBlur = size * m * shadowScale;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          ctx.fillStyle = color;
          ctx.fillText(wb.text, 0, 0);
        }
        setShadow(null);
      }
      if (strokeOn) {
        setShadow(withEffects ? shadowFor(color) : null);
        ctx.strokeStyle = s.stroke.color;
        ctx.lineWidth = s.stroke.width * 2;
        ctx.strokeText(wb.text, 0, 0);
        setShadow(null);
      } else setShadow(withEffects ? shadowFor(color) : null);
      ctx.fillStyle = color;
      ctx.fillText(wb.text, 0, 0);
      setShadow(null);
    };
    paint(look.color, true);
    if (look.fill > 0) {
      // karaoke fill: the highlight sweeps in reading direction
      ctx.save();
      ctx.beginPath();
      const fw = (wb.w + 2) * Math.min(1, look.fill);
      if (frame.rtl || wb.rtl) ctx.rect(wb.w + 1 - fw, -size, fw, size * 2);
      else ctx.rect(-1, -size, fw, size * 2);
      ctx.clip();
      paint(s.highlightColor, false);
      ctx.restore();
    }
    ctx.restore();
  }
}
