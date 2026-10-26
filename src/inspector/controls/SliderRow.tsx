/**
 * CapCut property row: label on top, then slider · number box with ⇕ stepper · keyframe ◇.
 * The slider can use its own scale (`toSlider` / `fromSlider`, e.g. the log speed slider).
 * One drag = one undo step (startPointerGesture on pointer-down).
 */
import type { CSSProperties, ReactNode } from 'react';
import { startPointerGesture } from './gesture';
import { KeyframeButton } from './KeyframeButton';
import { NumberBox } from './NumberBox';

export interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  unit?: string;
  digits?: number;
  format?: (v: number) => string;
  /** Slider-space mapping (defaults to identity over [min, max]). */
  toSlider?: (v: number) => number;
  fromSlider?: (pos: number) => number;
  sliderMin?: number;
  sliderMax?: number;
  sliderStep?: number;
  /** Custom track (e.g. Temp's blue→yellow gradient). Default: white fill up to the value. */
  trackBackground?: string;
  /** Fill from this value instead of from min (bipolar sliders fill from 0). */
  fillFrom?: number;
  /** Tick marks as 0..1 fractions of the track. */
  ticks?: number[];
  disabled?: boolean;
  keyframe?: boolean;
  /** A working keyframe cluster (KeyframeNav) in place of the disabled ◇. */
  keyframeSlot?: ReactNode;
  /** Extra content right of the label (e.g. "2.3s → 1.2s"). */
  aside?: ReactNode;
  testId?: string;
}

export function SliderRow(p: SliderRowProps) {
  const sMin = p.sliderMin ?? p.min;
  const sMax = p.sliderMax ?? p.max;
  const pos = p.toSlider ? p.toSlider(p.value) : p.value;
  const frac = (v: number) => (sMax === sMin ? 0 : Math.min(1, Math.max(0, (v - sMin) / (sMax - sMin))));
  const fillA = p.fillFrom !== undefined ? frac(p.toSlider ? p.toSlider(p.fillFrom) : p.fillFrom) : 0;
  const fillB = frac(pos);
  const lo = Math.min(fillA, fillB) * 100;
  const hi = Math.max(fillA, fillB) * 100;
  const style = {
    '--track':
      p.trackBackground ??
      `linear-gradient(90deg, var(--bg-active) ${lo}%, #fff ${lo}%, #fff ${hi}%, var(--bg-active) ${hi}%)`,
  } as CSSProperties;

  return (
    <div className={`srow${p.disabled ? ' is-disabled' : ''}`} data-testid={p.testId}>
      <div className="srow__label">
        <span>{p.label}</span>
        {p.aside}
      </div>
      <div className="srow__line">
        <div className="srow__slider" style={style}>
          {p.ticks?.map((t) => (
            <span key={t} className="srow__tick" style={{ left: `${t * 100}%` }} />
          ))}
          <input
            type="range"
            min={sMin}
            max={sMax}
            step={p.sliderStep ?? p.step ?? 1}
            value={pos}
            disabled={p.disabled}
            aria-label={p.label}
            onPointerDown={() => startPointerGesture()}
            onChange={(e) => {
              const raw = Number(e.target.value);
              const v = p.fromSlider ? p.fromSlider(raw) : raw;
              p.onChange(Math.min(p.max, Math.max(p.min, v)));
            }}
          />
        </div>
        <NumberBox
          value={p.value}
          min={p.min}
          max={p.max}
          step={p.step ?? 1}
          digits={p.digits}
          unit={p.unit}
          format={p.format}
          disabled={p.disabled}
          label={`${p.label} value`}
          onCommit={p.onChange}
        />
        {p.keyframeSlot ?? (p.keyframe !== false && <KeyframeButton />)}
      </div>
    </div>
  );
}
