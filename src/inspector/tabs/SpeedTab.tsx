/**
 * Speed tab, modelled on CapCut desktop (docs/capcut-screens/04, 05):
 *
 * - **Standard** — log speed slider 0.1x…100x with CapCut's six evenly spaced ticks, the
 *   Duration row (source length → editable new length), "Change audio pitch", the AI-only
 *   "Smooth slow-mo" row shown disabled, and Reset.
 * - **Curve** — None / Custom / Montage / Hero / Bullet / Jump cut / Flash in / Flash out tiles,
 *   then the graph editor: draggable points between 0.1x and 10x on a log axis, the playhead,
 *   add / delete point, Reset, and the resulting duration.
 * - **Velocity effects** — shown disabled (CapCut's are effect + speed templates).
 *
 * Every change is one undo step (drags are wrapped in beginTx / commitTx).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { LIMITS } from '../../model/catalog';
import {
  CURVE_MIN_GAP,
  CURVE_PRESETS,
  curveSpeedAt,
  curveYToSpeed,
  presetCurve,
  sameCurvePoints,
  speedToCurveY,
  type CurvePresetId,
  type SpeedCurve,
  type SpeedCurvePoint,
} from '../../model/speedCurve';
import { formatSeconds, secToUs, sourceSpan, usToSec } from '../../model/time';
import type { TimedClip } from '../../model/types';
import { useEditor } from '../../store';
import { NumberBox, SegmentedTabs, SliderRow, ToggleRow } from '../controls';
import { SPEED_SLIDER_MAX, SPEED_TICKS, sliderToSpeed, speedTickPos, speedToSlider } from '../inspectorLogic';

export type SpeedSub = 'standard' | 'curve';

export function SpeedTab(props: { clip: TimedClip; sub?: SpeedSub; onSubChange?: (s: SpeedSub) => void }) {
  const { clip } = props;
  const [ownSub, setOwnSub] = useState<SpeedSub>(clip.speedCurve ? 'curve' : 'standard');
  const sub = props.sub ?? ownSub;
  const setSub = props.onSubChange ?? setOwnSub;
  return (
    <>
      <SegmentedTabs<SpeedSub | 'velocity'>
        items={[
          { id: 'standard', label: 'Standard' },
          { id: 'curve', label: 'Curve' },
          { id: 'velocity', label: 'Velocity effects', disabled: true, title: 'Velocity effects (speed + effect templates) — coming soon' },
        ]}
        value={sub}
        onChange={(id) => id !== 'velocity' && setSub(id)}
        label="Speed mode"
      />
      {sub === 'standard' ? <StandardPanel clip={clip} /> : <CurvePanel clip={clip} onPick={() => setSub('curve')} />}
    </>
  );
}

// ---------------------------------------------------------------- Standard

function StandardPanel({ clip }: { clip: TimedClip }) {
  const setSpeed = useEditor((s) => s.setSpeed);
  const setDuration = useEditor((s) => s.setDuration);
  const updateClip = useEditor((s) => s.updateClip);
  const resetSpeed = useEditor((s) => s.resetSpeed);
  const original = sourceSpan(clip);
  const ticks = SPEED_TICKS.map(speedTickPos);
  const isDefault = clip.speed === 1 && !clip.speedCurve && clip.preservePitch;
  return (
    <>
      <div className="ipad" data-testid="speed-standard">
        {clip.speedCurve && (
          <div className="inotice" data-testid="speed-curve-active">
            A speed curve is applied. Changing the speed here replaces it.
          </div>
        )}
        <SliderRow
          label="Speed"
          value={clip.speed}
          min={LIMITS.speedMin}
          max={LIMITS.speedMax}
          step={0.1}
          digits={2}
          unit="x"
          toSlider={speedToSlider}
          fromSlider={sliderToSpeed}
          sliderMin={0}
          sliderMax={SPEED_SLIDER_MAX}
          sliderStep={1}
          ticks={ticks}
          keyframe={false}
          onChange={(v) => setSpeed(clip.id, v)}
          testId="speed-row"
        />
        <div className="ispeed-ticks" aria-hidden>
          {SPEED_TICKS.map((t, i) => (
            <span key={t} style={{ left: `${ticks[i]! * 100}%` }}>
              {t}x
            </span>
          ))}
        </div>
        <div className="irow irow--stack">
          <span className="irow__label">Duration</span>
          <div className="iduration">
            <span className="iduration__from" data-testid="duration-from">{formatSeconds(original)}</span>
            <span className="iduration__arrow" aria-hidden />
            <NumberBox
              value={Math.round(usToSec(clip.duration) * 10) / 10}
              min={Math.max(0.1, Math.ceil((usToSec(original) / LIMITS.speedMax) * 10) / 10)}
              max={Math.max(0.1, usToSec(original) / LIMITS.speedMin)}
              step={0.1}
              digits={1}
              unit="s"
              label="Duration"
              testId="duration-input"
              onCommit={(v) => setDuration(clip.id, secToUs(v))}
            />
          </div>
        </div>
        <ToggleRow
          label="Change audio pitch"
          hint="Off keeps the original pitch when the speed changes."
          on={!clip.preservePitch}
          onChange={(on) => updateClip(clip.id, { preservePitch: !on })}
        />
        {clip.type === 'video' && <SmoothSlowMo />}
      </div>
      <div className="ifoot">
        <span className="ifoot__spacer" />
        <button className="btn" data-testid="speed-reset" disabled={isDefault} onClick={() => resetSpeed(clip.id)}>
          Reset
        </button>
      </div>
    </>
  );
}

/** CapCut's AI frame interpolation. Shown exactly in its disabled state; Our Editor has no AI. */
function SmoothSlowMo() {
  return (
    <label className="islowmo" title="Smooth slow-mo uses AI frame interpolation, which Our Editor does not include." data-testid="smooth-slowmo">
      <input type="checkbox" disabled checked={false} readOnly />
      <span className="islowmo__name">Smooth slow-mo</span>
      <span className="islowmo__hint">Only slow-speed videos are supported.</span>
    </label>
  );
}

