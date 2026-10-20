/**
 * THE keyboard-shortcut table (CapCut desktop defaults, docs/research/01-ui-ux.md §6).
 *
 * One definition drives three things, so they can never disagree:
 *   - `resolveShortcut` (the keydown → command matcher used by the global handler),
 *   - the Keyboard shortcuts panel (top bar, grouped like CapCut's panel),
 *   - the tooltips (`shortcutLabel('split')` → "⌘B" on Mac, "Ctrl+B" on Windows).
 *
 * Matching rules
 *   - Letters, digits and punctuation match the PHYSICAL key (`KeyboardEvent.code`), so the
 *     bindings work on a Hebrew (or any) layout and with Mac Option combos (Opt changes `e.key`).
 *   - Modifiers must match exactly: ⌘B ≠ B ≠ ⇧⌘B, ⇧X ≠ ⌥X ≠ ⌘X. "mod" is Cmd on Mac and Ctrl on
 *     Windows; either key is accepted on any platform. `ctrl: true` is the Mac-only ⌃⌘ pair.
 *   - `shift: 'any'` accepts the key with or without Shift (= / +, ~ / `).
 *
 * Pure: no React, no DOM, no store.
 */

export type Command =
  // essentials
  | 'playPause'
  | 'split'
  | 'splitAll'
  | 'deleteLeft'
  | 'deleteRight'
  | 'frameBack'
  | 'frameForward'
  | 'prevEdit'
  | 'nextEdit'
  | 'fit'
  | 'export'
  // tools
  | 'toolSelect'
  | 'toolSplit'
  | 'selectLeft'
  | 'selectRight'
  | 'delete'
  | 'toggleDisable'
  | 'marker'
  | 'markIn'
  | 'markOut'
  | 'areaFromClip'
  | 'clearArea'
  | 'group'
  | 'ungroup'
  | 'compound'
  | 'undoCompound'
  | 'matchCut'
  // timeline & preview
  | 'framesBack10'
  | 'framesForward10'
  | 'home'
  | 'end'
  | 'zoomIn'
  | 'zoomOut'
  | 'fullscreenPreview'
  | 'fitPreview'
  | 'togglePreviewAxis'
  | 'escape'
  // audio & speed
  | 'extractAudio'
  | 'speedPanel'
  | 'curveSpeed'
  | 'volumeUp'
  | 'volumeDown'
  | 'toggleMagnet'
  | 'toggleSnapping'
  | 'toggleLinkage'
  | 'keyframePanel'
  // project & clipboard
  | 'importMedia'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'copyAttributes'
  | 'pasteAttributes'
  | 'duplicate'
  | 'selectAll'
  | 'libraryNext'
  | 'libraryPrev'
  | 'splitCaption';

export type Platform = 'mac' | 'win';

export interface Combo {
  /** Physical keys (`KeyboardEvent.code`). */
  codes?: string[];
  /** Named keys (`KeyboardEvent.key`), for keys that are not layout-dependent (arrows, Home…). */
  keys?: string[];
  /** Cmd on Mac / Ctrl on Windows. */
  mod?: boolean;
  /** Mac ⌃⌘ combos: both Control AND Command held. */
  ctrl?: boolean;
  /** Mac Control key alone (⌃, without ⌘), e.g. CapCut's ⇧⌃S. Shown "Ctrl" on Windows. */
  control?: boolean;
  /** The combo a context menu shows for this command (CapCut's menus show ⇧⌃S, not ⇧⌘S). */
  menu?: boolean;
  shift?: boolean | 'any';
  /** Alt on Windows / Option on Mac. */
  alt?: boolean;
  /** Show this combo only on one platform (it is still accepted everywhere). */
  only?: Platform;
}

export type ShortcutGroup = 'Essentials' | 'Tools' | 'Timeline & preview' | 'Audio & speed' | 'Project & clipboard';
export const SHORTCUT_GROUPS: ShortcutGroup[] = ['Essentials', 'Tools', 'Timeline & preview', 'Audio & speed', 'Project & clipboard'];

/**
 * works   — does what CapCut does;
 * soon    — the key is known and answers with a "Coming soon" toast (feature is later);
 * browser — a browser tab cannot take this key (listed for completeness, not bound);
 * native  — handled by the browser or a text field / mouse gesture, listed for completeness.
 */
