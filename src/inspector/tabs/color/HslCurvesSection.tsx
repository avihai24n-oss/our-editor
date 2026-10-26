/**
 * Adjust › Color › HSL curves (DaVinci Resolve): Hue vs Hue, Hue vs Sat, Hue vs Lum, Lum vs Sat,
 * Sat vs Sat. The middle line is neutral. Click the graph to add a point on the curve and drag it;
 * drag points; double-click (or drag far up / down out of the graph) to remove. Hue curves wrap
 * around and have swatches that drop a point on each primary / secondary hue. The curve drawn is
 * the same one the renderer bakes (engine/color/hslCurves.ts). One drag = one undo step.
 */
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { hslCurveFn, isFlatCurve } from '../../../engine/color/hslCurves';
import { defaultHslCurves, type HslCurveId, type HslCurvesSettings } from '../../../model/colorPage';
import type { CurvePoint, VisualClip } from '../../../model/types';
import { usePref } from '../../../panels/prefs';
import { SegmentedTabs, Section, startPointerGesture } from '../../controls';
import { useSetColorPage } from './common';

const CURVES: { id: HslCurveId; label: string; periodic: boolean; x: 'hue' | 'lum' | 'sat'; y: 'hue' | 'sat' | 'lum' }[] = [
  { id: 'hueHue', label: 'Hue vs Hue', periodic: true, x: 'hue', y: 'hue' },
  { id: 'hueSat', label: 'Hue vs Sat', periodic: true, x: 'hue', y: 'sat' },
  { id: 'hueLum', label: 'Hue vs Lum', periodic: true, x: 'hue', y: 'lum' },
  { id: 'lumSat', label: 'Lum vs Sat', periodic: false, x: 'lum', y: 'sat' },
  { id: 'satSat', label: 'Sat vs Sat', periodic: false, x: 'sat', y: 'sat' },
];

const HUE_BG = `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, i) => `hsl(${i * 30} 85% 50%) ${(i / 12) * 100}%`).join(', ')})`;
const BG = { hue: HUE_BG, lum: 'linear-gradient(90deg, #000, #fff)', sat: 'linear-gradient(90deg, #808080, hsl(0 90% 50%))' };
const SWATCHES = [0, 60, 120, 180, 240, 300];

/** Human readout of a point. */
function pointText(c: (typeof CURVES)[number], p: CurvePoint): string {
  const x = c.x === 'hue' ? `${Math.round(p.x * 360)}°` : `${Math.round(p.x * 100)}%`;
  const d = p.y - 0.5;
  const y = c.y === 'hue' ? `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 360))}°` : c.y === 'sat' ? `sat ×${(2 * p.y).toFixed(2)}` : `lum ×${Math.pow(2, 2 * p.y - 1).toFixed(2)}`;
  return `${x} → ${y}`;
}

export function HslCurvesSection({ clip }: { clip: VisualClip }) {
  const set = useSetColorPage(clip);
  const hc = clip.grade.color.hslCurves;
  const [id, setId] = usePref<HslCurveId>('insp.color.hslCurve', 'hueSat');
  const cur = CURVES.find((c) => c.id === id) ?? CURVES[1]!;
  const setC = (patch: Partial<HslCurvesSettings>) => set({ hslCurves: { ...hc, ...patch } });
  const allFlat = CURVES.every((c) => isFlatCurve(hc[c.id]));
  const pts = hc[cur.id];
  const f = hslCurveFn(pts, cur.periodic);
  const addAt = (hx: number) => {
    const x = Math.round(hx * 1000) / 1000;
    if (pts.some((p) => Math.abs(p.x - x) < 0.01)) return;
    startPointerGesture();
    setC({ [cur.id]: addPoint(pts, x, Math.round(f(x) * 1000) / 1000, cur.periodic) });
  };
  return (
    <Section id="color-hslcurves" title="HSL curves" checked={hc.enabled} onCheck={(on) => setC({ enabled: on })} resetDisabled={allFlat} onReset={() => setC({ ...defaultHslCurves(), enabled: hc.enabled })}>
      <SegmentedTabs
        items={CURVES.map((c) => ({ id: c.id, label: c.label.replace(' vs ', '·'), title: c.label, dot: !isFlatCurve(hc[c.id]) }))}
        value={cur.id}
        onChange={setId}
        label="HSL curve"
      />
      <div className="icurve__bar">
        <span className="icurve__name">{cur.label}</span>
        <button type="button" className="link-btn" disabled={!pts.length} onClick={() => setC({ [cur.id]: [] })} data-testid="hslcurve-reset">
          Reset curve
        </button>
      </div>
      <HslCurveEditor key={cur.id} curve={cur} points={pts} onChange={(p) => setC({ [cur.id]: p })} />
      {cur.periodic && (
        <div className="icolor-swatches">
          {SWATCHES.map((h) => (
            <button
              key={h}
              type="button"
              className="icolor-swatch"
              style={{ background: `hsl(${h} 85% 50%)` }}
              title={`Add a point at ${h}°`}
              aria-label={`Add a point at ${h}°`}
              onClick={() => addAt(h / 360)}
              data-testid={`hslcurve-swatch-${h}`}
            />
          ))}
        </div>
      )}
      <p className="ihint">Click to add a point · drag to shape · double-click a point to remove it</p>
    </Section>
  );
}

/** Hue-curve anchors sit this far (30°) either side of a new point. */
const ANCHOR = 1 / 12;

