/** Pure maths of the context menu: placement inside the viewport and keyboard navigation. */
import type { MenuCtx, MenuItem } from './types';

export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Pos {
  x: number;
  y: number;
}

/** Keep this far from the window's edges. */
export const EDGE = 4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where the menu's top-left goes for a click at `at`: down-right of the pointer, flipped left /
 * up when it would leave the viewport, then clamped inside it (a menu taller than the window
 * starts at the top edge).
 */
export function placeMenu(at: Pos, size: Size, vp: Size, edge = EDGE): Pos {
  let x = at.x;
  let y = at.y;
  if (x + size.w > vp.w - edge) x = at.x - size.w;
  if (y + size.h > vp.h - edge) y = at.y - size.h;
  return { x: clamp(x, edge, Math.max(edge, vp.w - edge - size.w)), y: clamp(y, edge, Math.max(edge, vp.h - edge - size.h)) };
}

/**
 * A submenu next to its row: to the right of the parent menu, or to the left when there is no
 * room; its first row level with the parent row, pushed up to fit.
 */
export function placeSubmenu(parent: Rect, row: Rect, size: Size, vp: Size, edge = EDGE, gap = 2, pad = 4): Pos {
  let x = parent.right + gap;
  if (x + size.w > vp.w - edge) x = parent.left - gap - size.w;
  const y = row.top - pad;
  return { x: clamp(x, edge, Math.max(edge, vp.w - edge - size.w)), y: clamp(y, edge, Math.max(edge, vp.h - edge - size.h)) };
}

/** An item resolved against a context: hidden ones dropped, `disabled` evaluated. */
export interface Row {
  item: MenuItem;
  disabled: boolean;
  separatorBefore: boolean;
}

/** Groups (separated by lines) or a flat list → the rows to draw. */
export function resolveRows(groups: MenuItem[][], ctx: MenuCtx): Row[] {
  const rows: Row[] = [];
  for (const g of groups) {
    const vis = g.filter((it) => !it.hidden?.(ctx));
    vis.forEach((it, i) => {
      rows.push({ item: it, disabled: !!it.disabled?.(ctx), separatorBefore: (i === 0 && rows.length > 0) || (i > 0 && !!it.separatorBefore) });
    });
  }
  return rows;
}

/** Next enabled row from `from` in `dir` (wrapping); `from` -1 = before the first. -1 when none. */
export function nextEnabled(rows: { disabled: boolean }[], from: number, dir: 1 | -1): number {
  const n = rows.length;
  if (!n) return -1;
  let i = from < 0 ? (dir === 1 ? -1 : n) : from;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (!rows[i]!.disabled) return i;
  }
  return -1;
}

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Enter' | ' ' | 'Escape' | 'Home' | 'End';

export interface NavState {
  /** Active row per open level (level 0 = the main menu). */
  active: number[];
  /** Levels whose submenu is open = active.length - 1. Keyboard acts on `focus`. */
  focus: number;
}

export type NavResult =
  | { kind: 'state'; state: NavState }
  | { kind: 'activate'; level: number; index: number }
  | { kind: 'close' };

/**
 * One key on the menu. `rowsAt(level)` gives the rows of an open level; `hasSubmenu(level, i)`
 * whether that row opens one. Pure.
 */
export function navigate(
  st: NavState,
  key: NavKey,
  rowsAt: (level: number) => { disabled: boolean }[],
  hasSubmenu: (level: number, index: number) => boolean,
): NavResult {
  const L = st.focus;
  const rows = rowsAt(L);
  const cur = st.active[L] ?? -1;
  const at = (i: number): NavState => ({ active: [...st.active.slice(0, L), i], focus: L });
  switch (key) {
    case 'ArrowDown':
      return { kind: 'state', state: at(nextEnabled(rows, cur, 1)) };
    case 'ArrowUp':
      return { kind: 'state', state: at(nextEnabled(rows, cur, -1)) };
    case 'Home':
      return { kind: 'state', state: at(nextEnabled(rows, -1, 1)) };
    case 'End':
      return { kind: 'state', state: at(nextEnabled(rows, -1, -1)) };
    case 'ArrowRight':
    case 'Enter':
    case ' ': {
      if (cur < 0 || rows[cur]?.disabled) return { kind: 'state', state: st };
      if (hasSubmenu(L, cur)) {
        const sub = rowsAt(L + 1);
        return { kind: 'state', state: { active: [...st.active.slice(0, L + 1), nextEnabled(sub, -1, 1)], focus: L + 1 } };
      }
      return key === 'ArrowRight' ? { kind: 'state', state: st } : { kind: 'activate', level: L, index: cur };
    }
    case 'ArrowLeft':
      return L > 0 ? { kind: 'state', state: { active: st.active.slice(0, L), focus: L - 1 } } : { kind: 'state', state: st };
    case 'Escape':
      return L > 0 ? { kind: 'state', state: { active: st.active.slice(0, L), focus: L - 1 } } : { kind: 'close' };
  }
}