export type ShortcutStatus = 'works' | 'soon' | 'browser' | 'native';

export interface ShortcutDef {
  label: string;
  group: ShortcutGroup;
  /** Bound command. Absent for `browser` / `native` rows. */
  command?: Command;
  combos: Combo[];
  status: ShortcutStatus;
  /** Still fires while typing in a text field (⌘E). */
  whileTyping?: boolean;
  /** Shown instead of the combos (mouse gestures). */
  text?: Record<Platform, string>;
  note?: string;
}

const L = (letter: string, m: Omit<Combo, 'codes'> = {}): Combo => ({ codes: [`Key${letter.toUpperCase()}`], ...m });

export const SHORTCUTS: ShortcutDef[] = [
  // ---------------------------------------------------------------- Essentials
  { group: 'Essentials', label: 'Play / pause', command: 'playPause', status: 'works', combos: [{ codes: ['Space'], keys: [' '] }] },
  { group: 'Essentials', label: 'Split', command: 'split', status: 'works', combos: [L('b', { mod: true })] },
  { group: 'Essentials', label: 'Split all tracks', command: 'splitAll', status: 'works', combos: [L('b', { mod: true, shift: true })] },
  { group: 'Essentials', label: 'Delete left', command: 'deleteLeft', status: 'works', combos: [L('q')] },
  { group: 'Essentials', label: 'Delete right', command: 'deleteRight', status: 'works', combos: [L('w')] },
  { group: 'Essentials', label: 'Previous frame', command: 'frameBack', status: 'works', combos: [{ keys: ['ArrowLeft'] }] },
  { group: 'Essentials', label: 'Next frame', command: 'frameForward', status: 'works', combos: [{ keys: ['ArrowRight'] }] },
  { group: 'Essentials', label: 'Previous edit point', command: 'prevEdit', status: 'works', combos: [{ keys: ['ArrowUp'] }] },
  { group: 'Essentials', label: 'Next edit point', command: 'nextEdit', status: 'works', combos: [{ keys: ['ArrowDown'] }] },
  { group: 'Essentials', label: 'Fit timeline', command: 'fit', status: 'works', combos: [L('z', { shift: true })] },
  { group: 'Essentials', label: 'Export', command: 'export', status: 'works', whileTyping: true, combos: [L('e', { mod: true })] },

  // ---------------------------------------------------------------- Tools
  // the four cursor tools of CapCut's timeline dropdown (./tools.ts, docs/research/07-tool-modes.md)
  { group: 'Tools', label: 'Select tool', command: 'toolSelect', status: 'works', combos: [L('a')] },
  { group: 'Tools', label: 'Split tool (click a clip to cut it)', command: 'toolSplit', status: 'works', combos: [L('b')] },
  {
    group: 'Tools',
    label: 'Select leftward tool',
    command: 'selectLeft',
    status: 'works',
    combos: [{ codes: ['BracketLeft'] }],
    note: 'Selects the clips left of the playhead; a click selects left of the click',
  },
  {
    group: 'Tools',
    label: 'Select rightward tool',
    command: 'selectRight',
    status: 'works',
    combos: [{ codes: ['BracketRight'] }],
    note: 'Selects the clips right of the playhead; a click selects right of the click',
  },
  { group: 'Tools', label: 'Delete', command: 'delete', status: 'works', combos: [{ keys: ['Backspace'], codes: ['Backspace'] }, { keys: ['Delete'], codes: ['Delete'] }] },
  { group: 'Tools', label: 'Enable / disable clip', command: 'toggleDisable', status: 'works', combos: [L('v')] },
  { group: 'Tools', label: 'Add marker', command: 'marker', status: 'works', combos: [L('m')] },
  { group: 'Tools', label: 'Mark in', command: 'markIn', status: 'works', combos: [L('i')] },
  { group: 'Tools', label: 'Mark out', command: 'markOut', status: 'works', combos: [L('o')] },
  { group: 'Tools', label: 'Select area by clip', command: 'areaFromClip', status: 'works', combos: [L('x', { shift: true })] },
  { group: 'Tools', label: 'Clear area', command: 'clearArea', status: 'works', combos: [L('x', { alt: true })] },
  { group: 'Tools', label: 'Group', command: 'group', status: 'soon', combos: [L('g', { mod: true })] },
  { group: 'Tools', label: 'Ungroup', command: 'ungroup', status: 'soon', combos: [L('g', { mod: true, shift: true })] },
  { group: 'Tools', label: 'Create compound clip', command: 'compound', status: 'works', combos: [L('g', { alt: true })] },
  { group: 'Tools', label: 'Undo compound clip', command: 'undoCompound', status: 'works', combos: [L('g', { alt: true, shift: true })] },
  { group: 'Tools', label: 'Match cut', command: 'matchCut', status: 'soon', combos: [L('j', { mod: true })] },

  // ---------------------------------------------------------------- Timeline & preview
  { group: 'Timeline & preview', label: 'Back 10 frames', command: 'framesBack10', status: 'works', combos: [{ keys: ['ArrowLeft'], shift: true }] },
  { group: 'Timeline & preview', label: 'Forward 10 frames', command: 'framesForward10', status: 'works', combos: [{ keys: ['ArrowRight'], shift: true }] },
  { group: 'Timeline & preview', label: 'First frame', command: 'home', status: 'works', combos: [{ keys: ['Home'] }] },
  { group: 'Timeline & preview', label: 'Last frame', command: 'end', status: 'works', combos: [{ keys: ['End'] }] },
  {
    group: 'Timeline & preview',
    label: 'Zoom in timeline',
    command: 'zoomIn',
    status: 'works',
    combos: [
      { codes: ['Equal', 'NumpadAdd'], keys: ['=', '+'], mod: true, shift: 'any' },
      { codes: ['Equal', 'NumpadAdd'], keys: ['=', '+'], shift: 'any' },
    ],
  },
  {
    group: 'Timeline & preview',
    label: 'Zoom out timeline',
    command: 'zoomOut',
    status: 'works',
    combos: [
      { codes: ['Minus', 'NumpadSubtract'], keys: ['-', '_'], mod: true, shift: 'any' },
      { codes: ['Minus', 'NumpadSubtract'], keys: ['-', '_'], shift: 'any' },
    ],
  },
  { group: 'Timeline & preview', label: 'Zoom with the wheel', status: 'native', combos: [], text: { mac: '⌘ + scroll', win: 'Ctrl + scroll' } },
  { group: 'Timeline & preview', label: 'Scroll horizontally', status: 'native', combos: [], text: { mac: '⌥ + scroll / ⇧ + scroll', win: 'Alt + scroll / Shift + scroll' } },
  {
    group: 'Timeline & preview',
    label: 'Full-screen preview',
    command: 'fullscreenPreview',
    status: 'works',
    combos: [L('f', { ctrl: true, only: 'mac' }), L('f', { mod: true, shift: true })],
  },
  { group: 'Timeline & preview', label: 'Exit full screen', status: 'native', combos: [{ keys: ['Escape'] }] },
  { group: 'Timeline & preview', label: 'Fit preview to window', command: 'fitPreview', status: 'works', combos: [L('z', { alt: true, shift: true })] },
  { group: 'Timeline & preview', label: 'Preview axis', command: 'togglePreviewAxis', status: 'works', combos: [L('s')] },
  { group: 'Timeline & preview', label: 'Ignore snapping while dragging', status: 'native', combos: [], text: { mac: 'hold ⌥', win: 'hold Alt' } },
  { group: 'Timeline & preview', label: 'Back to Select tool / cancel / deselect / clear area', command: 'escape', status: 'works', combos: [{ keys: ['Escape'], codes: ['Escape'] }] },

  // ---------------------------------------------------------------- Audio & speed
  { group: 'Audio & speed', label: 'Extract / restore audio', command: 'extractAudio', status: 'works', combos: [L('s', { mod: true, shift: true }), L('s', { control: true, shift: true, only: 'mac', menu: true })] },
  { group: 'Audio & speed', label: 'Speed', command: 'speedPanel', status: 'works', combos: [L('r', { mod: true })] },
  { group: 'Audio & speed', label: 'Curve speed', command: 'curveSpeed', status: 'works', combos: [L('b', { shift: true })] },
  { group: 'Audio & speed', label: 'Volume up 1 dB', command: 'volumeUp', status: 'works', combos: [{ codes: ['Period'], mod: true }] },
  { group: 'Audio & speed', label: 'Volume down 1 dB', command: 'volumeDown', status: 'works', combos: [{ codes: ['Comma'], mod: true }] },
  { group: 'Audio & speed', label: 'Main track magnet', command: 'toggleMagnet', status: 'works', combos: [L('p')] },
  { group: 'Audio & speed', label: 'Auto snapping', command: 'toggleSnapping', status: 'works', combos: [L('n')] },
  { group: 'Audio & speed', label: 'Linkage', command: 'toggleLinkage', status: 'works', combos: [{ codes: ['Backquote'], shift: 'any' }] },
  { group: 'Audio & speed', label: 'Show / hide keyframes', command: 'keyframePanel', status: 'soon', combos: [L('k', { alt: true })] },

  // ---------------------------------------------------------------- Project & clipboard
  { group: 'Project & clipboard', label: 'New project', status: 'browser', combos: [L('n', { mod: true })], note: 'The browser keeps this key' },
  { group: 'Project & clipboard', label: 'Import media', command: 'importMedia', status: 'works', combos: [L('i', { mod: true })] },
  { group: 'Project & clipboard', label: 'Undo', command: 'undo', status: 'works', combos: [L('z', { mod: true })] },
  { group: 'Project & clipboard', label: 'Redo', command: 'redo', status: 'works', combos: [L('z', { mod: true, shift: true }), L('y', { mod: true, only: 'win' })] },
  { group: 'Project & clipboard', label: 'Copy', command: 'copy', status: 'works', combos: [L('c', { mod: true })] },
  { group: 'Project & clipboard', label: 'Cut', command: 'cut', status: 'works', combos: [L('x', { mod: true })] },
  { group: 'Project & clipboard', label: 'Paste', command: 'paste', status: 'works', combos: [L('v', { mod: true })] },
  { group: 'Project & clipboard', label: 'Copy attributes', command: 'copyAttributes', status: 'works', combos: [L('c', { mod: true, alt: true })] },
  {
    group: 'Project & clipboard',
    label: 'Paste attributes',
    command: 'pasteAttributes',
    status: 'works',
    combos: [L('v', { mod: true, alt: true })],
    note: 'Opens a dialog to choose which attributes to paste onto the selected clips',
  },
  { group: 'Project & clipboard', label: 'Duplicate', command: 'duplicate', status: 'works', combos: [L('d', { mod: true })] },
  { group: 'Project & clipboard', label: 'Select all', command: 'selectAll', status: 'works', combos: [L('a', { mod: true })] },
  { group: 'Project & clipboard', label: 'Next library tab', command: 'libraryNext', status: 'works', combos: [{ codes: ['Tab'], keys: ['Tab'] }] },
  { group: 'Project & clipboard', label: 'Previous library tab', command: 'libraryPrev', status: 'works', combos: [{ codes: ['Tab'], keys: ['Tab'], shift: true }] },
  { group: 'Project & clipboard', label: 'Split caption', command: 'splitCaption', status: 'soon', combos: [{ codes: ['Enter', 'NumpadEnter'], keys: ['Enter'] }] },
  { group: 'Project & clipboard', label: 'Line break in text', status: 'native', combos: [], text: { mac: '⌘↩ in the text box', win: 'Ctrl+Enter in the text box' } },
  { group: 'Project & clipboard', label: 'Quit', status: 'browser', combos: [L('q', { mod: true })], note: 'Close the tab instead' },
];

