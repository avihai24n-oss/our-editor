import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../../model/defaults';
import { findClip } from '../../model/project';
import { secToUs } from '../../model/time';
import { useEditor } from '../../store';
import { formatCombo, menuShortcutLabel, resolveShortcut, type Command } from '../shortcutDefs';
import { useTimelineUi } from '../uiStore';
import { buildClipMenu } from './clipMenu';
import { menuItemsForTest } from './testUtil';
import { registerSlot, resetSlots, slots } from './registry';
import type { MenuCtx } from './types';

const st = () => useEditor.getState();

/** CapCut's clip menu, top to bottom; '-' = separator. */
export const CAPCUT_ORDER = [
  'EditPilot', '-',
  'Copy', 'Cut', 'Copy/paste attributes', 'Delete', 'Edit', '-',
  'Split scenes', 'Transcript', 'Generate captions', 'Isolate voice', 'Extract audio', 'Remove background', '-',
  'Enhance audio', 'Enhance visuals', 'Adjust color', 'Enhance motion', '-',
  'Group', 'Create compound clip (subproject)', 'Save preset', '-',
  'Export selected clips', 'Deactivate clip', 'More clip actions', '-',
  'Range', 'Render',
];

function setup(): MenuCtx {
  const v = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: secToUs(4), width: 1080, height: 1920, hasAudio: true });
  st().addAssets([v]);
  const id = st().addClip(v.id, { at: 0 })!;
  st().select([id]);
  return { clipIds: [id], primaryId: id, trackId: findClip(st().project, id)!.track.id, time: 0 };
}

describe('clip context menu', () => {
  beforeEach(() => {
    st().newProject();
    resetSlots();
    useTimelineUi.getState().setClipboard([]);
  });

  it("lists CapCut's items in CapCut's order and grouping", () => {
    expect(menuItemsForTest(buildClipMenu(setup()))).toEqual(CAPCUT_ORDER);
  });

  it('only the in-scope items are enabled; AI / later items say Soon', () => {
    const ctx = setup();
    const items = buildClipMenu(ctx).flat();
    const enabled = items.filter((i) => !i.disabled?.(ctx)).map((i) => i.label);
    expect(enabled).toEqual(['Copy', 'Cut', 'Delete', 'Extract audio', 'Deactivate clip']);
    expect(items.find((i) => i.id === 'group')!.tag).toBeUndefined();
    for (const id of ['editPilot', 'splitScenes', 'transcript', 'generateCaptions', 'removeBackground', 'enhanceAudio', 'enhanceVisuals', 'adjustColor', 'enhanceMotion', 'savePreset', 'exportSelected', 'moreActions', 'range', 'render'])
      expect(items.find((i) => i.id === id)!.tag, id).toBe('Soon');
  });

  it('shows the CapCut keys', () => {
    const keys = Object.fromEntries(buildClipMenu(setup()).flat().filter((i) => i.shortcut).map((i) => [i.id, menuShortcutLabel(i.shortcut as Command, 'mac')]));
    expect(keys).toEqual({ copy: '⌘C', cut: '⌘X', delete: '⌫', extractAudio: '⇧⌃S', compound: '⌥G', toggleDisable: 'V' });
  });

  it('Copy, Cut, Delete, Extract / Restore audio and Deactivate run the shortcut commands', () => {
    const ctx = setup();
    const run = (id: string) => buildClipMenu(ctx).flat().find((i) => i.id === id)!.run!(ctx);
    run('copy');
    expect(useTimelineUi.getState().clipboard.map((c) => c.id)).toEqual([ctx.primaryId]);
    run('toggleDisable');
    expect(findClip(st().project, ctx.primaryId)!.clip.disabled).toBe(true);
    expect(buildClipMenu(ctx).flat().find((i) => i.id === 'toggleDisable')!.label).toBe('Activate clip');
    run('toggleDisable');
    expect(findClip(st().project, ctx.primaryId)!.clip.disabled).toBe(false);
    run('extractAudio');
    expect(st().project.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'audio')).toHaveLength(1);
    expect(buildClipMenu(ctx).flat().find((i) => i.id === 'extractAudio')!.label).toBe('Restore audio');
    run('extractAudio');
    expect(st().project.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'audio')).toHaveLength(0);
    run('cut');
    expect(findClip(st().project, ctx.primaryId)).toBeFalsy();
    expect(useTimelineUi.getState().clipboard).toHaveLength(1);
    st().undo();
    st().select([]);
    run('delete'); // runs on the menu's clips even when the selection moved
    expect(findClip(st().project, ctx.primaryId)).toBeFalsy();
  });

  it('a registered slot replaces its placeholder', () => {
    const ctx = setup();
    registerSlot('attributes', { id: 'attrs', label: 'Copy/paste attributes', submenu: () => [{ id: 'x', label: 'Copy attributes' }] });
    const item = buildClipMenu(ctx).flat().find((i) => i.id === 'attrs')!;
    expect(item.disabled).toBeUndefined();
    expect(item.submenu!(ctx)[0]!.label).toBe('Copy attributes');
    registerSlot('edit', null);
    expect(menuItemsForTest(buildClipMenu(ctx))).not.toContain('Edit');
    expect(slots.edit).toBeNull();
  });
});

describe('⇧⌃S', () => {
  const k = (m: Partial<KeyboardEvent>) => ({ key: 'S', code: 'KeyS', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, ...m });
  it('Shift+Control+S and Shift+Cmd+S both extract audio', () => {
    expect(resolveShortcut(k({ ctrlKey: true }))).toBe('extractAudio');
    expect(resolveShortcut(k({ metaKey: true }))).toBe('extractAudio');
  });
  it('is written ⇧⌃S on the Mac and Ctrl+Shift+S on Windows', () => {
    expect(formatCombo({ codes: ['KeyS'], control: true, shift: true }, 'mac')).toBe('⇧⌃S');
    expect(formatCombo({ codes: ['KeyS'], control: true, shift: true }, 'win')).toBe('Ctrl+Shift+S');
  });
});
