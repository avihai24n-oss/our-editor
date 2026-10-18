import { describe, expect, it } from 'vitest';
import { isTypingTarget, resolveShortcut, type KeyLike } from './shortcuts';

function k(key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

describe('resolveShortcut', () => {
  it('maps the CapCut essentials', () => {
    expect(resolveShortcut(k(' ', 'Space'))).toBe('playPause');
    expect(resolveShortcut(k('b', 'KeyB', { metaKey: true }))).toBe('split');
    expect(resolveShortcut(k('b', 'KeyB', { ctrlKey: true }))).toBe('split');
    expect(resolveShortcut(k('q', 'KeyQ'))).toBe('deleteLeft');
    expect(resolveShortcut(k('w', 'KeyW'))).toBe('deleteRight');
    expect(resolveShortcut(k('Delete', 'Delete'))).toBe('delete');
    expect(resolveShortcut(k('Backspace', 'Backspace'))).toBe('delete');
    expect(resolveShortcut(k('z', 'KeyZ', { metaKey: true }))).toBe('undo');
    expect(resolveShortcut(k('Z', 'KeyZ', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(resolveShortcut(k('c', 'KeyC', { metaKey: true }))).toBe('copy');
    expect(resolveShortcut(k('v', 'KeyV', { metaKey: true }))).toBe('paste');
    expect(resolveShortcut(k('d', 'KeyD', { metaKey: true }))).toBe('duplicate');
    expect(resolveShortcut(k('a', 'KeyA', { metaKey: true }))).toBe('selectAll');
  });
  it('maps navigation and zoom', () => {
    expect(resolveShortcut(k('ArrowLeft', 'ArrowLeft'))).toBe('frameBack');
    expect(resolveShortcut(k('ArrowRight', 'ArrowRight', { shiftKey: true }))).toBe('framesForward10');
    expect(resolveShortcut(k('ArrowUp', 'ArrowUp'))).toBe('prevEdit');
    expect(resolveShortcut(k('ArrowDown', 'ArrowDown'))).toBe('nextEdit');
    expect(resolveShortcut(k('Home', 'Home'))).toBe('home');
    expect(resolveShortcut(k('End', 'End'))).toBe('end');
    expect(resolveShortcut(k('=', 'Equal', { metaKey: true }))).toBe('zoomIn');
    expect(resolveShortcut(k('-', 'Minus', { metaKey: true }))).toBe('zoomOut');
    expect(resolveShortcut(k('+', 'Equal', { shiftKey: true }))).toBe('zoomIn');
    expect(resolveShortcut(k('-', 'Minus'))).toBe('zoomOut');
    expect(resolveShortcut(k('Z', 'KeyZ', { shiftKey: true }))).toBe('fit');
  });
  it('maps tool and toggle letters', () => {
    expect(resolveShortcut(k('a', 'KeyA'))).toBe('toolSelect');
    expect(resolveShortcut(k('b', 'KeyB'))).toBe('toolSplit');
    expect(resolveShortcut(k('m', 'KeyM'))).toBe('marker');
    expect(resolveShortcut(k('p', 'KeyP'))).toBe('toggleMagnet');
    expect(resolveShortcut(k('n', 'KeyN'))).toBe('toggleSnapping');
    expect(resolveShortcut(k('s', 'KeyS'))).toBe('togglePreviewAxis');
    expect(resolveShortcut(k('v', 'KeyV'))).toBe('toggleDisable');
    expect(resolveShortcut(k('Escape', 'Escape'))).toBe('escape');
  });
  it('matches letters by physical key (Hebrew layout)', () => {
    expect(resolveShortcut(k('/', 'KeyQ'))).toBe('deleteLeft');
    expect(resolveShortcut(k('נ', 'KeyB', { metaKey: true }))).toBe('split');
    expect(resolveShortcut(k('ז', 'KeyZ', { metaKey: true }))).toBe('undo');
  });
  it('leaves ⌘E, unknown keys and Alt combos alone', () => {
    expect(resolveShortcut(k('e', 'KeyE', { metaKey: true }))).toBeNull();
    expect(resolveShortcut(k('x', 'KeyX'))).toBeNull();
    expect(resolveShortcut(k('q', 'KeyQ', { altKey: true }))).toBeNull();
    expect(resolveShortcut(k('Q', 'KeyQ', { shiftKey: true }))).toBeNull();
  });
});

describe('isTypingTarget', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;
  it('detects text fields but not sliders/buttons', () => {
    expect(isTypingTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'number' }))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'range' }))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
