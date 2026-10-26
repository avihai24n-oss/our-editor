/**
 * Adjust › Color wheel: Lift (shadows), Gamma (midtones), Gain (highlights) and Offset (all
 * tones). Drag the puck to push a colour (distance = strength), the slider under each wheel moves
 * its luminance. Double-click a wheel to reset it. Hue at the puck angle matches the wheel
 * gradient (red at 3 o'clock, counter-clockwise) — the same mapping the renderer uses
 * (engine/color/params.ts wheelChroma).
 */
import { useRef, type PointerEvent as RPointerEvent } from 'react';
import { WHEELS } from '../../../model/catalog';
import { defaultWheel, defaultWheels } from '../../../model/defaults';
import type { VisualClip, WheelId, WheelValue } from '../../../model/types';
import { useEditor } from '../../../store';
import { Section, SliderRow, startPointerGesture } from '../../controls';

const isNeutral = (w: WheelValue) => Math.hypot(w.x, w.y) < 1e-4 && !w.luma;

/** CSS conic angle φ (clockwise from 12 o'clock) shows hue θ = 90° − φ. */
const CONIC = `conic-gradient(${Array.from({ length: 13 }, (_, i) => `hsl(${90 - i * 30} 95% 55%) ${i * 30}deg`).join(', ')})`;

export function WheelsPanel({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const wheels = clip.grade.wheels;
  const setWheel = (id: WheelId, v: WheelValue) => updateClip(clip.id, { grade: { wheels: { ...wheels, [id]: v } } });
  const all = WHEELS.every((w) => isNeutral(wheels[w.id]));
  return (
    <Section
      id="wheels"
      title="Color wheel"
      checked={wheels.enabled}
      onCheck={(on) => updateClip(clip.id, { grade: { wheels: { ...wheels, enabled: on } } })}
      resetDisabled={all}
      onReset={() => updateClip(clip.id, { grade: { wheels: defaultWheels() } })}
    >
      <div className="iwheels">
        {WHEELS.map((w) => (
          <WheelControl key={w.id} id={w.id} label={w.label} hint={w.hint} value={wheels[w.id]} onChange={(v) => setWheel(w.id, v)} />
        ))}
      </div>
    </Section>
  );
}

/** One colour wheel (also used by Adjust › Color for the primaries and the log wheels). */
export function WheelControl(props: { id: string; label: string; hint: string; value: WheelValue; onChange: (v: WheelValue) => void; lumaLabel?: string; readout?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = props.value;
  const fromEvent = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    let x = ((e.clientX - r.left) / r.width) * 2 - 1;
    let y = 1 - ((e.clientY - r.top) / r.height) * 2;
    const d = Math.hypot(x, y);
    if (d > 1) {
      x /= d;
      y /= d;
    }
    return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
  };
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startPointerGesture();
    const start = { cx: e.clientX, cy: e.clientY, x: v.x, y: v.y };
    const onPuck = (e.target as HTMLElement).classList.contains('iwheel__puck');
    const apply = (ev: PointerEvent | RPointerEvent) => {
      // dragging the puck is relative (fine control); clicking the wheel jumps there
      if (onPuck) {
        const r = ref.current!.getBoundingClientRect();
        let x = start.x + ((ev.clientX - start.cx) / r.width) * 2;
        let y = start.y - ((ev.clientY - start.cy) / r.height) * 2;
        const d = Math.hypot(x, y);
        if (d > 1) {
          x /= d;
          y /= d;
        }
        props.onChange({ ...v, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
      } else props.onChange({ ...v, ...fromEvent(ev) });
    };
    if (!onPuck) apply(e);
    const onMove = (ev: PointerEvent) => apply(ev);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  const strength = Math.round(Math.min(1, Math.hypot(v.x, v.y)) * 100);
  const hue = strength ? Math.round((((Math.atan2(v.y, v.x) * 180) / Math.PI) + 360) % 360) : 0;
  return (
    <div className="iwheel" data-testid={`wheel-${props.id}`}>
      <div className="iwheel__head">
        <span className="iwheel__label">{props.label}</span>
        <span className="iwheel__hint">{props.hint}</span>
        <button
          type="button"
          className="icon-btn iwheel__reset"
          aria-label={`Reset ${props.label}`}
          title={`Reset ${props.label}`}
          disabled={isNeutral(v)}
          onClick={() => props.onChange(defaultWheel())}
        >
          ↺
        </button>
      </div>
      <div
        ref={ref}
        className="iwheel__disc"
        style={{ backgroundImage: `radial-gradient(circle, rgba(128,128,128,1) 0%, rgba(128,128,128,0) 72%), ${CONIC}` }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => props.onChange({ ...v, x: 0, y: 0 })}
        role="slider"
        aria-label={`${props.label} colour`}
        aria-valuetext={strength ? `hue ${hue}°, strength ${strength}%` : 'neutral'}
        data-testid={`wheel-${props.id}-disc`}
      >
        <span className="iwheel__cross" />
        <span className="iwheel__puck" style={{ left: `${50 + v.x * 50}%`, top: `${50 - v.y * 50}%` }} />
      </div>
      <div className="iwheel__readout">{props.readout ?? (strength ? `${hue}° · ${strength}%` : '—')}</div>
      <SliderRow
        label={props.lumaLabel ?? 'Luminance'}
        value={v.luma}
        min={-100}
        max={100}
        fillFrom={0}
        keyframe={false}
        trackBackground="linear-gradient(90deg, #111, #888 50%, #fff)"
        onChange={(l) => props.onChange({ ...v, luma: Math.round(l) })}
        testId={`wheel-${props.id}-luma`}
      />
    </div>
  );
}
