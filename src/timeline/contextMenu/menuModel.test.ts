import { describe, expect, it } from 'vitest';
import { navigate, nextEnabled, placeMenu, placeSubmenu, resolveRows, type NavState } from './menuModel';
import type { MenuCtx, MenuItem } from './types';

const vp = { w: 1000, h: 800 };
const size = { w: 250, h: 600 };

describe('placeMenu', () => {
  it('opens down-right of the pointer when it fits', () => {
    expect(placeMenu({ x: 100, y: 100 }, size, vp)).toEqual({ x: 100, y: 100 });
  });
  it('flips left at the right edge and up at the bottom edge', () => {
    expect(placeMenu({ x: 900, y: 700 }, size, vp)).toEqual({ x: 650, y: 100 });
  });
  it('clamps inside the viewport when flipping is not enough', () => {
    expect(placeMenu({ x: 900, y: 300 }, { w: 250, h: 780 }, vp)).toEqual({ x: 650, y: 4 });
    expect(placeMenu({ x: 100, y: 100 }, { w: 250, h: 900 }, vp).y).toBe(4);
    expect(placeMenu({ x: 2, y: 2 }, size, vp)).toEqual({ x: 4, y: 4 });
  });
});

describe('placeSubmenu', () => {
  const parent = { left: 100, top: 50, right: 350, bottom: 650 };
  const row = { left: 104, top: 200, right: 346, bottom: 228 };
  it('goes to the right of the parent, level with the row', () => {
    expect(placeSubmenu(parent, row, { w: 200, h: 100 }, vp)).toEqual({ x: 352, y: 196 });
  });
  it('goes to the left when the right has no room', () => {
    const p = { left: 700, top: 50, right: 950, bottom: 650 };
    expect(placeSubmenu(p, row, { w: 200, h: 100 }, vp).x).toBe(498);
  });
  it('is pushed up to stay inside the bottom edge', () => {
    expect(placeSubmenu(parent, { ...row, top: 760, bottom: 788 }, { w: 200, h: 200 }, vp).y).toBe(596);
  });
});

const ctx: MenuCtx = { clipIds: ['a'], primaryId: 'a', trackId: 't', time: 0 };
const it_ = (id: string, more: Partial<MenuItem> = {}): MenuItem => ({ id, label: id, ...more });

describe('resolveRows', () => {
  it('drops hidden items, evaluates disabled and puts separators between groups', () => {
    const rows = resolveRows([[it_('a')], [it_('b', { hidden: () => true }), it_('c', { disabled: () => true })], [it_('d')]], ctx);
    expect(rows.map((r) => [r.item.id, r.disabled, r.separatorBefore])).toEqual([
      ['a', false, false],
      ['c', true, true],
      ['d', false, true],
    ]);
  });
  it('no separator above an empty group', () => {
    const rows = resolveRows([[], [it_('a')], [it_('b', { hidden: () => true })], [it_('c')]], ctx);
    expect(rows.map((r) => r.separatorBefore)).toEqual([false, true]);
  });
});

describe('keyboard navigation', () => {
  const rows = [{ disabled: true }, { disabled: false }, { disabled: true }, { disabled: false }];
  it('nextEnabled skips disabled rows and wraps', () => {
    expect(nextEnabled(rows, -1, 1)).toBe(1);
    expect(nextEnabled(rows, 1, 1)).toBe(3);
    expect(nextEnabled(rows, 3, 1)).toBe(1);
    expect(nextEnabled(rows, -1, -1)).toBe(3);
    expect(nextEnabled(rows, 1, -1)).toBe(3);
    expect(nextEnabled([{ disabled: true }], -1, 1)).toBe(-1);
  });

  const sub = [{ disabled: false }, { disabled: false }];
  const rowsAt = (l: number) => (l === 0 ? rows : sub);
  const hasSub = (l: number, i: number) => l === 0 && i === 3;
  const st = (active: number[], focus = 0): NavState => ({ active, focus });

  it('↓ ↑ Home End move the active row', () => {
    expect(navigate(st([-1]), 'ArrowDown', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([1]) });
    expect(navigate(st([1]), 'ArrowUp', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([3]) });
    expect(navigate(st([3]), 'Home', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([1]) });
    expect(navigate(st([1]), 'End', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([3]) });
  });
  it('↓ on the main menu closes a submenu opened by hover', () => {
    expect(navigate(st([3, -1]), 'ArrowDown', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([1]) });
  });
  it('→ / Enter open a submenu on its first enabled row; ← and Esc go back', () => {
    expect(navigate(st([3]), 'ArrowRight', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([3, 0], 1) });
    expect(navigate(st([3]), 'Enter', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([3, 0], 1) });
    expect(navigate(st([3, 1], 1), 'ArrowDown', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([3, 0], 1) });
    expect(navigate(st([3, 1], 1), 'ArrowLeft', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([3]) });
    expect(navigate(st([3, 1], 1), 'Escape', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([3]) });
  });
  it('Enter / Space on a plain row activates it; Esc on the main menu closes', () => {
    expect(navigate(st([1]), 'Enter', rowsAt, hasSub)).toEqual({ kind: 'activate', level: 0, index: 1 });
    expect(navigate(st([3, 1], 1), ' ', rowsAt, hasSub)).toEqual({ kind: 'activate', level: 1, index: 1 });
    expect(navigate(st([1]), 'ArrowRight', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([1]) });
    expect(navigate(st([-1]), 'Enter', rowsAt, hasSub)).toEqual({ kind: 'state', state: st([-1]) });
    expect(navigate(st([1]), 'Escape', rowsAt, hasSub)).toEqual({ kind: 'close' });
  });
});