/**
 * Adds a point at x (sorted). Like Resolve, the first point on a part of a curve brings neutral
 * anchors so it acts locally: hue curves get one 30° to either side (wrapping) unless a point is
 * already that close; Lum / Sat curves get their two end points when they are empty.
 */
export function addPoint(list: readonly CurvePoint[], x: number, y: number, periodic: boolean): CurvePoint[] {
  const out = [...list, { x, y }];
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  if (periodic) {
    const dist = (a: number, b: number) => Math.abs(((a - b + 1.5) % 1) - 0.5);
    for (const side of [-1, 1]) {
      const ax = r3((((x + side * ANCHOR) % 1) + 1) % 1);
      const covered = list.some((p) => dist(p.x, x) <= ANCHOR + 1e-6 && Math.sign(((p.x - x + 1.5) % 1) - 0.5) === side);
      if (!covered) out.push({ x: ax, y: 0.5 });
    }
  } else if (!list.length) {
    if (x > 0.01) out.push({ x: 0, y: 0.5 });
    if (x < 0.99) out.push({ x: 1, y: 0.5 });
  }
  return out.sort((a, b) => a.x - b.x);
}

const SW = 256;
const SH = 160;
const HIT = 0.05;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function HslCurveEditor(props: { curve: (typeof CURVES)[number]; points: CurvePoint[]; onChange: (p: CurvePoint[]) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const { curve, points } = props;
  const f = hslCurveFn(points, curve.periodic);
  const path = Array.from({ length: 129 }, (_, i) => {
    const x = i / 128;
    return `${i ? 'L' : 'M'}${(x * SW).toFixed(2)},${((1 - clamp01(f(x))) * SH).toFixed(2)}`;
  }).join(' ');
  const toUnit = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
  };
  const hitIndex = (u: { x: number; y: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const ar = r.height / Math.max(1, r.width);
    return points.findIndex((p) => Math.hypot(p.x - u.x, (p.y - u.y) * ar) < HIT);
  };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const u = toUnit(e);
    startPointerGesture();
    let index = hitIndex(u);
    let list = points.map((p) => ({ ...p }));
    if (index < 0) {
      const x = r3(curve.periodic ? clamp01(u.x) % 1 : clamp01(u.x));
      if (list.some((p) => Math.abs(p.x - x) < 0.01)) return;
      list = addPoint(list, x, r3(clamp01(f(x))), curve.periodic);
      index = list.findIndex((p) => p.x === x);
      props.onChange(list);
    }
    ref.current?.setPointerCapture(e.pointerId);
    setDrag(index);
    const start = { ...list[index]! };
    const u0 = u;
    let idx: number | null = index;
    const onMove = (ev: PointerEvent) => {
      if (idx === null) return;
      const v = toUnit(ev);
      const next = list.map((p) => ({ ...p }));
      if (v.y < -0.2 || v.y > 1.2) {
        next.splice(idx, 1);
        idx = null;
        setDrag(null);
        list = next;
        props.onChange(next);
        return;
      }
      let x = start.x + (v.x - u0.x);
      x = curve.periodic ? ((x % 1) + 1) % 1 : clamp01(x);
      const y = clamp01(start.y + (v.y - u0.y));
      next[idx] = { x: r3(x), y: r3(y) };
      // keep the list sorted, follow the dragged point
      const moved = next[idx]!;
      next.sort((a, b) => a.x - b.x);
      idx = next.indexOf(moved);
      setDrag(idx);
      props.onChange(next);
      list = next;
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
    const i = hitIndex(toUnit(e));
    if (i >= 0) props.onChange(points.filter((_, k) => k !== i));
  };
  const active = drag !== null ? points[drag] : undefined;
  return (
    <div className="icurve icolor-hcurve">
      <svg
        ref={ref}
        viewBox={`0 0 ${SW} ${SH}`}
        preserveAspectRatio="none"
        className="icurve__svg icolor-hcurve__svg"
        data-testid="hslcurve-editor"
        data-curve={curve.id}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        role="img"
        aria-label={curve.label}
      >
        {[1, 2, 3, 4, 5].map((i) => (
          <line key={`v${i}`} className="icolor-hcurve__grid" x1={(i * SW) / 6} y1={0} x2={(i * SW) / 6} y2={SH} />
        ))}
        <line className="icolor-hcurve__mid" x1={0} y1={SH / 2} x2={SW} y2={SH / 2} />
        <path d={path} className="icurve__path" style={{ stroke: '#fff' }} vectorEffect="non-scaling-stroke" data-testid="hslcurve-path" />
        {points.map((p, i) => (
          <ellipse
            key={i}
            cx={p.x * SW}
            cy={(1 - p.y) * SH}
            rx={drag === i ? 6 : 5}
            ry={drag === i ? 6 : 5}
            className={`icurve__pt${drag === i ? ' is-drag' : ''}`}
            style={{ stroke: '#fff' }}
            vectorEffect="non-scaling-stroke"
            data-testid="hslcurve-point"
            data-x={p.x.toFixed(3)}
            data-y={p.y.toFixed(3)}
          />
        ))}
      </svg>
      <div className="icolor-hcurve__bg" style={{ backgroundImage: BG[curve.x] }} />
      <div className="icolor-hcurve__readout">{active ? pointText(curve, active) : points.length ? `${points.length} point${points.length === 1 ? '' : 's'}` : 'Flat (neutral)'}</div>
    </div>
  );
}
