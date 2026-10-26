/**
 * The In / Out range on the ruler (CapCut I / O): a tinted band with a draggable handle at each
 * end, a pill with the range length and a ✕ that clears it (same as ⌥X). The matching light shade
 * over the tracks is <RangeShade>. Handle drags are frame-snapped and snap to the playhead / edit
 * points when timeline snapping is on (hold ⌥ to ignore snapping, like clip drags).
 *
 * The range is view state (timeline/uiStore → store/viewState), not an edit: no undo step.
 */
import { useRef, type PointerEvent as RPointerEvent } from 'react';
import { formatTimecode, pxToUs, usToPx } from '../model/time';
import type { Us } from '../model/types';
import { useEditor } from '../store';
import { snapPoint } from './gestures';
import { resolveArea, type TimelineArea } from './range';
import { useTimelineUi } from './uiStore';

interface RangeBarProps {
  area: TimelineArea;
  /** The timeline end (where an open "in only" range stops). */
  end: Us;
  zoom: number;
  fps: number;
}

/** Range length for the pill: MM:SS:FF (HH:MM:SS:FF past an hour). */
const shortLength = (us: Us, fps: number): string => {
  const tc = formatTimecode(us, fps);
  return us < 3600e6 ? tc.slice(3) : tc;
};

/** [a, b] drawn for an area: open ends reach 0 / the timeline end. */
function drawnSpan(area: TimelineArea, end: Us): [Us, Us] {
  const a = area.in ?? 0;
  const b = area.out ?? Math.max(end, a);
  return [a, Math.max(a, b)];
}

export function RangeBar({ area, end, zoom, fps }: RangeBarProps) {
  const drag = useRef<{ edge: 'in' | 'out'; pointerId: number; ruler: HTMLElement } | null>(null);
  const [a, b] = drawnSpan(area, end);
  const r = resolveArea(area, Math.max(end, b));
  const len = r ? r.to - r.from : 0;

  const onHandleDown = (edge: 'in' | 'out') => (e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // not a ruler scrub
    e.preventDefault();
    const ruler = e.currentTarget.closest<HTMLElement>('.tl-ruler');
    if (!ruler) return;
    useEditor.getState().pause();
    drag.current = { edge, pointerId: e.pointerId, ruler };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHandleMove = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const s = useEditor.getState();
    const raw = pxToUs(e.clientX - d.ruler.getBoundingClientRect().left, s.zoom);
    const sn = snapPoint(s.project, s.playhead, raw, s.zoom, s.snapping && !e.altKey);
    useTimelineUi.getState().moveAreaEdge(d.edge, sn.value, fps);
  };
  const onHandleUp = (e: RPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const handle = (edge: 'in' | 'out') => (
    <span
      className={`tl-area__${edge}${area[edge] === null ? ' is-open' : ''}`}
      data-testid={`timeline-area-${edge}`}
      data-set={area[edge] !== null ? 'true' : 'false'}
      title={edge === 'in' ? 'In point (I) — drag to move' : 'Out point (O) — drag to move'}
      onPointerDown={onHandleDown(edge)}
      onPointerMove={onHandleMove}
      onPointerUp={onHandleUp}
      onPointerCancel={onHandleUp}
      onLostPointerCapture={() => (drag.current = null)}
    />
  );

  return (
    <div
      className="tl-area"
      style={{ left: usToPx(a, zoom), width: Math.max(1, usToPx(b - a, zoom)) }}
      data-testid="timeline-area"
      data-in={area.in ?? ''}
      data-out={area.out ?? ''}
    >
      {handle('in')}
      {handle('out')}
      <span className="tl-area__pill" data-testid="timeline-area-label" onPointerDown={(e) => e.stopPropagation()}>
        <span className="tl-area__len" title={`In–Out length ${formatTimecode(len, fps)}`}>{shortLength(len, fps)}</span>
        <button
          type="button"
          className="tl-area__clear"
          title="Clear in / out (⌥X)"
          aria-label="Clear in / out"
          data-testid="timeline-area-clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useTimelineUi.getState().clearArea()}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
            <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </span>
    </div>
  );
}

/** The range's light shade over the tracks (lane coordinates + the header offset). */
export function RangeShade({ area, end, zoom, offset }: { area: TimelineArea; end: Us; zoom: number; offset: number }) {
  const [a, b] = drawnSpan(area, end);
  return <div className="tl-area-shade" data-testid="timeline-area-shade" style={{ left: offset + usToPx(a, zoom), width: Math.max(1, usToPx(b - a, zoom)) }} />;
}