// ---------------------------------------------------------------- Curve

function CurvePanel({ clip, onPick }: { clip: TimedClip; onPick: () => void }) {
  const apply = useEditor((s) => s.setSpeedCurve);
  // picking a tile pins the Curve sub-tab (so "None" does not flip the panel to Standard)
  const setSpeedCurve = (id: string, c: SpeedCurve | null) => {
    onPick();
    apply(id, c);
  };
  const active: CurvePresetId | 'none' = clip.speedCurve?.preset ?? 'none';
  return (
    <div className="ipad" data-testid="speed-curve">
      <div className="icurve-grid" role="listbox" aria-label="Speed curve">
        <PresetTile id="none" label="None" active={active === 'none'} onPick={() => clip.speedCurve && setSpeedCurve(clip.id, null)} />
        {CURVE_PRESETS.map((p) => (
          <PresetTile
            key={p.id}
            id={p.id}
            label={p.label}
            active={active === p.id}
            onPick={() => active !== p.id && setSpeedCurve(clip.id, presetCurve(p.id))}
          />
        ))}
      </div>
      {clip.speedCurve && <CurveEditor clip={clip} curve={clip.speedCurve} />}
      {clip.type === 'video' && <SmoothSlowMo />}
    </div>
  );
}

function PresetTile(props: { id: CurvePresetId | 'none'; label: string; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.active}
      className={`icurve-tile${props.active ? ' is-active' : ''}`}
      data-testid={`curve-preset-${props.id}`}
      onClick={props.onPick}
      title={props.label}
    >
      <span className="icurve-tile__art">{props.id === 'none' ? <NoneIcon /> : props.id === 'custom' ? <CustomIcon /> : <MiniCurve id={props.id} />}</span>
      <span className="icurve-tile__label">{props.label}</span>
    </button>
  );
}

const NoneIcon = () => (
  <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden>
    <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <line x1="10" y1="10" x2="30" y2="30" stroke="currentColor" strokeWidth="2.5" />
  </svg>
);

const CustomIcon = () => (
  <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden className="icurve-yellow">
    {[11, 20, 29].map((y, i) => (
      <g key={y}>
        <line x1="6" y1={y} x2="34" y2={y} stroke="currentColor" strokeWidth="2" />
        <circle cx={[15, 21, 27][i]} cy={y} r="3" fill="var(--bg-raised)" stroke="currentColor" strokeWidth="2" />
      </g>
    ))}
  </svg>
);

/** The preset's own curve, drawn on the editor's axes (1x centre, dashed √10x / 1/√10x). */
function MiniCurve({ id }: { id: CurvePresetId }) {
  const d = useMemo(() => {
    const c = presetCurve(id);
    const W = 64;
    const H = 48;
    let path = '';
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      const y = (1 - speedToCurveY(curveSpeedAt(c, x))) * H;
      path += `${i ? 'L' : 'M'}${(x * (W - 4) + 2).toFixed(1)},${y.toFixed(1)}`;
    }
    return path;
  }, [id]);
  return (
    <svg viewBox="0 0 64 48" width="64" height="48" aria-hidden>
      <line x1="0" y1="12" x2="64" y2="12" className="icurve-dash" />
      <line x1="0" y1="24" x2="64" y2="24" className="icurve-mid" />
      <line x1="0" y1="36" x2="64" y2="36" className="icurve-dash" />
      <path d={d} className="icurve-line" />
    </svg>
  );
}

