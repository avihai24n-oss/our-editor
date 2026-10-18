/** Small rotation dial next to the Rotate field: drag around it to set the angle (Shift = 15° steps). */
import { useRef } from 'react';
import { dialAngle, normalizeAngle } from '../inspectorLogic';
import { startPointerGesture } from './gesture';

export function RotationDial(props: { value: number; onChange: (deg: number) => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const setFrom = (e: { clientX: number; clientY: number; shiftKey: boolean }) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    let a = dialAngle(r.left + r.width / 2, r.top + r.height / 2, e.clientX, e.clientY);
    if (e.shiftKey) a = normalizeAngle(Math.round(a / 15) * 15);
    props.onChange(a);
  };
  return (
    <div
      ref={ref}
      className={`dial${props.disabled ? ' is-disabled' : ''}`}
      role="slider"
      aria-label="Rotation dial"
      aria-valuemin={-180}
      aria-valuemax={180}
      aria-valuenow={props.value}
      title="Drag to rotate (Shift: 15° steps)"
      onPointerDown={(e) => {
        if (props.disabled) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        startPointerGesture();
        setFrom(e);
      }}
      onPointerMove={(e) => {
        if (!props.disabled && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) setFrom(e);
      }}
    >
      <span className="dial__hand" style={{ transform: `rotate(${props.value}deg)` }} />
    </div>
  );
}
