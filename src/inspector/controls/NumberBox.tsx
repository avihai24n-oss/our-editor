/**
 * CapCut numeric field: dark box showing the value with its unit ("100%", "0.0dB", "1.00x"),
 * a ⇕ stepper, ArrowUp/Down to step (Shift ×10). Typing commits on Enter / blur, Escape reverts.
 */
import { useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { parseNumber } from './format';

export interface NumberBoxProps {
  value: number;
  onCommit: (v: number) => void;
  digits?: number;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Custom display when not editing (e.g. "-∞dB"). */
  format?: (v: number) => string;
  label?: string;
  stepper?: boolean;
  /** Prefix shown inside the box (Position "X" / "Y"). */
  prefix?: string;
  testId?: string;
}

export function NumberBox(props: NumberBoxProps) {
  const { value, digits = 0, unit = '', step = 1, min = -Infinity, max = Infinity } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const shown = draft ?? (props.format ? props.format(value) : `${value.toFixed(digits)}${unit}`);

  const commit = () => {
    if (draft === null) return;
    const v = parseNumber(draft);
    setDraft(null);
    if (v !== null && Number.isFinite(clampV(v))) {
      const c = clampV(v);
      if (c !== value) props.onCommit(c);
    }
  };
  const bump = (dir: number, big = false) => {
    const base = draft !== null ? parseNumber(draft) ?? value : value;
    const next = clampV(Math.round((base + dir * step * (big ? 10 : 1)) * 1e6) / 1e6);
    setDraft(null);
    if (next !== value) props.onCommit(next);
  };

  return (
    <div className={`nbox${props.disabled ? ' is-disabled' : ''}`}>
      <label className="nbox__field">
        {props.prefix && <span className="nbox__prefix">{props.prefix}</span>}
        <input
          ref={ref}
          type="text"
          inputMode="decimal"
          aria-label={props.label}
          data-testid={props.testId}
          value={shown}
          disabled={props.disabled}
          onFocus={(e) => {
            setDraft(value.toFixed(digits));
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') ref.current?.blur();
            else if (e.key === 'Escape') {
              setDraft(null);
              requestAnimationFrame(() => ref.current?.blur());
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              bump(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
              requestAnimationFrame(() => {
                if (document.activeElement === ref.current) setDraft(null);
              });
            }
          }}
        />
      </label>
      {props.stepper !== false && (
        <div className="nbox__stepper">
          <button tabIndex={-1} disabled={props.disabled || value >= max} aria-label="Increase" onClick={() => bump(1)}>
            <Icon name="caret-up" size={10} />
          </button>
          <button tabIndex={-1} disabled={props.disabled || value <= min} aria-label="Decrease" onClick={() => bump(-1)}>
            <Icon name="caret-down" size={10} />
          </button>
        </div>
      )}
    </div>
  );
}
