/**
 * Colour swatch (opens the native picker) + hex field. Picking with the native dialog is one
 * undo step: the transaction opens on the first live `input` and closes on the native `change`.
 */
import { useEffect, useRef, useState } from 'react';
import { beginSession, endSession } from './gesture';

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#abc" / "abc" / "#AABBCC" → "#aabbcc"; null when invalid. */
export function normalizeHex(text: string): string | null {
  const m = text.trim().match(HEX);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return `#${h.length === 3 ? h.replace(/./g, '$&$&') : h}`;
}

export function ColorInput(props: { value: string; onChange: (hex: string) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => endSession();
    el.addEventListener('change', done);
    el.addEventListener('blur', done);
    return () => {
      el.removeEventListener('change', done);
      el.removeEventListener('blur', done);
      endSession();
    };
  }, []);

  const value = normalizeHex(props.value) ?? '#000000';
  const commitDraft = () => {
    if (draft === null) return;
    const h = normalizeHex(draft);
    setDraft(null);
    if (h && h !== value) props.onChange(h);
  };

  return (
    <div className={`color${props.disabled ? ' is-disabled' : ''}`}>
      <label className="color__swatch" style={{ background: value }} title={`${props.label}: ${value}`}>
        <input
          ref={ref}
          type="color"
          value={value}
          disabled={props.disabled}
          aria-label={props.label}
          onInput={(e) => {
            beginSession();
            onChangeRef.current((e.target as HTMLInputElement).value);
          }}
          onChange={() => {
            /* handled in onInput; native change closes the session */
          }}
        />
      </label>
      <input
        className="color__hex"
        type="text"
        value={draft ?? value.toUpperCase()}
        disabled={props.disabled}
        aria-label={`${props.label} hex`}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
    </div>
  );
}