/** Bound definitions (have a command and are not browser-reserved). */
const BOUND = SHORTCUTS.filter((d) => d.command && (d.status === 'works' || d.status === 'soon'));

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function comboMatches(c: Combo, e: KeyLike): boolean {
  const both = e.metaKey && e.ctrlKey;
  if (c.control) {
    if (!e.ctrlKey || e.metaKey) return false;
  } else if (c.ctrl) {
    if (!both) return false;
  } else {
    if (both) return false;
    if (!!c.mod !== (e.metaKey || e.ctrlKey)) return false;
  }
  if (!!c.alt !== e.altKey) return false;
  if (c.shift !== 'any' && !!c.shift !== e.shiftKey) return false;
  return (!!c.codes && c.codes.includes(e.code)) || (!!c.keys && c.keys.includes(e.key));
}

/** The definition a keydown triggers, or null. Pure. */
export function resolveDef(e: KeyLike): ShortcutDef | null {
  for (const d of BOUND) if (d.combos.some((c) => comboMatches(c, e))) return d;
  return null;
}

/** Maps a keydown to a command, or null. Pure; platform independent (Cmd and Ctrl both count). */
export function resolveShortcut(e: KeyLike): Command | null {
  return resolveDef(e)?.command ?? null;
}

export const defOf = (cmd: Command): ShortcutDef | undefined => SHORTCUTS.find((d) => d.command === cmd);

