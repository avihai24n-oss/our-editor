/**
 * Player-side colour tools (Adjust › Color): video scopes, the before/after split and the
 * qualifier eyedropper. PreviewEngine calls `afterPreviewRender()` after every frame it draws:
 *  - scopes: the frame on the canvas (graded, exactly what is shown) is copied into a small canvas
 *    (≤ 480 px wide) and analysed by engine/color/scopes.ts at most ~12×/s (trailing update, so the
 *    last frame of a scrub or edit always lands);
 *  - split: the same frame state with every colour op neutralised ("Before") is rendered
 *    off-screen and its left part drawn over the canvas (after the scope capture, so the scopes
 *    always show the graded picture). Export never sees any of this.
 */
import { create } from 'zustand';
import { computeScopes, type ScopeData } from '../../engine/color/scopes';
import type { ColorOps, DrawOp, FrameState } from '../../engine/frameState';
import { renderFrame, type RenderOptions } from '../../engine/render';
import { defaultColorPage } from '../../model/colorPage';
import { defaultAdjust } from '../../model/defaults';
import type { Id } from '../../model/types';
import { readPref, writePref } from '../../panels/prefs';

export type ScopeKind = 'waveform' | 'parade' | 'vector' | 'histogram';
export const SCOPE_KINDS: { id: ScopeKind; label: string }[] = [
  { id: 'waveform', label: 'Waveform' },
  { id: 'parade', label: 'Parade' },
  { id: 'vector', label: 'Vectorscope' },
  { id: 'histogram', label: 'Histogram' },
];

interface ColorViewState {
  scopes: boolean;
  kinds: ScopeKind[];
  split: boolean;
  /** Divider position, 0..1 of the frame width ("Before" on the left). */
  splitPos: number;
  /** Qualifier eyedropper armed for this clip. */
  pickClipId: Id | null;
  setScopes: (on: boolean) => void;
  toggleKind: (k: ScopeKind) => void;
  setSplit: (on: boolean) => void;
  setSplitPos: (v: number) => void;
  setPick: (id: Id | null) => void;
}

const KIND_IDS = SCOPE_KINDS.map((k) => k.id);
const initialKinds = (): ScopeKind[] => {
  const v = readPref<string>('player.scopeKinds', 'waveform,vector');
  const list = v.split(',').filter((k): k is ScopeKind => (KIND_IDS as string[]).includes(k));
  return list.length ? list : ['waveform', 'vector'];
};

export const useColorView = create<ColorViewState>((set, get) => ({
  scopes: readPref('player.scopes', false),
  kinds: initialKinds(),
  split: false,
  splitPos: 0.5,
  pickClipId: null,
  setScopes: (on) => {
    writePref('player.scopes', on);
    set({ scopes: on });
  },
  toggleKind: (k) => {
    const cur = get().kinds;
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : KIND_IDS.filter((x) => x === k || cur.includes(x));
    writePref('player.scopeKinds', next.join(','));
    set({ kinds: next });
  },
  setSplit: (on) => set({ split: on }),
  setSplitPos: (v) => set({ splitPos: Math.min(1, Math.max(0, v)) }),
  setPick: (id) => set({ pickClipId: id }),
}));

// ---------------------------------------------------------------- neutral ("Before") frame

const NEUTRAL: ColorOps = { ...defaultAdjust(), grayscale: 0, sepia: 0 };

/** The ops with every colour operation removed (Adjust, Filter, LUT, … Color page), deep. */
export function neutralOps(ops: readonly DrawOp[]): DrawOp[] {
  return ops.map((op) => {
    if (op.kind === 'fill') return op;
    const out = { ...op, color: NEUTRAL } as DrawOp;
    if (op.kind === 'media' && op.nested) (out as typeof op).nested = { ...op.nested, ops: neutralOps(op.nested.ops) };
    return out;
  });
}

/** Ops where clip `clipId` (deep) gets `fn(color)`. */
function mapClipColor(ops: readonly DrawOp[], clipId: Id, fn: (c: ColorOps) => ColorOps): DrawOp[] {
  return ops.map((op) => {
    if (op.kind === 'fill') return op;
    let out = op;
    if (op.clipId === clipId) out = { ...op, color: fn(op.color) } as typeof op;
    if (op.kind === 'media' && op.nested) out = { ...out, nested: { ...op.nested, ops: mapClipColor(op.nested.ops, clipId, fn) } } as typeof op;
    return out;
  });
}

// ---------------------------------------------------------------- frame tap

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let last: { fs: FrameState; opts: RenderOptions; width: number; height: number } | null = null;
let scopeCtx: Ctx | null = null;
let beforeCtx: Ctx | null = null;
let scopeData: ScopeData | null = null;
let lastCompute = 0;
let trailing = 0;
let frameNo = 0;
let computes = 0;
let computeMs = 0;
const listeners = new Set<(d: ScopeData) => void>();

const SCOPE_MAX_W = 480;
const SCOPE_INTERVAL_MS = 80;

function make2d(w: number, h: number, read: boolean): Ctx | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: read }) as Ctx | null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c.getContext('2d', { willReadFrequently: read });
  } catch {
    return null;
  }
}

function sized(ctx: Ctx | null, w: number, h: number, read: boolean): Ctx | null {
  const c = ctx ?? make2d(w, h, read);
  if (!c) return null;
  if (c.canvas.width !== w) c.canvas.width = w;
  if (c.canvas.height !== h) c.canvas.height = h;
  return c;
}

