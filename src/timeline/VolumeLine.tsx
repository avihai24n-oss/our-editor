/**
 * CapCut's volume line: a line across a clip that has sound. Drag it up or down to set the clip's
 * volume without opening Audio › Basic. One drag = one undo step; Escape cancels.
 *
 * At rest (100 %, the original level) the line sits a third of the way up, leaving the top two
 * thirds for boost:
 *   bottom third      0 → 100 %, linear gain (50 % ≈ -6 dB, 0 % = -∞)
 *   top two thirds    0 → +20 dB (the inspector's max = 1000 %), linear in dB
 *
 * Volume keyframes (src/model/volumeKeys.ts) draw as diamonds and the line follows their envelope:
 * - drag a diamond up/down: that key's volume; click it: the playhead jumps to it; double-click: remove it
 * - drag the line: every key moves by the same amount
 * - double-click the line: adds a keyframe there (no keyframes yet: back to 100 %)
 */
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { LIMITS } from '../model/catalog';
import { usToPx } from '../model/time';
import type { AudioClip, VideoClip, VolumeKey } from '../model/types';
import { clipVolumeDbAt, hasVolumeKeys, shiftKeys, visibleKeys, withKeyAt, withoutKeyAt } from '../model/volumeKeys';
import { useEditor } from '../store';

/** Line inset from the clip's top and bottom edge, px. */
const PAD = 4;
/** Sampling step of a keyframed line, px. */
const STEP = 3;

/** Height share (from the bottom) of the 0–100 % range; the rest above it is boost. */
export const UNITY = 1 / 3;

/** Linear gain in percent (100 % = 0 dB). */
export const dbToPct = (db: number): number => (db <= LIMITS.volumeDbMin ? 0 : Math.pow(10, db / 20) * 100);

export function pctToDb(pct: number): number {
  if (pct <= 0) return LIMITS.volumeDbMin;
  const db = 20 * Math.log10(Math.min(100, pct) / 100);
  return Math.max(LIMITS.volumeDbMin, Math.round(db * 10) / 10);
}

/** Line position 0 (bottom) … 1 (top) → volume dB. */
export function posToDb(pos: number): number {
  const f = Math.max(0, Math.min(1, pos));
  if (f <= UNITY) return pctToDb(Math.round((f / UNITY) * 100));
  return Math.round(((f - UNITY) / (1 - UNITY)) * LIMITS.volumeDbMax * 10) / 10;
}

/** Volume dB → line position 0 (bottom) … 1 (top). */
export function dbToPos(db: number): number {
  if (db <= 0) return (dbToPct(db) / 100) * UNITY;
  return UNITY + (Math.min(db, LIMITS.volumeDbMax) / LIMITS.volumeDbMax) * (1 - UNITY);
}

export const volumeLabel = (db: number): string => `${Math.round(dbToPct(db))}%`;

const dbText = (db: number): string => `${db > 0 ? '+' : ''}${db <= LIMITS.volumeDbMin ? '-∞' : db.toFixed(1)}dB`;

type Drag = { kind: 'line'; grabDb: number; keys: VolumeKey[] | null; x: number } | { kind: 'key'; index: number; x: number };

export interface VolumeLineProps {
  clip: VideoClip | AudioClip;
  width: number;
  height: number;
  zoom: number;
  /** Visible window, clip px (only that part of a keyframed line is drawn). */
  fromPx: number;
  toPx: number;
}

