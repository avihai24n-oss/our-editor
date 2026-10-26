/**
 * A caption preset drawn by the real caption renderer (src/captions/render.ts) on a small canvas,
 * frozen while the second word is being said, so a tile shows exactly what the preset does.
 */
import { useEffect, useRef } from 'react';
import { presetStyle } from '../presets';
import { drawCaption, layoutCaption } from '../render';
import { loadCaptionFonts } from '../fonts';
import type { CaptionStyle } from '../types';
import type { CaptionFrame } from '../frame';

const SAMPLE_HE = ['סיפור', 'של', 'משפחה'];
const SAMPLE_EN = ['the', 'quick', 'brown'];

export function drawPresetSample(canvas: HTMLCanvasElement, style: CaptionStyle, hebrew: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const VW = 1080;
  const VH = 540;
  const k = canvas.width / VW;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, '#3a4250');
  g.addColorStop(1, '#1d2129');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const words = (hebrew ? SAMPLE_HE : SAMPLE_EN).map((text, i) => ({ text, start: i * 400_000, end: (i + 1) * 400_000 }));
  const s: CaptionStyle = { ...style, safeArea: false, x: 0, y: 0.5, fontSize: Math.min(Math.max(style.fontSize * 1.5, 120), 150), maxWidth: 0.94, maxLines: 1 };
  const frame: CaptionFrame = { style: s, words, now: 560_000, rtl: hebrew };
  const op = { caption: frame, transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } };
  const L = layoutCaption(ctx, op, VW, VH);
  ctx.setTransform(k, 0, 0, k, (VW / 2) * k, (VH / 2) * k);
  drawCaption(ctx, op, L, k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function PresetThumb(props: { presetId?: string; style?: CaptionStyle; hebrew: boolean; width?: number; testId?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = props.width ?? 216;
  const style = props.style ?? presetStyle(props.presetId ?? 'karaoke', 1080, 1920);
  const key = JSON.stringify(style);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let live = true;
    drawPresetSample(c, style, props.hebrew);
    // redraw once the bundled fonts have arrived
    void loadCaptionFonts().then(() => live && ref.current && drawPresetSample(ref.current, style, props.hebrew));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, props.hebrew]);
  return <canvas ref={ref} width={w} height={Math.round(w / 2)} className="cap-thumb" data-testid={props.testId} />;
}
