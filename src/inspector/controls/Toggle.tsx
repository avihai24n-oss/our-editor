/** Cyan pill switch, and a label + switch row (Uniform scale, Change audio pitch …). */
import type { ReactNode } from 'react';

export function Toggle(props: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      title={props.title ?? props.label}
      disabled={props.disabled}
      className={`switch${props.on ? ' is-on' : ''}`}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

export function ToggleRow(props: { label: string; hint?: ReactNode; on: boolean; onChange: (on: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <div className={`trow${props.disabled ? ' is-disabled' : ''}`}>
      <div className="trow__text">
        <span>{props.label}</span>
        {props.hint && <span className="trow__hint">{props.hint}</span>}
      </div>
      <Toggle on={props.on} onChange={props.onChange} label={props.label} disabled={props.disabled} title={props.title} />
    </div>
  );
}