export function VolumeLine({ clip, width, height, zoom, fromPx, toPx }: VolumeLineProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ x: number; db: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const a = clip.audio;
  const keyed = hasVolumeKeys(a);
  const span = Math.max(1, height - PAD * 2);
  const yOf = (db: number) => PAD + (1 - dbToPos(db)) * span;
  const dbAtY = (clientY: number) => {
    const r = svg.current?.getBoundingClientRect();
    return r ? posToDb(1 - (clientY - r.top - PAD) / span) : 0;
  };
  const xOf = (clientX: number) => clientX - (svg.current?.getBoundingClientRect().left ?? 0);
  const tAtX = (x: number) => clip.start + Math.round((Math.max(0, Math.min(width, x)) / zoom) * 1e6);
  const dbAtX = (x: number) => clipVolumeDbAt(clip, Math.min(clip.start + clip.duration - 1, tAtX(x)));

  // the line: flat, or the keyframe envelope sampled over the visible part
  let d: string;
  if (!keyed) d = `M0 ${yOf(a.volumeDb)} H${width}`;
  else {
    const x0 = Math.max(0, Math.floor(fromPx) - 50);
    const x1 = Math.min(width, Math.ceil(toPx) + 50);
    const pts: string[] = [];
    for (let x = x0; x < x1; x += STEP) pts.push(`${x} ${yOf(dbAtX(x)).toFixed(1)}`);
    pts.push(`${x1} ${yOf(dbAtX(x1)).toFixed(1)}`);
    d = `M${pts.join(' L')}`;
  }
  const keys = keyed ? visibleKeys(clip) : [];

  const ed = () => useEditor.getState();
  const begin = (e: RPointerEvent<Element>, next: Drag): boolean => {
    if (e.button !== 0) return false;
    e.preventDefault();
    e.stopPropagation(); // not a clip move
    e.currentTarget.setPointerCapture(e.pointerId); // moves bubble up to the <svg>
    ed().beginTx();
    setDrag(next);
    return true;
  };

  const onLineDown = (e: RPointerEvent<SVGPathElement>) => {
    const x = xOf(e.clientX);
    begin(e, { kind: 'line', grabDb: keyed ? dbAtX(x) : a.volumeDb, keys: keyed ? a.volumeKeys! : null, x });
  };
  const onKeyDown = (e: RPointerEvent<SVGRectElement>, index: number, t: number) => {
    if (begin(e, { kind: 'key', index, x: usToPx(t - clip.start, zoom) })) ed().setPlayhead(Math.round(t));
  };

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drag) {
      const x = xOf(e.clientX);
      setHover({ x, db: keyed ? dbAtX(x) : a.volumeDb });
      return;
    }
    const db = dbAtY(e.clientY);
    if (drag.kind === 'line' && !drag.keys) {
      if (db !== a.volumeDb) ed().updateClip(clip.id, { audio: { volumeDb: db } });
    } else if (drag.kind === 'line' && drag.keys) {
      ed().updateClip(clip.id, { audio: { volumeKeys: shiftKeys(drag.keys, db - drag.grabDb) } });
    } else if (drag.kind === 'key') {
      const cur = a.volumeKeys?.[drag.index];
      if (cur && cur.db !== db) ed().updateClip(clip.id, { audio: { volumeKeys: a.volumeKeys!.map((k, i) => (i === drag.index ? { src: k.src, db } : k)) } });
    }
  };
  const end = (cancel: boolean) => {
    if (!drag) return;
    setDrag(null);
    if (cancel) ed().cancelTx();
    else ed().commitTx();
  };

  // Escape while dragging puts the volume back (capture phase: before the timeline's own keys)
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setDrag(null);
      useEditor.getState().cancelTx();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag]);

  const tol = () => 1e6 / ed().project.settings.fps / 2;
  const onLineDouble = (e: RMouseEvent) => {
    e.stopPropagation();
    if (!keyed) ed().updateClip(clip.id, { audio: { volumeDb: 0 } });
    else {
      const t = Math.min(clip.start + clip.duration - 1, tAtX(xOf(e.clientX)));
      ed().updateClip(clip.id, { audio: { volumeKeys: withKeyAt(clip, t, clipVolumeDbAt(clip, t), tol()) } });
    }
  };
  const onKeyDouble = (e: RMouseEvent, t: number) => {
    e.stopPropagation();
    const at = Math.round(t);
    const rest = withoutKeyAt(clip, at, tol());
    ed().updateClip(clip.id, { audio: rest ? { volumeKeys: rest } : { volumeKeys: undefined, volumeDb: clipVolumeDbAt(clip, at) } });
  };

  // label: the dragged key / the line where it was grabbed / under the pointer
  const label =
    drag?.kind === 'key'
      ? { x: drag.x, db: a.volumeKeys?.[drag.index]?.db ?? 0 }
      : drag?.kind === 'line'
        ? { x: drag.x, db: keyed ? dbAtX(drag.x) : a.volumeDb }
        : hover;

  return (
    <svg
      ref={svg}
      className={`tl-vol${drag ? ' is-dragging' : ''}${a.muted ? ' is-muted' : ''}${keyed ? ' is-keyed' : ''}`}
      width={width}
      height={height}
      data-testid="clip-volume-line"
      data-keys={keys.length}
      data-volume-db={a.volumeDb}
      onPointerMove={onMove}
      onPointerUp={() => end(false)}
      onPointerCancel={() => end(true)}
    >
      <title>
        {keyed
          ? `Volume keyframes (${keys.length}) — drag a diamond up/down, drag the line to move them all, double-click the line to add one`
          : `Volume ${volumeLabel(a.volumeDb)} (${dbText(a.volumeDb)}) — drag up/down, double-click for 100%`}
      </title>
      <path className="tl-vol__hit" d={d} onPointerDown={onLineDown} onPointerLeave={() => setHover(null)} onDoubleClick={onLineDouble} data-testid="clip-volume-hit" />
      <path className="tl-vol__line" d={d} />
      {keys.map(({ key, index, t }) => (
        <g key={key.src} className="tl-vol__key" transform={`translate(${usToPx(t - clip.start, zoom)} ${yOf(key.db)})`} data-testid="clip-volume-key" data-db={key.db}>
          <rect className="tl-vol__key-hit" x={-7} y={-7} width={14} height={14} onPointerDown={(e) => onKeyDown(e, index, t)} onDoubleClick={(e) => onKeyDouble(e, t)} />
          <rect className="tl-vol__key-mark" x={-3.5} y={-3.5} width={7} height={7} transform="rotate(45)" />
        </g>
      ))}
      {label && (
        <foreignObject x={Math.max(0, Math.min(width - 48, label.x + 8))} y={Math.max(0, Math.min(height - 16, yOf(label.db) - 18))} width={48} height={16}>
          <span className="tl-vol__label" data-testid="clip-volume-label">
            {volumeLabel(label.db)}
          </span>
        </foreignObject>
      )}
    </svg>
  );
}