function computeFromCapture(): void {
  lastCompute = performance.now();
  if (!scopeCtx) return;
  const { width: w, height: h } = scopeCtx.canvas;
  try {
    const t0 = performance.now();
    const img = scopeCtx.getImageData(0, 0, w, h);
    scopeData = computeScopes(img.data, w, h, scopeData);
    computes++;
    computeMs = performance.now() - t0;
  } catch {
    return;
  }
  for (const l of listeners) l(scopeData);
}

/** Called by PreviewEngine after each frame it rendered onto `canvas`. */
export function afterPreviewRender(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, fs: FrameState, opts: RenderOptions): void {
  frameNo++;
  last = { fs, opts, width: canvas.width, height: canvas.height };
  const v = useColorView.getState();
  if (v.scopes && listeners.size && canvas.width > 0 && canvas.height > 0) {
    const k = Math.min(1, SCOPE_MAX_W / canvas.width);
    const w = Math.max(1, Math.round(canvas.width * k));
    const h = Math.max(1, Math.round(canvas.height * k));
    scopeCtx = sized(scopeCtx, w, h, true);
    if (scopeCtx) {
      scopeCtx.imageSmoothingEnabled = true;
      scopeCtx.imageSmoothingQuality = 'medium';
      scopeCtx.drawImage(canvas, 0, 0, w, h);
      const since = performance.now() - lastCompute;
      if (since >= SCOPE_INTERVAL_MS) computeFromCapture();
      else if (!trailing) {
        trailing = window.setTimeout(() => {
          trailing = 0;
          computeFromCapture();
        }, SCOPE_INTERVAL_MS - since);
      }
    }
  }
  if (v.split && v.splitPos > 0) {
    beforeCtx = sized(beforeCtx, canvas.width, canvas.height, false);
    if (!beforeCtx) return;
    renderFrame(beforeCtx, { ...fs, ops: neutralOps(fs.ops) }, opts);
    const x = Math.round(canvas.width * v.splitPos);
    if (x > 0) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.drawImage(beforeCtx.canvas, 0, 0, x, canvas.height, 0, 0, x, canvas.height);
      ctx.restore();
    }
  }
}

/** Live scope data (null until the first analysed frame). Returns the unsubscribe. */
export function onScopes(fn: (d: ScopeData) => void): () => void {
  listeners.add(fn);
  if (scopeData) fn(scopeData);
  return () => listeners.delete(fn);
}

/** Last analysed scope data (e2e / debug). */
export const lastScopes = (): ScopeData | null => scopeData;

/** Forces a scope analysis of the last captured frame now (e2e). */
export function refreshScopes(): void {
  computeFromCapture();
}

/**
 * Qualifier eyedropper: the colour the qualifier of `clipId` keys on (the Color page input:
 * every grade of the clip except its Color page, CST kept) at frame position fx, fy (0..1).
 * Averages a 3×3 block. Null when no frame was rendered yet.
 */
export function pickStageInput(clipId: Id, fx: number, fy: number): [number, number, number] | null {
  if (!last) return null;
  const { width: w, height: h } = last;
  const c = make2d(w, h, true);
  if (!c) return null;
  const ops = mapClipColor(last.fs.ops, clipId, (col) => {
    if (!col.grade) return col;
    const cp = defaultColorPage();
    cp.cst = { ...col.grade.color.cst };
    cp.primaries.lumMix = col.grade.color.primaries.lumMix; // the wheels run before the page
    return { ...col, grade: { ...col.grade, color: cp } };
  });
  renderFrame(c, { ...last.fs, ops }, last.opts);
  const x = Math.min(w - 2, Math.max(1, Math.round(fx * w)));
  const y = Math.min(h - 2, Math.max(1, Math.round(fy * h)));
  const d = c.getImageData(x - 1, y - 1, 3, 3).data;
  const s = [0, 0, 0];
  for (let i = 0; i < 9; i++) for (let k = 0; k < 3; k++) s[k]! += d[i * 4 + k]!;
  return [s[0]! / 9 / 255, s[1]! / 9 / 255, s[2]! / 9 / 255];
}

/**
 * The last rendered frame with every colour operation removed, scaled to ≤ maxW px wide (the
 * picture the gallery's built-in looks preview on). Null before the first render.
 */
export function neutralFrameImage(maxW = 160): ImageData | null {
  if (!last) return null;
  const { width: w, height: h } = last;
  const full = make2d(w, h, false);
  if (!full) return null;
  renderFrame(full, { ...last.fs, ops: neutralOps(last.fs.ops) }, last.opts);
  const k = Math.min(1, maxW / w);
  const tw = Math.max(1, Math.round(w * k));
  const th = Math.max(1, Math.round(h * k));
  const small = make2d(tw, th, true);
  if (!small) return null;
  small.drawImage(full.canvas, 0, 0, tw, th);
  return small.getImageData(0, 0, tw, th);
}

/** Frames rendered so far (e2e). */
export const renderedFrames = (): number => frameNo;

if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __oeScopes?: unknown }).__oeScopes = { last: lastScopes, refresh: refreshScopes, view: useColorView, frames: renderedFrames, computes: () => ({ count: computes, ms: computeMs }), pick: pickStageInput, neutral: neutralFrameImage };
}
