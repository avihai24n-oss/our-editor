/**
 * Animation tile thumbnails. A tile is drawn by the SAME compositor as the player and the export
 * (`renderFrame`) from the SAME catalogue frame (`framesToOp`), on a tiny 120×120 "project", so
 * the hover preview shows exactly the motion the clip will get.
 */
import type { AnimDef } from '../../engine/animations';
import { framesToOp, type ColorOps, type FrameState, type MediaDrawOp, type TextDrawOp } from '../../engine/frameState';
import { createLayerProvider, renderFrame } from '../../engine/render';
import { defaultAdjust, defaultTextStyle } from '../../model/defaults';

const SIZE = 120;
const neutral = (): ColorOps => ({ ...defaultAdjust(), grayscale: 0, sepia: 0 });
const layers = createLayerProvider();
let picture: HTMLCanvasElement | null = null;

/** Canvas thumbnails cannot run under jsdom (unit tests); the tile then shows its label only. */
export const canDrawThumbs = (): boolean => typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent) && typeof document !== 'undefined';

/** A small landscape picture (sky, sun, hills, a red cabin) standing in for the clip. */
function thumbPicture(): HTMLCanvasElement {
  if (picture) return picture;
  const c = document.createElement('canvas');
  c.width = c.height = 240;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 240);
  sky.addColorStop(0, '#2c5f8a');
  sky.addColorStop(1, '#a9d4ea');
  g.fillStyle = sky;
  g.fillRect(0, 0, 240, 240);
  g.fillStyle = '#ffd36b';
  g.beginPath();
  g.arc(178, 62, 26, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#e9f1f6';
  g.beginPath();
  g.moveTo(0, 170);
  g.lineTo(70, 92);
  g.lineTo(130, 160);
  g.lineTo(185, 110);
  g.lineTo(240, 165);
  g.lineTo(240, 240);
  g.lineTo(0, 240);
  g.fill();
  g.fillStyle = '#3c6b4e';
  g.fillRect(0, 196, 240, 44);
  g.fillStyle = '#d33a2c';
  g.fillRect(96, 128, 52, 38);
  g.fillStyle = '#1d1d1f';
  g.fillRect(104, 136, 14, 12);
  g.fillRect(126, 136, 14, 12);
  picture = c;
  return c;
}

/** Draws the animation `def` at progress p onto `canvas` (sized in device px). */
export function drawAnimThumb(canvas: HTMLCanvasElement, def: AnimDef | null, p: number, kind: 'media' | 'text'): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { effect, fx } = def ? framesToOp([def.frame(p)], SIZE, SIZE) : { effect: null, fx: null };
  const base = {
    clipId: 'thumb',
    trackId: 'thumb',
    layer: 0,
    transform: {
      x: effect?.dx ?? 0,
      y: effect?.dy ?? 0,
      scale: effect?.scaleMul ?? 1,
      scaleX: effect?.scaleMul ?? 1,
      scaleY: effect?.scaleMul ?? 1,
      rotation: effect?.rotation ?? 0,
      opacity: Math.min(1, Math.max(0, effect?.alphaMul ?? 1)),
      flipH: false,
      flipV: false,
    },
    composite: 'source-over' as GlobalCompositeOperation,
    blendMode: 'normal' as const,
    color: neutral(),
    blur: effect?.blur ?? 0,
    clipRect: null,
    animation: null,
    transition: null,
    fx,
  };
  let op: MediaDrawOp | TextDrawOp;
  if (kind === 'text') {
    const style = { ...defaultTextStyle('Text'), fontSize: 36, bold: true, color: '#ffffff' };
    op = { ...base, kind: 'text', style, lines: ['Text'] };
  } else {
    op = { ...base, kind: 'media', mediaType: 'image', assetId: 'thumb', sourceTime: 0, fitWidth: SIZE, fitHeight: SIZE, crop: { left: 0, top: 0, right: 0, bottom: 0 }, mask: null, chroma: null };
  }
  const fs: FrameState = { t: 0, width: SIZE, height: SIZE, background: kind === 'text' ? '#2b2b31' : '#000000', ops: [op], audio: [] };
  const img = thumbPicture();
  renderFrame(ctx, fs, { scale: canvas.width / SIZE, sources: { get: () => ({ image: img, width: img.width, height: img.height }) }, layers });
}

/** Progress shown while the tile is idle (a displaced moment, so tiles look different). */
export function idleProgress(def: AnimDef): number {
  return def.phase === 'in' ? 0.3 : def.phase === 'out' ? 0.7 : 0.25;
}

/** Progress at time `ms` of a hover preview (In/Out play then hold; Combo/Loop repeat). */
export function hoverProgress(def: AnimDef, ms: number): number {
  if (def.phase === 'loop') return (ms % 1000) / 1000;
  if (def.phase === 'combo') return (ms % 1600) / 1600;
  const cycle = ms % 1600;
  return Math.min(1, cycle / 1000);
}
