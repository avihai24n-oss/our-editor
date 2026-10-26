/**
 * Time ruler: adaptive ticks (labels MM:SS, frame ticks `NNf` when zoomed in), marker flags, the
 * In / Out range (./RangeBar) and the playhead handle. Pointer handling (scrub) is done by the Timeline through `onScrubStart`.
 */
import { memo, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { usToPx, pxToUs } from '../model/time';
import type { Marker, Us } from '../model/types';
import { rulerScale, rulerTicks } from './geometry';
import type { TimelineArea } from './uiStore';
import { hasArea } from './range';
import { RangeBar, RangeRulerDim } from './RangeBar';

interface RulerProps {
  zoom: number;
  fps: number;
  width: number;
  viewFrom: number;
  viewTo: number;
  markers: Marker[];
  /** In / out points (I / O, ⇧X). */
  area?: TimelineArea;
  /** Where an open-ended area (in point only) stops: the project end. */
  areaEnd?: Us;
  onScrubStart: (e: RPointerEvent) => void;
  onMarkerClick: (m: Marker, e: RMouseEvent) => void;
  onMarkerRemove: (m: Marker) => void;
}

export const Ruler = memo(function Ruler({ zoom, fps, width, viewFrom, viewTo, markers, area, areaEnd = 0, onScrubStart, onMarkerClick, onMarkerRemove }: RulerProps) {
  const scale = rulerScale(zoom, fps);
  const from: Us = Math.max(0, pxToUs(viewFrom - 100, zoom));
  const to: Us = pxToUs(viewTo + 100, zoom);
  const ticks = rulerTicks(from, to, scale, fps);
  return (
    <div className="tl-ruler" style={{ width }} onPointerDown={onScrubStart} data-testid="timeline-ruler">
      {area && hasArea(area) && <RangeRulerDim area={area} end={areaEnd} zoom={zoom} />}
      {area && hasArea(area) && <RangeBar area={area} end={areaEnd} zoom={zoom} fps={fps} />}
      {ticks.map((t) => (
        <div key={t.t} className={`tl-ruler__tick${t.major ? ' is-major' : ''}`} style={{ left: usToPx(t.t, zoom) }}>
          {t.label && <span className="tl-ruler__label">{t.label}</span>}
        </div>
      ))}
      {markers.map((m) => (
        <button
          type="button"
          key={m.id}
          className="tl-marker"
          style={{ left: usToPx(m.time, zoom), color: m.color }}
          title={`${m.label ?? 'Marker'} — double-click to remove`}
          aria-label="Marker"
          data-testid="timeline-marker"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => onMarkerClick(m, e)}
          onDoubleClick={() => onMarkerRemove(m)}
          onContextMenu={(e) => {
            e.preventDefault();
            onMarkerRemove(m);
          }}
        >
          <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden>
            <path d="M0 0h10v8l-5 4-5-4z" fill="currentColor" />
          </svg>
        </button>
      ))}
    </div>
  );
});
