/**
 * Adjust › Curves: Luma (master) + Red / Green / Blue tone curves.
 * - Click the graph to add a point (and keep dragging it); drag points; double-click a point
 *   (not an end point) to remove it, or drag it far out of the graph.
 * - End points stay at x = 0 / 1 and move vertically (drag black to the top and white to the
 *   bottom to invert).
 * - The curve shown is the same monotone cubic the renderer bakes (engine/color/curves.ts).
 * One drag = one undo step.
 */
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { monotoneCurve, isIdentityCurve } from '../../../engine/color/curves';
import { defaultCurves, identityCurve } from '../../../model/defaults';
import type { CurveChannel, CurvePoint, VisualClip } from '../../../model/types';
import { useEditor } from '../../../store';
import { usePref } from '../../../panels/prefs';
import { Section, startPointerGesture } from '../../controls';

const CHANNELS: { id: CurveChannel; label: string; color: string }[] = [
  { id: 'master', label: 'Luma', color: '#ffffff' },
  { id: 'red', label: 'Red', color: '#ff4b4b' },
  { id: 'green', label: 'Green', color: '#3ddc6a' },
  { id: 'blue', label: 'Blue', color: '#4b8bff' },
];

const S = 256; // svg units
const MIN_GAP = 0.02;
const HIT = 0.05; // fraction of the graph
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function CurvesPanel({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const curves = clip.grade.curves;
  const [ch, setCh] = usePref<CurveChannel>('insp.adjust.curve', 'master');
  const channel = CHANNELS.find((c) => c.id === ch) ?? CHANNELS[0]!;
  const points = curves[channel.id];
  const setPoints = (pts: CurvePoint[]) => updateClip(clip.id, { grade: { curves: { ...curves, [channel.id]: pts } } });
  const allIdentity = CHANNELS.every((c) => isIdentityCurve(curves[c.id]));

  return (
    <Section
      id="curves"
      title="Curves"
      checked={curves.enabled}
      onCheck={(on) => updateClip(clip.id, { grade: { curves: { ...curves, enabled: on } } })}
      resetDisabled={allIdentity}
      onReset={() => updateClip(clip.id, { grade: { curves: defaultCurves() } })}
    >
      <div className="icurve__bar">
        <div className="icurve__channels" role="radiogroup" aria-label="Curve channel">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === channel.id}
              aria-label={c.label}
              title={c.label}
              data-testid={`curve-ch-${c.id}`}
              className={`icurve__ch${c.id === channel.id ? ' is-active' : ''}${isIdentityCurve(curves[c.id]) ? '' : ' is-changed'}`}
              style={{ background: c.color }}
              onClick={() => setCh(c.id)}
            />
          ))}
        </div>
        <span className="icurve__name">{channel.label}</span>
        <button type="button" className="link-btn" disabled={isIdentityCurve(points)} onClick={() => setPoints(identityCurve())} data-testid="curve-reset-channel">
          Reset {channel.label.toLowerCase()}
        </button>
      </div>
      <CurveEditor points={points} color={channel.color} onChange={setPoints} />
      <p className="ihint">Click to add a point · drag to shape · double-click a point to remove it</p>
    </Section>
  );
}

export function CurveEditor(props: { points: CurvePoint[]; color: string; onChange: (pts: CurvePoint[]) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const pts = props.points;
  const f = monotoneCurve(pts);
  const path = Array.from({ length: 129 }, (_, i) => {
    const x = i / 128;
    return `${i ? 'L' : 'M'}${(x * S).toFixed(2)},${((1 - clamp01(f(x))) * S).toFixed(2)}`;
  }).join(' ');

  const toUnit = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
  };

  const moveTo = (index: number, u: { x: number; y: number }, list: CurvePoint[]) => {
    const next = list.map((p) => ({ ...p }));
    const last = next.length - 1;
    // dragged far outside the graph: remove an interior point
    if (index > 0 && index < last && (u.y < -0.15 || u.y > 1.15)) {
      next.splice(index, 1);
      return { list: next, index: null as number | null };
    }
    const y = clamp01(u.y);
    if (index === 0) next[0] = { x: 0, y };
    else if (index === last) next[last] = { x: 1, y };
    else next[index] = { x: Math.min(next[index + 1]!.x - MIN_GAP, Math.max(next[index - 1]!.x + MIN_GAP, clamp01(u.x))), y };
    return { list: next, index: index as number | null };
  };

  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const u = toUnit(e);
    let index = pts.findIndex((p) => Math.hypot(p.x - u.x, p.y - u.y) < HIT);
    let list = pts;
    startPointerGesture();
    if (index < 0) {
      const x = clamp01(u.x);
      if (x <= MIN_GAP || x >= 1 - MIN_GAP) return;
      if (pts.some((p) => Math.abs(p.x - x) < MIN_GAP)) return;
      list = [...pts, { x, y: clamp01(u.y) }].sort((a, b) => a.x - b.x);
      index = list.findIndex((p) => p.x === x);
      props.onChange(list);
    }
    svgRef.current?.setPointerCapture(e.pointerId);
    setDrag(index);
    let cur = list;
    let idx: number | null = index;
    const onMove = (ev: PointerEvent) => {
      if (idx === null) return;
      const r = moveTo(idx, toUnit(ev), cur);
      cur = r.list;
      idx = r.index;
      props.onChange(cur);
      if (idx === null) setDrag(null);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const u = toUnit(e);
    const i = pts.findIndex((p) => Math.hypot(p.x - u.x, p.y - u.y) < HIT);
    if (i > 0 && i < pts.length - 1) props.onChange(pts.filter((_, k) => k !== i));
  };

  return (
    <div className="icurve">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${S} ${S}`}
        className="icurve__svg"
        data-testid="curve-editor"
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        role="img"
        aria-label="Tone curve"
      >
        {[1, 2, 3].map((i) => (
          <g key={i} className="icurve__grid">
            <line x1={(i * S) / 4} y1={0} x2={(i * S) / 4} y2={S} />
            <line x1={0} y1={(i * S) / 4} x2={S} y2={(i * S) / 4} />
          </g>
        ))}
        <line className="icurve__diag" x1={0} y1={S} x2={S} y2={0} />
        <path d={path} className="icurve__path" style={{ stroke: props.color }} data-testid="curve-path" />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.x * S}
            cy={(1 - p.y) * S}
            r={drag === i ? 7 : 5.5}
            className={`icurve__pt${drag === i ? ' is-drag' : ''}`}
            style={{ stroke: props.color }}
            data-testid="curve-point"
            data-x={p.x.toFixed(3)}
            data-y={p.y.toFixed(3)}
          />
        ))}
      </svg>
    </div>
  );
}
