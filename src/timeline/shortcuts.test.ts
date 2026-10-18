import { describe, expect, it } from 'vitest';
import {
  comboMatches,
  formatCombo,
  formatDef,
  resolveShortcut,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  shortcutLabel,
  visibleCombos,
  withShortcut,
  type Combo,
  type Command,
  type KeyLike,
  type Platform,
} from './shortcutDefs';
import { isInteractiveTarget, isTypingTarget } from './shortcuts';

function k(key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}
/** Mod = Cmd on Mac, Ctrl on Windows. */
const MOD: Record<Platform, Partial<KeyLike>> = { mac: { metaKey: true }, win: { ctrlKey: true } };
const PLATFORMS: Platform[] = ['mac', 'win'];

/** A keydown that a combo describes (US key value; `key` only matters for named keys). */
function eventFor(c: Combo, p: Platform): KeyLike {
  const code = c.codes?.[0] ?? c.keys?.[0] ?? '';
  const key = c.keys?.[0] ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code);
  return k(key, code, {
    ...(c.mod ? MOD[p] : {}),
    ...(c.ctrl ? { metaKey: true, ctrlKey: true } : {}),
    shiftKey: c.shift === true,
    altKey: !!c.alt,
  });
}

describe('shortcut table', () => {
  it('every combo of every bound row resolves to its own command, on both platforms', () => {
    for (const d of SHORTCUTS) {
      if (!d.command || d.status === 'browser' || d.status === 'native') continue;
      for (const c of d.combos) {
        for (const p of PLATFORMS) {
          if (c.ctrl && p === 'win') continue; // ⌃⌘ exists only on a Mac keyboard
          expect(resolveShortcut(eventFor(c, p)), `${d.label} ${formatCombo(c, p)}`).toBe(d.command);
        }
      }
    }
  });
  it('no two bound rows share a key combo', () => {
    const seen = new Map<string, string>();
    for (const d of SHORTCUTS) {
      if (d.text || d.status === 'native') continue;
      for (const c of d.combos) {
        for (const code of [...(c.codes ?? []), ...(c.keys ?? [])]) {
          for (const sh of c.shift === 'any' ? [true, false] : [!!c.shift]) {
            const id = `${c.mod ? 'M' : ''}${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${sh ? 'S' : ''}+${code}`;
            const prev = seen.get(id);
            if (prev && prev !== d.label) throw new Error(`${id}: ${prev} vs ${d.label}`);
            seen.set(id, d.label);
          }
        }
      }
    }
    expect(seen.size).toBeGreaterThan(60);
  });
  it('groups are exactly CapCut’s five, every row in one of them', () => {
    expect(SHORTCUT_GROUPS).toEqual(['Essentials', 'Tools', 'Timeline & preview', 'Audio & speed', 'Project & clipboard']);
    for (const d of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(d.group);
  });
  it('each command appears in exactly one row', () => {
    const cmds = SHORTCUTS.flatMap((d) => (d.command ? [d.command] : []));
    expect(new Set(cmds).size).toBe(cmds.length);
  });
});

describe('resolveShortcut — CapCut bindings', () => {
  const cases: [string, KeyLike | ((p: Platform) => KeyLike), Command][] = [
    ['Space', k(' ', 'Space'), 'playPause'],
    ['Mod+B', (p) => k('b', 'KeyB', MOD[p]), 'split'],
    ['Mod+Shift+B', (p) => k('B', 'KeyB', { ...MOD[p], shiftKey: true }), 'splitAll'],
    ['Q', k('q', 'KeyQ'), 'deleteLeft'],
    ['W', k('w', 'KeyW'), 'deleteRight'],
    ['←', k('ArrowLeft', 'ArrowLeft'), 'frameBack'],
    ['→', k('ArrowRight', 'ArrowRight'), 'frameForward'],
    ['↑', k('ArrowUp', 'ArrowUp'), 'prevEdit'],
    ['↓', k('ArrowDown', 'ArrowDown'), 'nextEdit'],
    ['Shift+Z', k('Z', 'KeyZ', { shiftKey: true }), 'fit'],
    ['Mod+E', (p) => k('e', 'KeyE', MOD[p]), 'export'],
    ['A', k('a', 'KeyA'), 'toolSelect'],
    ['B', k('b', 'KeyB'), 'toolSplit'],
    ['[', k('[', 'BracketLeft'), 'selectLeft'],
    [']', k(']', 'BracketRight'), 'selectRight'],
    ['Backspace', k('Backspace', 'Backspace'), 'delete'],
    ['Delete', k('Delete', 'Delete'), 'delete'],
    ['V', k('v', 'KeyV'), 'toggleDisable'],
    ['M', k('m', 'KeyM'), 'marker'],
    ['I', k('i', 'KeyI'), 'markIn'],
    ['O', k('o', 'KeyO'), 'markOut'],
    ['Shift+X', k('X', 'KeyX', { shiftKey: true }), 'areaFromClip'],
    ['Alt+X (Mac Opt gives ≈)', k('≈', 'KeyX', { altKey: true }), 'clearArea'],
    ['Mod+G', (p) => k('g', 'KeyG', MOD[p]), 'group'],
    ['Mod+Shift+G', (p) => k('G', 'KeyG', { ...MOD[p], shiftKey: true }), 'ungroup'],
    ['Alt+G (Opt gives ©)', k('©', 'KeyG', { altKey: true }), 'compound'],
    ['Alt+Shift+G', k('˝', 'KeyG', { altKey: true, shiftKey: true }), 'undoCompound'],
    ['Mod+J', (p) => k('j', 'KeyJ', MOD[p]), 'matchCut'],
    ['Shift+←', k('ArrowLeft', 'ArrowLeft', { shiftKey: true }), 'framesBack10'],
    ['Shift+→', k('ArrowRight', 'ArrowRight', { shiftKey: true }), 'framesForward10'],
    ['Home', k('Home', 'Home'), 'home'],
    ['End', k('End', 'End'), 'end'],
    ['Mod+=', (p) => k('=', 'Equal', MOD[p]), 'zoomIn'],
    ['Mod+-', (p) => k('-', 'Minus', MOD[p]), 'zoomOut'],
    ['+', k('+', 'Equal', { shiftKey: true }), 'zoomIn'],
    ['-', k('-', 'Minus'), 'zoomOut'],
    ['numpad +', k('+', 'NumpadAdd'), 'zoomIn'],
    ['Mod+Shift+F', (p) => k('F', 'KeyF', { ...MOD[p], shiftKey: true }), 'fullscreenPreview'],
    ['Cmd+Ctrl+F', k('f', 'KeyF', { metaKey: true, ctrlKey: true }), 'fullscreenPreview'],
    ['Alt+Shift+Z (Opt gives ¸)', k('¸', 'KeyZ', { altKey: true, shiftKey: true }), 'fitPreview'],
    ['S', k('s', 'KeyS'), 'togglePreviewAxis'],
    ['Esc', k('Escape', 'Escape'), 'escape'],
    ['Mod+Shift+S', (p) => k('S', 'KeyS', { ...MOD[p], shiftKey: true }), 'extractAudio'],
    ['Mod+R', (p) => k('r', 'KeyR', MOD[p]), 'speedPanel'],
    ['Shift+B', k('B', 'KeyB', { shiftKey: true }), 'curveSpeed'],
    ['Mod+.', (p) => k('.', 'Period', MOD[p]), 'volumeUp'],
    ['Mod+,', (p) => k(',', 'Comma', MOD[p]), 'volumeDown'],
    ['P', k('p', 'KeyP'), 'toggleMagnet'],
    ['N', k('n', 'KeyN'), 'toggleSnapping'],
    ['`', k('`', 'Backquote'), 'toggleLinkage'],
    ['~', k('~', 'Backquote', { shiftKey: true }), 'toggleLinkage'],
    ['Alt+K (Opt gives ˚)', k('˚', 'KeyK', { altKey: true }), 'keyframePanel'],
    ['Mod+I', (p) => k('i', 'KeyI', MOD[p]), 'importMedia'],
    ['Mod+Z', (p) => k('z', 'KeyZ', MOD[p]), 'undo'],
    ['Mod+Shift+Z', (p) => k('Z', 'KeyZ', { ...MOD[p], shiftKey: true }), 'redo'],
    ['Mod+Y', (p) => k('y', 'KeyY', MOD[p]), 'redo'],
    ['Mod+C', (p) => k('c', 'KeyC', MOD[p]), 'copy'],
    ['Mod+X', (p) => k('x', 'KeyX', MOD[p]), 'cut'],
    ['Mod+V', (p) => k('v', 'KeyV', MOD[p]), 'paste'],
    ['Mod+D', (p) => k('d', 'KeyD', MOD[p]), 'duplicate'],
    ['Mod+A', (p) => k('a', 'KeyA', MOD[p]), 'selectAll'],
    ['Tab', k('Tab', 'Tab'), 'libraryNext'],
    ['Shift+Tab', k('Tab', 'Tab', { shiftKey: true }), 'libraryPrev'],
    ['Enter', k('Enter', 'Enter'), 'splitCaption'],
  ];
  for (const [name, ev, cmd] of cases) {
    it(`${name} → ${cmd}`, () => {
      for (const p of PLATFORMS) expect(resolveShortcut(typeof ev === 'function' ? ev(p) : ev)).toBe(cmd);
    });
  }
});

describe('resolveShortcut — no collisions between look-alike keys', () => {
  it('Mod / Shift / Alt variants of one letter are different commands', () => {
    for (const p of PLATFORMS) {
      expect(resolveShortcut(k('b', 'KeyB'))).toBe('toolSplit');
      expect(resolveShortcut(k('b', 'KeyB', MOD[p]))).toBe('split');
      expect(resolveShortcut(k('B', 'KeyB', { ...MOD[p], shiftKey: true }))).toBe('splitAll');
      expect(resolveShortcut(k('B', 'KeyB', { shiftKey: true }))).toBe('curveSpeed');
      expect(resolveShortcut(k('v', 'KeyV'))).toBe('toggleDisable');
      expect(resolveShortcut(k('v', 'KeyV', MOD[p]))).toBe('paste');
      expect(resolveShortcut(k('a', 'KeyA'))).toBe('toolSelect');
      expect(resolveShortcut(k('a', 'KeyA', MOD[p]))).toBe('selectAll');
      expect(resolveShortcut(k('x', 'KeyX', MOD[p]))).toBe('cut');
      expect(resolveShortcut(k('X', 'KeyX', { shiftKey: true }))).toBe('areaFromClip');
      expect(resolveShortcut(k('≈', 'KeyX', { altKey: true }))).toBe('clearArea');
      expect(resolveShortcut(k('i', 'KeyI'))).toBe('markIn');
      expect(resolveShortcut(k('i', 'KeyI', MOD[p]))).toBe('importMedia');
      expect(resolveShortcut(k('s', 'KeyS'))).toBe('togglePreviewAxis');
      expect(resolveShortcut(k('S', 'KeyS', { ...MOD[p], shiftKey: true }))).toBe('extractAudio');
      expect(resolveShortcut(k('Z', 'KeyZ', { shiftKey: true }))).toBe('fit');
      expect(resolveShortcut(k('Z', 'KeyZ', { ...MOD[p], shiftKey: true }))).toBe('redo');
      expect(resolveShortcut(k('¸', 'KeyZ', { altKey: true, shiftKey: true }))).toBe('fitPreview');
    }
  });
  it('unbound keys and modifier mixes stay unbound (the browser keeps them)', () => {
    expect(resolveShortcut(k('x', 'KeyX'))).toBeNull();
    expect(resolveShortcut(k('œ', 'KeyQ', { altKey: true }))).toBeNull();
    expect(resolveShortcut(k('Q', 'KeyQ', { shiftKey: true }))).toBeNull();
    expect(resolveShortcut(k('n', 'KeyN', { metaKey: true }))).toBeNull(); // new project: browser
    expect(resolveShortcut(k('q', 'KeyQ', { metaKey: true }))).toBeNull(); // quit: browser
    expect(resolveShortcut(k('w', 'KeyW', { ctrlKey: true }))).toBeNull(); // close tab: browser
    expect(resolveShortcut(k('R', 'KeyR', { metaKey: true, shiftKey: true }))).toBeNull(); // hard reload stays
    expect(resolveShortcut(k('b', 'KeyB', { metaKey: true, ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(k('∫', 'KeyB', { metaKey: true, altKey: true }))).toBeNull();
    expect(resolveShortcut(k('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull();
    expect(resolveShortcut(k('F5', 'F5'))).toBeNull();
  });
});

describe('resolveShortcut — Hebrew layout (matched by physical key)', () => {
  it('letters', () => {
    expect(resolveShortcut(k('/', 'KeyQ'))).toBe('deleteLeft');
    expect(resolveShortcut(k('נ', 'KeyB', { metaKey: true }))).toBe('split');
    expect(resolveShortcut(k('נ', 'KeyB', { ctrlKey: true, shiftKey: true }))).toBe('splitAll');
    expect(resolveShortcut(k('ז', 'KeyZ', { metaKey: true }))).toBe('undo');
    expect(resolveShortcut(k('ן', 'KeyI'))).toBe('markIn');
    expect(resolveShortcut(k('ם', 'KeyO'))).toBe('markOut');
    expect(resolveShortcut(k('ן', 'KeyI', { ctrlKey: true }))).toBe('importMedia');
    expect(resolveShortcut(k('ר', 'KeyR', { metaKey: true }))).toBe('speedPanel');
    expect(resolveShortcut(k('ס', 'KeyX', { shiftKey: true }))).toBe('areaFromClip');
    expect(resolveShortcut(k('ד', 'KeyS', { metaKey: true, shiftKey: true }))).toBe('extractAudio');
    expect(resolveShortcut(k('ע', 'KeyG', { ctrlKey: true }))).toBe('group');
  });
  it('punctuation: brackets are mirrored on Hebrew, so only the physical key counts', () => {
    expect(resolveShortcut(k(']', 'BracketLeft'))).toBe('selectLeft');
    expect(resolveShortcut(k('[', 'BracketRight'))).toBe('selectRight');
    expect(resolveShortcut(k(';', 'Backquote'))).toBe('toggleLinkage');
    expect(resolveShortcut(k('ץ', 'Period', { metaKey: true }))).toBe('volumeUp');
    expect(resolveShortcut(k('ת', 'Comma', { ctrlKey: true }))).toBe('volumeDown');
  });
});

describe('display', () => {
  it('Mac glyphs in Apple order, Windows words', () => {
    expect(shortcutLabel('split', 'mac')).toBe('⌘B');
    expect(shortcutLabel('split', 'win')).toBe('Ctrl+B');
    expect(shortcutLabel('splitAll', 'mac')).toBe('⇧⌘B');
    expect(shortcutLabel('splitAll', 'win')).toBe('Ctrl+Shift+B');
    expect(shortcutLabel('fitPreview', 'mac')).toBe('⌥⇧Z');
    expect(shortcutLabel('fitPreview', 'win')).toBe('Alt+Shift+Z');
    expect(shortcutLabel('fullscreenPreview', 'mac')).toBe('⌃⌘F');
    expect(shortcutLabel('fullscreenPreview', 'win')).toBe('Ctrl+Shift+F');
    expect(shortcutLabel('clearArea', 'mac')).toBe('⌥X');
    expect(shortcutLabel('volumeUp', 'win')).toBe('Ctrl+.');
    expect(shortcutLabel('toggleLinkage', 'mac')).toBe('~');
    expect(shortcutLabel('selectLeft', 'win')).toBe('[');
    expect(shortcutLabel('playPause', 'mac')).toBe('Space');
    expect(shortcutLabel('delete', 'mac')).toBe('⌫');
    expect(withShortcut('Split', 'split', 'mac')).toBe('Split (⌘B)');
    expect(withShortcut('Split', 'split', 'win')).toBe('Split (Ctrl+B)');
  });
  it('platform-only combos are shown on their platform only', () => {
    const redo = SHORTCUTS.find((d) => d.command === 'redo')!;
    expect(formatDef(redo, 'mac')).toBe('⇧⌘Z');
    expect(formatDef(redo, 'win')).toBe('Ctrl+Shift+Z / Ctrl+Y');
    const fs = SHORTCUTS.find((d) => d.command === 'fullscreenPreview')!;
    expect(visibleCombos(fs, 'mac')).toHaveLength(2);
    expect(formatDef(fs, 'win')).toBe('Ctrl+Shift+F');
  });
  it('combo matching requires exact modifiers', () => {
    const c: Combo = { codes: ['KeyB'], mod: true };
    expect(comboMatches(c, k('b', 'KeyB', { metaKey: true }))).toBe(true);
    expect(comboMatches(c, k('b', 'KeyB', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(comboMatches(c, k('b', 'KeyB', { metaKey: true, ctrlKey: true }))).toBe(false);
  });
});

describe('isTypingTarget / isInteractiveTarget', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) =>
    ({ tagName, isContentEditable: false, getAttribute: (n: string) => (extra.attrs as Record<string, string> | undefined)?.[n] ?? null, ...extra }) as unknown as EventTarget;
  it('detects text fields but not sliders/buttons', () => {
    expect(isTypingTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'number' }))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'range' }))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
  it('buttons, links and tabs own Enter', () => {
    expect(isInteractiveTarget(el('BUTTON'))).toBe(true);
    expect(isInteractiveTarget(el('A'))).toBe(true);
    expect(isInteractiveTarget(el('DIV', { attrs: { role: 'tab' } }))).toBe(true);
    expect(isInteractiveTarget(el('BODY'))).toBe(false);
    expect(isInteractiveTarget(el('DIV'))).toBe(false);
  });
});
