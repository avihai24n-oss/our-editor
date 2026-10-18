/**
 * Shared UI controls (CapCut anatomy). Styles live in src/theme.css (.btn, .row, .section …).
 * Owner: Builder A (Library + Inspector). Others import; requests go to docs/integration-notes/.
 */
import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Button(props: { children: ReactNode; onClick?: () => void; primary?: boolean; ghost?: boolean; disabled?: boolean; title?: string }) {
  const cls = ['btn', props.primary && 'btn--primary', props.ghost && 'btn--ghost'].filter(Boolean).join(' ');
  return (
    <button className={cls} onClick={props.onClick} disabled={props.disabled} title={props.title}>
      {props.children}
    </button>
  );
}

export function IconButton(props: { icon: IconName; title: string; onClick?: () => void; active?: boolean; disabled?: boolean; size?: number }) {
  return (
    <button
      className={`icon-btn${props.active ? ' is-active' : ''}`}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      <Icon name={props.icon} size={props.size ?? 16} />
    </button>
  );
}

export function Switch(props: { on: boolean; onChange: (on: boolean) => void; title?: string }) {
  return (
    <button
      role="switch"
      aria-checked={props.on}
      title={props.title}
      className={`switch${props.on ? ' is-on' : ''}`}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

/** Top-level tab row (inspector: Video / Audio / Speed …; active = cyan text). */
export function Tabs<T extends string>(props: { items: { id: T; label: string; disabled?: boolean }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {props.items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={props.value === it.id}
          disabled={it.disabled}
          className={`tabs__item${props.value === it.id ? ' is-active' : ''}`}
          onClick={() => props.onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Segmented sub-tabs (Basic | Mask …). */
export function Segmented<T extends string>(props: { items: { id: T; label: string; disabled?: boolean }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="seg">
      {props.items.map((it) => (
        <button
          key={it.id}
          disabled={it.disabled}
          className={`seg__item${props.value === it.id ? ' is-active' : ''}`}
          onClick={() => props.onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Inspector section: optional enable checkbox, title, collapse caret, reset button. */
export function Section(props: {
  title: string;
  children: ReactNode;
  enabled?: boolean;
  onToggle?: (on: boolean) => void;
  onReset?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <div className="section">
      <div className="section__head">
        {props.onToggle && (
          <input type="checkbox" className="checkbox" checked={!!props.enabled} onChange={(e) => props.onToggle!(e.target.checked)} aria-label={`Enable ${props.title}`} />
        )}
        <button onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {props.title}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
        </button>
        <span className="spacer" />
        {props.onReset && <IconButton icon="reset" title="Reset" onClick={props.onReset} size={14} />}
      </div>
      {open && <div className="section__body">{props.children}</div>}
    </div>
  );
}

/**
 * Label + slider + numeric field. `onChange` fires continuously while dragging; wrap the gesture
 * with store beginTx()/commitTx() via onDragStart/onDragEnd for one undo step.
 */
export function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Digits shown in the numeric field. */
  digits?: number;
  onChange: (v: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  disabled?: boolean;
}) {
  const step = props.step ?? 1;
  const digits = props.digits ?? 0;
  const clampV = (v: number) => Math.min(props.max, Math.max(props.min, v));
  return (
    <div className="row">
      <span className="row__label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={step}
        value={props.value}
        disabled={props.disabled}
        onPointerDown={props.onDragStart}
        onPointerUp={props.onDragEnd}
        onChange={(e) => props.onChange(clampV(Number(e.target.value)))}
      />
      <NumberField value={props.value} digits={digits} unit={props.unit} disabled={props.disabled} onCommit={(v) => props.onChange(clampV(v))} />
    </div>
  );
}

/** Numeric input that commits on Enter / blur. Shows `unit` as a suffix in the title. */
export function NumberField(props: { value: number; onCommit: (v: number) => void; digits?: number; unit?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.value.toFixed(props.digits ?? 0);
  const commit = () => {
    if (draft !== null) {
      const v = Number(draft);
      if (Number.isFinite(v)) props.onCommit(v);
      setDraft(null);
    }
  };
  return (
    <input
      type="number"
      value={shown}
      disabled={props.disabled}
      title={props.unit}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(null);
        e.stopPropagation();
      }}
    />
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="modal__head">
          <span>{props.title}</span>
          <IconButton icon="close" title="Close" onClick={props.onClose} />
        </div>
        <div className="modal__body">{props.children}</div>
        {props.footer && <div className="modal__foot">{props.footer}</div>}
      </div>
    </div>
  );
}