// ---------------------------------------------------------------- display

export function detectPlatform(): Platform {
  const nav = (globalThis as { navigator?: Navigator & { userAgentData?: { platform?: string } } }).navigator;
  const p = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(p) ? 'mac' : 'win';
}

const KEY_NAMES: Record<string, { mac: string; win: string }> = {
  Space: { mac: 'Space', win: 'Space' },
  ' ': { mac: 'Space', win: 'Space' },
  ArrowLeft: { mac: '←', win: '←' },
  ArrowRight: { mac: '→', win: '→' },
  ArrowUp: { mac: '↑', win: '↑' },
  ArrowDown: { mac: '↓', win: '↓' },
  Backspace: { mac: '⌫', win: 'Backspace' },
  Delete: { mac: '⌦', win: 'Delete' },
  Escape: { mac: 'Esc', win: 'Esc' },
  Enter: { mac: 'Return', win: 'Enter' },
  Tab: { mac: 'Tab', win: 'Tab' },
  Home: { mac: 'Home', win: 'Home' },
  End: { mac: 'End', win: 'End' },
  BracketLeft: { mac: '[', win: '[' },
  BracketRight: { mac: ']', win: ']' },
  Backquote: { mac: '~', win: '~' },
  Period: { mac: '.', win: '.' },
  Comma: { mac: ',', win: ',' },
  Equal: { mac: '=', win: '=' },
  Minus: { mac: '−', win: '−' },
};

