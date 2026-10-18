/**
 * Shared Library skeleton (CapCut §2.2): category sidebar on the left, toolbar + grid on the right,
 * plus the generic preset tile, the "Coming soon" state and a small inline hint toast.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../ui/Icon';

export interface SidebarItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Indented child of the previous group header. */
  child?: boolean;
  /** Group header (not selectable, shows ▴). */
  group?: boolean;
}

export function LibraryBody(props: { sidebar: SidebarItem[]; value: string; onChange: (id: string) => void; children: ReactNode }) {
  return (
    <div className="lib">
      <nav className="lib__side" aria-label="Categories">
        {props.sidebar.map((it) =>
          it.group ? (
            <div key={it.id} className="lib__side-group">
              {it.label}
              <Icon name="caret-up" size={10} />
            </div>
          ) : (
            <button
              key={it.id}
              className={`lib__side-item${it.child ? ' is-child' : ''}${props.value === it.id ? ' is-active' : ''}`}
              disabled={it.disabled}
              title={it.disabled ? `${it.label} — coming soon` : it.label}
              onClick={() => props.onChange(it.id)}
            >
              {it.label}
            </button>
          ),
        )}
      </nav>
      <div className="lib__main">{props.children}</div>
    </div>
  );
}

export function ComingSoon(props: { label: string; icon?: IconName; note?: string }) {
  return (
    <div className="lib-soon">
      {props.icon && <Icon name={props.icon} size={28} />}
      <div className="lib-soon__title">{props.label}</div>
      <div className="lib-soon__note">{props.note ?? 'Coming soon'}</div>
    </div>
  );
}

/** Section label above a grid ("All", "Basic" …). */
export const GridLabel = (props: { children: ReactNode }) => <div className="lib__label">{props.children}</div>;

/**
 * A preset tile: preview box, label under it, cyan outline when applied, hover "+".
 * Click = apply / add; the "+" does the same (CapCut's "Add to track").
 */
export function PresetTile(props: {
  label: string;
  preview: ReactNode;
  active?: boolean;
  title?: string;
  onApply: () => void;
  onDragStart?: (e: DragEvent) => void;
  testId?: string;
}) {
  return (
    <div
      className={`ptile${props.active ? ' is-active' : ''}`}
      title={props.title ?? props.label}
      draggable={!!props.onDragStart}
      onDragStart={props.onDragStart}
      data-testid={props.testId}
    >
      <div className="ptile__box">
      <button className="ptile__preview" onClick={props.onApply} aria-label={props.label}>
        {props.preview}
      </button>
      <button
        className="ptile__add"
        title="Add"
        aria-label={`Add ${props.label}`}
        onClick={(e) => {
          e.stopPropagation();
          props.onApply();
        }}
      >
        <Icon name="plus" size={12} />
      </button>
      </div>
      <div className="ptile__name">{props.label}</div>
    </div>
  );
}

/** Short-lived message at the bottom of the panel ("Select a clip first"). */
export function useFlash(): [ReactNode, (msg: string, tone?: 'info' | 'error') => void] {
  const [msg, setMsg] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    clearTimeout(timer.current);
    setMsg({ text, tone });
    timer.current = setTimeout(() => setMsg(null), tone === 'error' ? 5000 : 2500);
  }, []);
  const node = msg ? (
    <div className={`lib-flash lib-flash--${msg.tone}`} role="status">
      {msg.text}
    </div>
  ) : null;
  return [node, show];
}
