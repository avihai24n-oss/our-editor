/**
 * Global keyboard shortcuts (CapCut desktop defaults). Mounted once by <Timeline>.
 * The bindings live in ./shortcutDefs (one table shared with the shortcuts panel and tooltips);
 * this file runs the commands and installs the keydown handler. Letters are matched by physical
 * key (`code`), so the shortcuts also work with a Hebrew (or any non-Latin) keyboard layout.
 */
import { useEffect } from 'react';
import { findClip } from '../model/project';
import { clipEnd, projectDuration } from '../model/time';
import type { Clip, Id } from '../model/types';
import { createCompoundClip, undoCompoundClips } from '../actions/compound';
import { useEditor } from '../store';
import { emitAppEvent, requestImport, showToast } from '../ui/appEvents';
import { defOf, resolveDef, type Command } from './shortcutDefs';
import { useTimelineUi } from './uiStore';

export type { Command, KeyLike } from './shortcutDefs';
export { resolveShortcut } from './shortcutDefs';

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

/** True for elements that act on Enter themselves (buttons, links, tabs, form fields). */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  if (isTypingTarget(el)) return true;
  const tag = el.tagName.toLowerCase();
  if (['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
  const role = el.getAttribute?.('role') ?? '';
  return ['button', 'tab', 'menuitem', 'menuitemradio', 'link', 'checkbox', 'switch', 'option'].includes(role);
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

/** Selected clips on unlocked tracks. */
function selectedClips(): Clip[] {
  const s = useEditor.getState();
  return s.selection.clipIds
    .map((id) => findClip(s.project, id))
    .filter((f): f is NonNullable<typeof f> => !!f && !f.track.locked)
    .map((f) => f.clip);
}

/** ⇧X: the in/out area spans the selected clips. */
export function areaFromSelection(): boolean {
  const clips = selectedClips();
  if (!clips.length) return false;
  const from = Math.min(...clips.map((c) => c.start));
  const to = Math.max(...clips.map(clipEnd));
  useTimelineUi.getState().setArea(from, to);
  return true;
}

/** ⌘. / ⌘, on the selected clips that have audio. */
export function nudgeSelectedVolume(deltaDb: number): number {
  const s = useEditor.getState();
  return s.nudgeVolume(s.selection.clipIds, deltaDb);
}

/** ⌘⇧S on the selected video clips. Toasts what happened. */
export function toggleExtractSelected(): boolean {
  const s = useEditor.getState();
  const videos = selectedClips().filter((c) => c.type === 'video');
  if (!videos.length) {
    showToast('Select a video clip to extract its audio');
    return true;
  }
  const r = s.toggleExtractAudio(videos.map((c) => c.id));
  if (r.extracted.length) showToast('Audio extracted');
  else if (r.restored) showToast('Audio restored');
  else showToast('This clip has no audio to extract');
  return true;
}

/** ⌘R / ⇧B: open the inspector's Speed tab (optionally the Curve sub-tab). */
function openSpeed(sub: 'standard' | 'curve'): boolean {
  const s = useEditor.getState();
  const c = s.selection.clipIds.length === 1 ? findClip(s.project, s.selection.clipIds[0]!)?.clip : undefined;
  if (!c || (c.type !== 'video' && c.type !== 'audio')) {
    showToast('Select one video or audio clip to change its speed');
    return true;
  }
  emitAppEvent('inspectorTab', { tab: 'speed', sub });
  return true;
}

const comingSoon = (cmd: Command): true => {
  showToast(`Coming soon: ${defOf(cmd)?.label ?? cmd}`);
  return true;
};

/** Runs a command. Returns false when it did nothing that needs the default prevented. */
export function runCommand(cmd: Command): boolean {
  const s = useEditor.getState();
  const ui = useTimelineUi.getState();
  switch (cmd) {
    case 'splitAll':
      s.splitAllAtPlayhead();
      return true;
    case 'export':
      emitAppEvent('export');
      return true;
    // [ / ]: select by side of the playhead now, and arm the tool so a click re-anchors it
    case 'selectLeft':
      s.selectSide('left');
      ui.setTool('selectLeft');
      return true;
    case 'selectRight':
      s.selectSide('right');
      ui.setTool('selectRight');
      return true;
    case 'markIn':
      ui.setAreaIn(s.playhead);
      return true;
    case 'markOut':
      ui.setAreaOut(s.playhead);
      return true;
    case 'areaFromClip':
      if (!areaFromSelection()) showToast('Select a clip first');
      return true;
    case 'clearArea':
      ui.clearArea();
      return true;
    case 'compound':
      createCompoundClip();
      return true;
    case 'undoCompound':
      undoCompoundClips();
      return true;
    case 'group':
    case 'ungroup':
    case 'matchCut':
    case 'splitCaption':
      return comingSoon(cmd);
    case 'keyframePanel':
      showToast('Keyframes — coming soon');
      return true;
    case 'fullscreenPreview':
      emitAppEvent('fullscreenPreview');
      return true;
    case 'fitPreview':
      emitAppEvent('fitPreview');
      return true;
    case 'extractAudio':
      return toggleExtractSelected();
    case 'speedPanel':
      return openSpeed('standard');
    case 'curveSpeed':
      return openSpeed('curve');
    case 'volumeUp':
    case 'volumeDown':
      if (!nudgeSelectedVolume(cmd === 'volumeUp' ? 1 : -1)) showToast('Select a clip with audio first');
      return true;
    case 'toggleLinkage':
      ui.setLinkage(!ui.linkage);
      return true;
    case 'importMedia':
      requestImport();
      return true;
    case 'libraryNext':
      emitAppEvent('libraryTab', { dir: 1 });
      return true;
    case 'libraryPrev':
      emitAppEvent('libraryTab', { dir: -1 });
      return true;
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
      else if (ui.area.in !== null || ui.area.out !== null) ui.clearArea();
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
      const def = resolveDef(e);
      if (!def?.command) return;
      const cmd = def.command;
      if (isTypingTarget(e.target) && !def.whileTyping) return;
      // a modal (e.g. the export dialog) is open: the editor behind it must not react
      if (document.querySelector('.modal-backdrop, [aria-modal="true"]')) return;
      // Enter belongs to whatever button / tab / link has focus
      if (cmd === 'splitCaption' && isInteractiveTarget(e.target)) return;
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