function keyName(c: Combo, platform: Platform): string {
  const raw = c.codes?.[0] ?? c.keys?.[0] ?? '';
  if (raw.startsWith('Key')) return raw.slice(3);
  return KEY_NAMES[raw]?.[platform] ?? raw;
}

/** "⇧⌘B" on Mac (Apple order ⌃⌥⇧⌘), "Ctrl+Shift+B" on Windows. */
export function formatCombo(c: Combo, platform: Platform): string {
  const key = keyName(c, platform);
  const shift = c.shift === true;
  // written the way CapCut's menus write it: ⇧⌃S
  if (c.control && platform === 'mac') return `${c.alt ? '⌥' : ''}${shift ? '⇧' : ''}⌃${key}`;
  if (c.control) return ['Ctrl', c.alt ? 'Alt' : '', shift ? 'Shift' : '', key].filter(Boolean).join('+');
  if (platform === 'mac') return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${shift ? '⇧' : ''}${c.mod || c.ctrl ? '⌘' : ''}${key}`;
  return [c.mod || c.ctrl ? 'Ctrl' : '', c.alt ? 'Alt' : '', shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

/** Combos shown on `platform` (drops the other platform's `only` combos). */
export const visibleCombos = (d: ShortcutDef, platform: Platform): Combo[] => d.combos.filter((c) => !c.only || c.only === platform);

/** All the keys of a definition for display, e.g. "⌫ / ⌦". */
export function formatDef(d: ShortcutDef, platform: Platform): string {
  if (d.text) return d.text[platform];
  return visibleCombos(d, platform)
    .map((c) => formatCombo(c, platform))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(' / ');
}

/** The primary key of a command for tooltips ("⌘B"); '' when unbound. */
export function shortcutLabel(cmd: Command, platform: Platform = detectPlatform()): string {
  const d = defOf(cmd);
  const c = d && visibleCombos(d, platform)[0];
  return c ? formatCombo(c, platform) : '';
}

/** The key a context menu shows for a command: the `menu` combo when there is one, else the primary. */
export function menuShortcutLabel(cmd: Command, platform: Platform = detectPlatform()): string {
  const d = defOf(cmd);
  if (!d) return '';
  const vis = visibleCombos(d, platform);
  const c = vis.find((x) => x.menu) ?? vis[0];
  return c ? formatCombo(c, platform) : '';
}

/** "Split (⌘B)". */
export const withShortcut = (title: string, cmd: Command, platform?: Platform): string => {
  const k = shortcutLabel(cmd, platform);
  return k ? `${title} (${k})` : title;
};
