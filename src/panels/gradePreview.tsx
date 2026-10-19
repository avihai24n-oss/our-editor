/**
 * Library tile previews rendered through the real colour pipeline (engine/color, CPU path — the
 * same maths as the WebGL shader) instead of a CSS approximation. A tile grades a small copy of
 * the selected clip's thumbnail, or a built-in sample scene when nothing is selected.
 */
import { useEffect, useState } from 'react';
import { gradeImageData } from '../engine/color/grader';
import { getLoadedLut } from '../engine/color/lutLibrary';
import { gradeParams } from '../engine/color/params';
import type { ColorOps } from '../engine/frameState';
import { filterDef } from '../model/catalog';
import { defaultAdjust, defaultGrade } from '../model/defaults';
import type { Adjust, ColorGrade, FilterId } from '../model/types';

const TW = 120;
const TH = 68;

/** ColorOps for a Filters look at full intensity. */
export function filterOps(id: FilterId | null): ColorOps {
  const f = id ? filterDef(id) : undefined;
  const out: ColorOps = { ...defaultAdjust(), grayscale: f?.grayscale ?? 0, sepia: f?.sepia ?? 0, grade: defaultGrade() };
  if (f) for (const [k, v] of Object.entries(f.adjust) as [keyof Adjust, number][]) out[k] += v;
  return out;
}

/** ColorOps for an adjustment (preset): Adjust values + optional grade sections. */
export function adjustOps(adjust: Partial<Adjust>, grade?: Partial<ColorGrade>, extra: { grayscale?: number; sepia?: number } = {}): ColorOps {
  return { ...defaultAdjust(), ...adjust, grayscale: extra.grayscale ?? 0, sepia: extra.sepia ?? 0, grade: { ...defaultGrade(), ...(grade ?? {}) } };
}

function sceneCanvas(): HTMLCanvasElement | null {
  if (noCanvas()) return null;
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const sky = ctx.createLinearGradient(0, 0, 0, TH);
  sky.addColorStop(0, '#6fa8dc');
  sky.addColorStop(0.55, '#f6c27a');
  sky.addColorStop(1, '#3d6b3a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, TW, TH);
  ctx.fillStyle = '#e8b48f'; // skin-ish
  ctx.beginPath();
  ctx.arc(TW * 0.3, TH * 0.55, TH * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d9483b';
  ctx.fillRect(TW * 0.55, TH * 0.45, TW * 0.14, TH * 0.4);
  ctx.fillStyle = '#2f6bff';
  ctx.fillRect(TW * 0.72, TH * 0.55, TW * 0.14, TH * 0.3);
  return c;
}

const cache = new Map<string, string>();
const images = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    images.set(src, p);
    if (images.size > 32) images.delete(images.keys().next().value as string);
  }
  return p;
}

const noCanvas = () => typeof document === 'undefined' || (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent));

async function render(src: string | undefined, ops: ColorOps): Promise<string | null> {
  if (noCanvas()) return null;
  const c = document.createElement('canvas');
  c.width = TW;
  c.height = TH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const img = src ? await loadImage(src) : null;
  if (img) {
    // cover-fit
    const k = Math.max(TW / img.naturalWidth, TH / img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    ctx.drawImage(img, (TW - w) / 2, (TH - h) / 2, w, h);
  } else {
    const s = sceneCanvas();
    if (s) ctx.drawImage(s, 0, 0);
  }
  const params = gradeParams(ops, 0, (id) => !!getLoadedLut(id));
  if (params) {
    const data = ctx.getImageData(0, 0, TW, TH);
    gradeImageData(data.data, TW, TH, params, TW / TH, params.lut ? getLoadedLut(params.lut.id) : null);
    ctx.putImageData(data, 0, 0);
  }
  return c.toDataURL('image/jpeg', 0.85);
}

/** Data URL of the graded preview (null while it renders). */
export function useGradedPreview(src: string | undefined, ops: ColorOps): string | null {
  const key = `${src ?? 'scene'}|${JSON.stringify(ops)}`;
  const [url, setUrl] = useState<string | null>(() => cache.get(key) ?? null);
  useEffect(() => {
    const hit = cache.get(key);
    if (hit) {
      setUrl(hit);
      return;
    }
    let live = true;
    void render(src, ops).then((u) => {
      if (!u) return;
      if (cache.size > 200) cache.delete(cache.keys().next().value as string);
      cache.set(key, u);
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}

export function GradedLook({ src, ops, none }: { src?: string; ops: ColorOps; none?: boolean }) {
  const url = useGradedPreview(src, ops);
  return (
    <div className="look">
      {url ? <img src={url} alt="" draggable={false} /> : <div className="look__scene" />}
      {none && (
        <div className="look__none" aria-hidden>
          ⊘
        </div>
      )}
    </div>
  );
}