// ---------------------------------------------------------------- graph editor

const GRAPH_H = 220;
const PAD_X = 12;

interface Drag {
  index: number;
  pointerId: number;
  moved: boolean;
}

/** Keeps a dragged point between its neighbours; the end points only move vertically. */
export function movePoint(curve: SpeedCurve, index: number, x: number, v: number): SpeedCurve {
  const pts = curve.points.map((p) => ({ ...p }));
  const n = pts.length;
  const p = pts[index]!;
  if (index > 0 && index < n - 1) {
    const lo = pts[index - 1]!.x + CURVE_MIN_GAP;
    const hi = pts[index + 1]!.x - CURVE_MIN_GAP;
    p.x = Math.min(hi, Math.max(lo, x));
  }
  p.v = Math.round(Math.min(10, Math.max(0.1, v)) * 100) / 100;
  delete p.s;
  delete p.sl;
  return { preset: curve.preset, points: pts };
}

/** Adds a point at x with the curve's current speed there; null when too close to another. */
export function addPoint(curve: SpeedCurve, x: number): SpeedCurve | null {
  if (x <= CURVE_MIN_GAP || x >= 1 - CURVE_MIN_GAP) return null;
  if (curve.points.some((p) => Math.abs(p.x - x) < CURVE_MIN_GAP)) return null;
  const v = Math.round(curveSpeedAt(curve, x) * 100) / 100;
  const pts: SpeedCurvePoint[] = [...curve.points.map((p) => ({ ...p })), { x, v }].sort((a, b) => a.x - b.x);
  return { preset: curve.preset, points: pts };
}

/** Removes an interior point (the two end points stay). */
export function removePoint(curve: SpeedCurve, index: number): SpeedCurve | null {
  if (index <= 0 || index >= curve.points.length - 1) return null;
  return { preset: curve.preset, points: curve.points.filter((_, i) => i !== index).map((p) => ({ ...p })) };
}

