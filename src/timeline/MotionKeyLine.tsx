/**
 * Motion keyframes on a visual clip (src/model/motionKeys.ts): one diamond per keyframe time
 * (all properties at that time together), along the middle of the clip. Distinct from the volume
 * line's white diamonds: these are accent coloured and sit on their own row.
 * - click a diamond: selects the clip and puts the playhead on it
 * - drag it left / right: moves those keys in time (frame steps, one undo step; Escape cancels)
 * - double-click it: removes the keys at that time
 */
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { MOTION_PROPS, motionKeyTimes, visibleMotionKeys, withKeysMoved, withoutMotionKeyPatch, type MotionClip } from '../model/motionKeys';
import { frameUs, usToPx } from '../model/time';
import type { VisualClip } from '../model/types';
import { useEditor } from '../store';
import './motionKeys.css';

export interface MotionKeyLineProps {
  clip: VisualClip;
  width: number;
  height: number;
  zoom: number;
  selected: boolean;
}

type Drag = { t0: number; x0: number; clip: MotionClip; moved: boolean };

export function MotionKeyLine({ clip, width, height, zoom, selected }: MotionKeyLineProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const c = clip as MotionClip;
  const times = motionKeyTimes(c);
  const all = visibleMotionKeys(c);
  const ed = () => useEditor.getState();
  const fUs = () => frameUs(ed().project.settings.fps);
  const tol = () => fUs() / 2;
  const y = Math.round(height / 2);

  const finish = (cancel: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDrag(null);
    if (cancel || !d.moved) ed().cancelTx();
    else ed().commitTx();
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      finish(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag]);

  const onDown = (e: RPointerEvent<SVGRectElement>, t: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // not a clip move
    const s = ed();
    if (!s.selection.clipIds.includes(clip.id) || s.selection.clipIds.length !== 1) s.select([clip.id], 'replace');
    s.setPlayhead(Math.round(t));
    e.currentTarget.setPointerCapture(e.pointerId);
    s.beginTx();
    const d: Drag = { t0: t, x0: e.clientX, clip: { ...c }, moved: false };
    dragRef.current = d;
    setDrag(d);
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const f = fUs();
    const raw = d.t0 + (dx / zoom) * 1e6;
    const to = Math.min(d.clip.start + d.clip.duration - 1, Math.max(d.clip.start, Math.round(raw / f) * f));
    const s = ed();
    s.updateClip(clip.id, { motionKeys: withKeysMoved(d.clip, d.t0, to, tol(), MOTION_PROPS) });
    s.setPlayhead(Math.round(to));
  };
  const onDouble = (e: RMouseEvent, t: number) => {
    e.stopPropagation();
    ed().updateClip(clip.id, withoutMotionKeyPatch(c, MOTION_PROPS, t, tol()));
  };

  if (!times.length) return null;
  return (
    <svg
      className={`tl-mkeys${selected ? ' is-selected' : ''}${drag ? ' is-dragging' : ''}`}
      width={width}
      height={height}
      data-testid="clip-motion-keys"
      data-keys={times.length}
      onPointerMove={onMove}
      onPointerUp={() => finish(false)}
      onPointerCancel={() => finish(true)}
    >
      {times.map((t) => {
        const props = all.filter((k) => Math.abs(k.t - t) <= 1).map((k) => k.prop);
        return (
          <g key={Math.round(t)} className="tl-mkeys__key" transform={`translate(${usToPx(t - clip.start, zoom)} ${y})`} data-testid="clip-motion-key" data-t={Math.round(t)} data-props={props.join(',')}>
            <title>{`Keyframe: ${props.join(', ')} — click to go there, drag to move, double-click to remove`}</title>
            <rect className="tl-mkeys__hit" x={-7} y={-7} width={14} height={14} onPointerDown={(e) => onDown(e, t)} onDoubleClick={(e) => onDouble(e, t)} />
            <rect className="tl-mkeys__mark" x={-4} y={-4} width={8} height={8} transform="rotate(45)" />
          </g>
        );
      })}
    </svg>
  );
}
