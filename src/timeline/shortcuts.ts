/**
 * Global keyboard shortcuts (CapCut desktop defaults). Mounted once by <Timeline>.
 * ⌘E (export) is handled by App. Letters are matched by physical key (`code`), so the shortcuts
 * also work with a Hebrew (or any non-Latin) keyboard layout.
 */
import { useEffect } from 'react';
import { findClip } from '../model/project';
import { projectDuration } from '../model/time';
import type { Clip, Id } from '../model/types';
import { useEditor } from '../store';
import { useTimelineUi } from './uiStore';

export type Command =
  | 'playPause'
  | 'split'
  | 'deleteLeft'
  | 'deleteRight'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'selectAll'
  | 'frameBack'
  | 'frameForward'
  | 'framesBack10'
  | 'framesForward10'
  | 'prevEdit'
  | 'nextEdit'
  | 'home'
  | 'end'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'marker'
  | 'toolSelect'
  | 'toolSplit'
  | 'toggleMagnet'
  | 'toggleSnapping'
  | 'togglePreviewAxis'
  | 'toggleDisable'
  | 'escape';

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Maps a keydown to a command, or null. Pure. */
export function resolveShortcut(e: KeyLike): Command | null {
  const mod = e.metaKey || e.ctrlKey;
  const letter = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : '';
  const k = e.key;

  if (mod && !e.altKey) {
    if (letter === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (letter === 'y' && !e.shiftKey) return 'redo';
    if (letter === 'b' && !e.shiftKey) return 'split';
    if (letter === 'c' && !e.shiftKey) return 'copy';
    if (letter === 'x' && !e.shiftKey) return 'cut';
    if (letter === 'v' && !e.shiftKey) return 'paste';
    if (letter === 'd' && !e.shiftKey) return 'duplicate';
    if (letter === 'a' && !e.shiftKey) return 'selectAll';
    if (k === '=' || k === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') return 'zoomIn';
    if (k === '-' || k === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') return 'zoomOut';
    return null;
  }
  if (e.altKey) return null;

  switch (k) {
    case ' ':
      return 'playPause';
    case 'Delete':
    case 'Backspace':
      return 'delete';
    case 'ArrowLeft':
      return e.shiftKey ? 'framesBack10' : 'frameBack';
    case 'ArrowRight':
      return e.shiftKey ? 'framesForward10' : 'frameForward';
    case 'ArrowUp':
      return 'prevEdit';
    case 'ArrowDown':
      return 'nextEdit';
    case 'Home':
      return 'home';
    case 'End':
      return 'end';
    case 'Escape':
      return 'escape';
    case '=':
    case '+':
      return 'zoomIn';
    case '-':
    case '_':
      return 'zoomOut';
  }
  if (e.code === 'Space') return 'playPause';
  if (e.code === 'NumpadAdd') return 'zoomIn';
  if (e.code === 'NumpadSubtract') return 'zoomOut';
  if (e.shiftKey) return letter === 'z' ? 'fit' : null;
  switch (letter) {
    case 'q':
      return 'deleteLeft';
    case 'w':
      return 'deleteRight';
    case 'm':
      return 'marker';
    case 'a':
      return 'toolSelect';
    case 'b':
      return 'toolSplit';
    case 'p':
      return 'toggleMagnet';
    case 'n':
      return 'toggleSnapping';
    case 's':
      return 'togglePreviewAxis';
    case 'v':
      return 'toggleDisable';
  }
  return null;
}

/** True when the key event comes from a text field (shortcuts must not fire while typing). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
  }
  return false;
}

// ---------------------------------------------------------------- command execution

/** Snapshots of the selected clips on unlocked tracks (for the clipboard). */
function selectedSnapshots(): Clip[] {
  const s = useEditor.getState();
  return s.selection.clipIds
    .map((id) => findClip(s.project, id))
    .filter((f): f is NonNullable<typeof f> => !!f && !f.track.locked)
    .map((f) => structuredClone(f.clip));
}

/** Pastes the clipboard clips at the playhead, keeping their relative offsets. One undo step. */
export function pasteAtPlayhead(): Id[] {
  const s = useEditor.getState();
  const clips = useTimelineUi.getState().clipboard;
  if (!clips.length) return [];
  return s.insertClips(clips, s.playhead);
}

/** V: enable/disable the selected clips (all disabled → enable, else disable). */
export function toggleDisableSelected(): void {
  const s = useEditor.getState();
  const clips = s.selection.clipIds.map((id) => findClip(s.project, id)?.clip).filter((c) => !!c);
  if (!clips.length) return;
  const allDisabled = clips.every((c) => c!.disabled);
  s.updateClips(
    clips.map((c) => c!.id),
    { disabled: !allDisabled },
  );
}

/** Runs a command. Returns false when it did nothing that needs the default prevented. */
export function runCommand(cmd: Command): boolean {
  const s = useEditor.getState();
  const ui = useTimelineUi.getState();
  switch (cmd) {
    case 'playPause':
      s.togglePlay();
      return true;
    case 'split':
      s.splitAtPlayhead();
      return true;
    case 'deleteLeft':
      s.deleteLeft();
      return true;
    case 'deleteRight':
      s.deleteRight();
      return true;
    case 'delete':
      s.deleteSelected();
      return true;
    case 'undo':
      s.undo();
      return true;
    case 'redo':
      s.redo();
      return true;
    case 'copy': {
      const snap = selectedSnapshots();
      if (!snap.length) return false;
      ui.setClipboard(snap);
      return true;
    }
    case 'cut': {
      const snap = selectedSnapshots();
      if (!snap.length) return false;
      ui.setClipboard(snap);
      s.deleteClips(snap.map((c) => c.id));
      return true;
    }
    case 'paste':
      if (!ui.clipboard.length) return false;
      pasteAtPlayhead();
      return true;
    case 'duplicate':
      s.duplicateSelected();
      return true;
    case 'selectAll':
      s.selectAll();
      return true;
    case 'frameBack':
      s.stepFrames(-1);
      return true;
    case 'frameForward':
      s.stepFrames(1);
      return true;
    case 'framesBack10':
      s.stepFrames(-10);
      return true;
    case 'framesForward10':
      s.stepFrames(10);
      return true;
    case 'prevEdit':
      s.goToPrevEdit();
      return true;
    case 'nextEdit':
      s.goToNextEdit();
      return true;
    case 'home':
      s.pause();
      s.setPlayhead(0);
      return true;
    case 'end':
      s.pause();
      s.setPlayhead(projectDuration(s.project));
      return true;
    case 'zoomIn':
      if (ui.view) ui.view.zoomBy(1.25);
      else s.zoomIn();
      return true;
    case 'zoomOut':
      if (ui.view) ui.view.zoomBy(1 / 1.25);
      else s.zoomOut();
      return true;
    case 'fit':
      ui.view?.fit();
      return true;
    case 'marker':
      s.addMarker();
      return true;
    case 'toolSelect':
      ui.setTool('select');
      return true;
    case 'toolSplit':
      ui.setTool('split');
      return true;
    case 'toggleMagnet':
      s.setMagnet(!s.magnet);
      return true;
    case 'toggleSnapping':
      s.setSnapping(!s.snapping);
      return true;
    case 'togglePreviewAxis':
      ui.setPreviewAxis(!ui.previewAxis);
      return true;
    case 'toggleDisable':
      toggleDisableSelected();
      return true;
    case 'escape':
      if (ui.tool !== 'select') ui.setTool('select');
      else if (s.selection.clipIds.length || s.selection.transitionId) s.clearSelection();
      else return false;
      return true;
  }
}

/**
 * Installs the global keydown handler. `onEscape` lets an in-progress gesture cancel itself first
 * (return true when it consumed the key).
 */
export function useTimelineShortcuts(onEscape?: () => boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      // a modal (e.g. the export dialog) is open: the editor behind it must not react
      if (document.querySelector('.modal-backdrop, [aria-modal="true"]')) return;
      const cmd = resolveShortcut(e);
      if (!cmd) return;
      if (cmd === 'escape' && onEscape?.()) {
        e.preventDefault();
        return;
      }
      // Let a focused button handle Space/Enter-like activation only when it's not ours to take.
      if (runCommand(cmd)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);
}