function CurveEditor({ clip, curve }: { clip: TimedClip; curve: SpeedCurve }) {
  const setSpeedCurve = useEditor((s) => s.setSpeedCurve);
  const playhead = useEditor((s) => s.playhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [selected, setSelected] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const scrub = useRef<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(120, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(120, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  // a different clip or a reset invalidates the selected point
  useEffect(() => setSelected(null), [clip.id, curve.points.length]);

  const W = width;
  const H = GRAPH_H;
  const xToPx = (x: number) => PAD_X + x * (W - 2 * PAD_X);
  const pxToX = (px: number) => Math.min(1, Math.max(0, (px - PAD_X) / (W - 2 * PAD_X)));
  const vToPy = (v: number) => (1 - speedToCurveY(v)) * H;
  const pyToV = (py: number) => curveYToSpeed(1 - py / H);

  const path = useMemo(() => {
    let d = '';
    const n = 160;
    for (let i = 0; i <= n; i++) {
      const x = i / n;
      d += `${i ? 'L' : 'M'}${xToPx(x).toFixed(1)},${vToPy(curveSpeedAt(curve, x)).toFixed(1)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve, W]);

  const local = (playhead - clip.start) / Math.max(1, clip.duration);
  const playX = local >= 0 && local <= 1 ? local : null;

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.querySelector('svg')!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  const onPointDown = (e: RPointerEvent, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setSelected(index);
    drag.current = { index, pointerId: e.pointerId, moved: false };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) {
      const { px, py } = pos(e);
      if (!d.moved) {
        d.moved = true;
        useEditor.getState().beginTx();
      }
      const now = useEditor.getState().project;
      const cur = findCurve(now, clip.id) ?? curve;
      setSpeedCurve(clip.id, movePoint(cur, d.index, pxToX(px), pyToV(py)));
      return;
    }
    if (scrub.current === e.pointerId) setPlayhead(Math.round(clip.start + pxToX(pos(e).px) * clip.duration));
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) {
      drag.current = null;
      if (d.moved) useEditor.getState().commitTx();
    }
    if (scrub.current === e.pointerId) scrub.current = null;
  };
  const onBackgroundDown = (e: RPointerEvent) => {
    // click / drag on the graph moves the playhead inside the clip (CapCut's white line)
    setSelected(null);
    scrub.current = e.pointerId;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setPlayhead(Math.round(clip.start + pxToX(pos(e).px) * clip.duration));
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const next = addPoint(curve, pxToX(pos(e).px));
    if (next) setSpeedCurve(clip.id, next);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && drag.current) {
      drag.current = null;
      useEditor.getState().cancelTx();
    }
  };

  const canDelete = selected !== null && selected > 0 && selected < curve.points.length - 1;
  const addX = playX;
  const canAdd = !canDelete && addX !== null && addPoint(curve, addX) !== null;
  const onAddRemove = () => {
    if (canDelete) {
      const next = removePoint(curve, selected!);
      if (next) setSpeedCurve(clip.id, next);
      setSelected(null);
    } else if (canAdd && addX !== null) {
      const next = addPoint(curve, addX);
      if (next) setSpeedCurve(clip.id, next);
    }
  };
  const defaults = presetCurve(curve.preset);
  const isDefault = sameCurvePoints(curve, defaults);

  return (
    <div className="icurve-editor" data-testid="curve-editor" onKeyDown={onKeyDown}>
      <div className="icurve-editor__head">
        <span>Duration</span>
        <span className="iduration__from" data-testid="curve-duration-from">{formatSeconds(sourceSpan(clip))}</span>
        <span className="iduration__arrow" aria-hidden />
        <span className="icurve-editor__to" data-testid="curve-duration">{formatSeconds(clip.duration)}</span>
      </div>
      <div className="icurve-editor__graph" ref={wrapRef}>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          onPointerDown={onBackgroundDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={onDoubleClick}
          data-testid="curve-graph"
          data-graph-width={W}
          data-graph-height={H}
          data-graph-pad={PAD_X}
        >
          <line x1={0} x2={W} y1={vToPy(Math.sqrt(10))} y2={vToPy(Math.sqrt(10))} className="icurve-dash" />
          <line x1={0} x2={W} y1={vToPy(1)} y2={vToPy(1)} className="icurve-mid" />
          <line x1={0} x2={W} y1={vToPy(1 / Math.sqrt(10))} y2={vToPy(1 / Math.sqrt(10))} className="icurve-dash" />
          <text x={8} y={16} className="icurve-axis">10x</text>
          <text x={8} y={vToPy(1) + 16} className="icurve-axis">1x</text>
          <text x={8} y={H - 6} className="icurve-axis">0.1x</text>
          <path d={path} className="icurve-line icurve-line--big" />
          {playX !== null && <line x1={xToPx(playX)} x2={xToPx(playX)} y1={0} y2={H} className="icurve-playhead" data-testid="curve-playhead" />}
          {curve.points.map((p, i) => {
            const cx = xToPx(p.x);
            const cy = vToPy(p.v);
            const end = i === 0 || i === curve.points.length - 1;
            return (
              <g
                key={i}
                className={`icurve-pt${selected === i ? ' is-selected' : ''}${end ? ' is-end' : ''}`}
                transform={`translate(${cx},${cy})`}
                onPointerDown={(e) => onPointDown(e, i)}
                data-testid="curve-point"
                data-index={i}
                data-x={p.x}
                data-v={p.v}
              >
                <circle r={13} className="icurve-pt__hit" />
                {end ? (
                  <path d={i === 0 ? 'M-2,-7 L7,0 L-2,7 Z' : 'M-7,-7 L2,0 L-7,7 Z'} className="icurve-pt__end" />
                ) : (
                  <>
                    <path d="M-1.5,-7 A7,7 0 0 0 -1.5,7 Z" className="icurve-pt__half" />
                    <path d="M1.5,-7 A7,7 0 0 1 1.5,7 Z" className="icurve-pt__half" />
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="icurve-editor__foot">
        <span className="icurve-editor__value" data-testid="curve-point-value">
          {selected !== null && curve.points[selected] ? `${curve.points[selected]!.v.toFixed(2)}x` : ''}
        </span>
        <span className="ifoot__spacer" />
        <button className="btn" data-testid="curve-reset" disabled={isDefault} onClick={() => setSpeedCurve(clip.id, defaults)}>
          Reset
        </button>
        <button
          className="btn icurve-editor__pm"
          data-testid="curve-add-remove"
          disabled={!canDelete && !canAdd}
          aria-label={canDelete ? 'Delete point' : 'Add point at the playhead'}
          title={canDelete ? 'Delete point' : 'Add point at the playhead'}
          onClick={onAddRemove}
        >
          {canDelete ? '−' : '+'}
        </button>
      </div>
    </div>
  );
}

function findCurve(project: ReturnType<typeof useEditor.getState>['project'], clipId: string): SpeedCurve | null {
  for (const t of project.tracks) for (const c of t.clips) if (c.id === clipId && (c.type === 'video' || c.type === 'audio')) return c.speedCurve;
  return null;
}
