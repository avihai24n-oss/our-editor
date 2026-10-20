/**
 * CapCut-styled context menu: icon column, label, right-aligned key, › submenus that open on
 * hover or →, separators, disabled rows with a "Soon" tag, and keyboard navigation
 * (↑ ↓ Home End, → / Enter opens, ← / Esc goes back, Esc on the main menu closes).
 * Closes on an outside press, any scroll, a resize, a window blur or Esc. Rendered in a portal
 * at `position: fixed`, kept inside the viewport (./menuModel).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuShortcutLabel, type Command } from '../shortcutDefs';
import { MenuIcon } from './icons';
import { navigate, placeMenu, placeSubmenu, resolveRows, type NavKey, type NavState, type Pos, type Row } from './menuModel';
import type { MenuCtx, MenuItem } from './types';
import './contextMenu.css';

export interface ContextMenuProps {
  groups: MenuItem[][];
  ctx: MenuCtx;
  /** Client point the menu opened at. */
  at: Pos;
  onClose: () => void;
}

const NAV_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'Escape', 'Home', 'End']);
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

export function ContextMenu({ groups, ctx, at, onClose }: ContextMenuProps) {
  const [nav, setNav] = useState<NavState>({ active: [-1], focus: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  // the rows of every open level: level k+1 is the submenu of level k's active row
  const levels = useMemo(() => {
    const out: Row[][] = [resolveRows(groups, ctx)];
    for (let k = 0; k + 1 < nav.active.length; k++) {
      const r = out[k]![nav.active[k]!];
      if (!r?.item.submenu || r.disabled) break;
      out.push(resolveRows([r.item.submenu(ctx)], ctx));
    }
    return out;
  }, [groups, ctx, nav.active]);

  const hasSub = (level: number, i: number) => {
    const r = levels[level]?.[i];
    return !!r && !!r.item.submenu && !r.disabled;
  };
  // rows of `level`, also for a level that is about to open from the active row of the one above
  const rowsAt = (level: number): Row[] => {
    if (levels[level]) return levels[level]!;
    const parent = levels[level - 1]?.[nav.active[level - 1] ?? -1];
    return parent?.item.submenu ? resolveRows([parent.item.submenu(ctx)], ctx) : [];
  };

  const activate = (level: number, i: number) => {
    const r = levels[level]?.[i];
    if (!r || r.disabled) return;
    if (r.item.submenu) {
      setNav({ active: [...nav.active.slice(0, level), i, -1], focus: level });
      return;
    }
    onClose();
    r.item.run?.(ctx);
  };

  const latest = useRef({ nav, levels, activate, rowsAt, hasSub, onClose });
  latest.current = { nav, levels, activate, rowsAt, hasSub, onClose };

  useEffect(() => {
    const inside = (t: EventTarget | null) => !!(t instanceof Node && rootRef.current?.contains(t));
    const onKey = (e: KeyboardEvent) => {
      const L = latest.current;
      if (MODIFIERS.has(e.key)) return;
      if (!NAV_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey) {
        L.onClose(); // any other key closes the menu and does its usual job
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const r = navigate(L.nav, e.key as NavKey, L.rowsAt, L.hasSub);
      if (r.kind === 'close') L.onClose();
      else if (r.kind === 'activate') L.activate(r.level, r.index);
      else setNav(r.state);
    };
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) latest.current.onClose();
    };
    const onWheel = (e: WheelEvent) => {
      if (!inside(e.target)) latest.current.onClose();
    };
    const close = () => latest.current.onClose();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, []);

  const vp = () => ({ w: window.innerWidth, h: window.innerHeight });
  const place = (level: number) => (size: { w: number; h: number }): Pos => {
    if (level === 0) return placeMenu(at, size, vp());
    const root = rootRef.current;
    const parent = root?.querySelector<HTMLElement>(`[data-level="${level - 1}"]`);
    const row = parent?.querySelector<HTMLElement>(`[data-index="${nav.active[level - 1]}"]`);
    if (!parent || !row) return placeMenu(at, size, vp());
    return placeSubmenu(parent.getBoundingClientRect(), row.getBoundingClientRect(), size, vp());
  };

  return createPortal(
    <div ref={rootRef} className="ctxm-root" onContextMenu={(e) => e.preventDefault()}>
      {levels.map((rows, level) =>
        rows.length ? (
          <Panel
            key={`${level}:${level ? nav.active[level - 1] : ''}`}
            level={level}
            rows={rows}
            active={nav.active[level] ?? -1}
            place={place(level)}
            onHover={(i) => {
              const r = rows[i]!;
              const next = [...nav.active.slice(0, level), i];
              if (r.item.submenu && !r.disabled) next.push(-1);
              setNav({ active: next, focus: level });
            }}
            onPick={(i) => activate(level, i)}
          />
        ) : null,
      )}
    </div>,
    document.body,
  );
}

interface PanelProps {
  level: number;
  rows: Row[];
  active: number;
  place: (size: { w: number; h: number }) => Pos;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
}

function Panel({ level, rows, active, place, onHover, onPick }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPos(place({ w: el.offsetWidth, h: el.offsetHeight }));
    // placed once per mount (a new submenu is a new mount)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      className="ctxm"
      role="menu"
      data-level={level}
      data-testid={level === 0 ? 'clip-context-menu' : 'clip-context-submenu'}
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {rows.map((r, i) => {
        const key = r.item.shortcut ? menuShortcutLabel(r.item.shortcut as Command) : '';
        return (
          <div key={r.item.id} className="ctxm__slot">
            {r.separatorBefore && <div className="ctxm__sep" role="separator" />}
            <div
              role="menuitem"
              aria-disabled={r.disabled || undefined}
              aria-haspopup={r.item.submenu ? 'menu' : undefined}
              className={`ctxm__row${i === active ? ' is-active' : ''}${r.disabled ? ' is-disabled' : ''}`}
              data-testid="ctx-item"
              data-item-id={r.item.id}
              data-index={i}
              onPointerEnter={() => onHover(i)}
              onClick={() => onPick(i)}
            >
              <MenuIcon name={r.item.icon} />
              <span className="ctxm__label">{r.item.label}</span>
              {r.item.tag && <span className={`ctxm__tag ctxm__tag--${r.item.tag.toLowerCase()}`}>{r.item.tag}</span>}
              <span className="ctxm__key">{key}</span>
              <span className="ctxm__chev" aria-hidden>
                {r.item.submenu ? '›' : ''}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
