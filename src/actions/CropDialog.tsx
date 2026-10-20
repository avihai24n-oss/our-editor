/**
 * Edit › Crop dialog: the clip's source frame with a crop rectangle (drag to move, corner handles
 * to resize) and CapCut's ratio presets. Apply writes `clip.crop` as ONE undo step; the renderer
 * (engine/render) already crops in the player and the export.
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { create } from 'zustand';
import { findClip } from '../model/project';
import { clipContains } from '../model/time';
import type { Crop, Id } from '../model/types';
import { useEditor } from '../store';
import { getBlob } from '../store/persistence';
import { Button, Modal } from '../ui/controls';
import { captureClipFrame } from './editMenu';
import { setCrop } from './editOps';
import './crop.css';

/** CapCut's crop ratios (docs/research/08-context-edit-menu.md). null = Free. */
export const CROP_PRESETS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
];

/** Rect in source fractions. */
export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rectToCrop = (r: FracRect): Crop => ({ left: r.x, top: r.y, right: 1 - r.x - r.w, bottom: 1 - r.y - r.h });
export const cropToRect = (c: Crop): FracRect => ({ x: c.left, y: c.top, w: 1 - c.left - c.right, h: 1 - c.top - c.bottom });

/** The largest centred rect of `ratio` (width / height, in pixels) inside a srcW × srcH source. */
export function presetRect(ratio: number, srcW: number, srcH: number): FracRect {
  const srcRatio = srcW / srcH;
  if (ratio >= srcRatio) {
    const h = srcRatio / ratio;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = ratio / srcRatio;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

const MAX_W = 560;
const MAX_H = 380;
const MIN_FRAC = 0.05;

function CropDialog({ clipId, onClose }: { clipId: Id; onClose: () => void }) {
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null);
  const clip = findClip(useEditor.getState().project, clipId)?.clip;
  const initial = clip && clip.type !== 'audio' && clip.type !== 'text' ? cropToRect(clip.crop) : { x: 0, y: 0, w: 1, h: 1 };
  const [rect, setRect] = useState<FracRect>(initial);
  const [preset, setPreset] = useState<string>('free');
  const drag = useRef<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; px: number; py: number; start: FracRect } | null>(null);

  useEffect(() => {
    let url = '';
    let alive = true;
    void (async () => {
      const st = useEditor.getState();
      const c = findClip(st.project, clipId)?.clip;
      if (!c) return;
      let blob: Blob | null = null;
      if (c.type === 'video') {
        const t = clipContains(c, st.playhead) ? st.playhead : c.start;
        blob = await captureClipFrame(st.project, clipId, t);
      } else if (c.type === 'image') {
        const a = st.project.assets[c.assetId];
        blob = a ? await getBlob(a.blobKey).catch(() => null) : null;
      }
      if (!blob || !alive) return;
      url = URL.createObjectURL(blob);
      const bmp = await createImageBitmap(blob);
      if (alive) setImg({ url, w: bmp.width, h: bmp.height });
      bmp.close();
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [clipId]);

  const srcW = img?.w ?? 16;
  const srcH = img?.h ?? 9;
  const k = Math.min(MAX_W / srcW, MAX_H / srcH);
  const boxW = Math.round(srcW * k);
  const boxH = Math.round(srcH * k);
  const ratio = CROP_PRESETS.find((p) => p.id === preset)?.ratio ?? null;

  const onDown = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: RPointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode, px: e.clientX, py: e.clientY, start: rect };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.px) / boxW;
    const dy = (e.clientY - d.py) / boxH;
    const s = d.start;
    if (d.mode === 'move') {
      setRect({ ...s, x: Math.min(1 - s.w, Math.max(0, s.x + dx)), y: Math.min(1 - s.h, Math.max(0, s.y + dy)) });
      return;
    }
    const west = d.mode === 'nw' || d.mode === 'sw';
    const north = d.mode === 'nw' || d.mode === 'ne';
    const right = s.x + s.w;
    const bottom = s.y + s.h;
    let w = Math.max(MIN_FRAC, Math.min(west ? right : 1 - s.x, s.w + (west ? -dx : dx)));
    let h = Math.max(MIN_FRAC, Math.min(north ? bottom : 1 - s.y, s.h + (north ? -dy : dy)));
    if (ratio) {
      // keep the pixel ratio: h = w × srcW / (ratio × srcH), shrinking w when h does not fit
      const hFor = (ww: number) => (ww * srcW) / (ratio * srcH);
      const maxH = north ? bottom : 1 - s.y;
      h = hFor(w);
      if (h > maxH) {
        h = maxH;
        w = (h * ratio * srcH) / srcW;
      }
    }
    setRect({ x: west ? right - w : s.x, y: north ? bottom - h : s.y, w, h });
  };
  const onUp = () => {
    drag.current = null;
  };

  const choose = (id: string) => {
    setPreset(id);
    const r = CROP_PRESETS.find((p) => p.id === id)?.ratio;
    if (r) setRect(presetRect(r, srcW, srcH));
  };
  const apply = () => {
    useEditor.getState().editProject((d) => setCrop(d, [clipId], rectToCrop(rect)));
    onClose();
  };

  const pct = (v: number) => `${v * 100}%`;
  return (
    <Modal
      title="Crop"
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => { setPreset('free'); setRect({ x: 0, y: 0, w: 1, h: 1 }); }}>Reset</Button>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>Cancel</Button>
          <button type="button" className="btn btn--primary" onClick={apply} data-testid="crop-apply">
            Confirm
          </button>
        </>
      }
    >
      <div className="crop-dlg" data-testid="crop-dialog">
        <div className="crop-dlg__ratios" role="radiogroup" aria-label="Ratio">
          {CROP_PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className={preset === p.id ? 'is-on' : ''} onClick={() => choose(p.id)} data-testid={`crop-ratio-${p.id}`}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="crop-dlg__stage" style={{ width: boxW, height: boxH }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {img ? <img src={img.url} alt="" draggable={false} /> : <div className="crop-dlg__loading">Loading frame…</div>}
          <div className="crop-dlg__rect" style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }} onPointerDown={onDown('move')} data-testid="crop-rect">
            {(['nw', 'ne', 'sw', 'se'] as const).map((m) => (
              <span key={m} className={`crop-dlg__h crop-dlg__h--${m}`} onPointerDown={onDown(m)} />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Which clip the Crop dialog is open for (null = closed). Mounted once in App.tsx. */
const useCropDialog = create<{ clipId: Id | null }>(() => ({ clipId: null }));

export function closeCropDialog(): void {
  useCropDialog.setState({ clipId: null });
}

export function openCropDialog(clipId: Id): void {
  useCropDialog.setState({ clipId });
}

/** App-level host: renders the dialog while one is open (keyed by clip so it remounts fresh). */
export function CropDialogHost() {
  const clipId = useCropDialog((s) => s.clipId);
  return clipId ? <CropDialog key={clipId} clipId={clipId} onClose={closeCropDialog} /> : null;
}
