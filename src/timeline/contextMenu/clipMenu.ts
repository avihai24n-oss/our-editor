/**
 * CapCut's right-click menu on a timeline clip, in CapCut's order and grouping.
 * Copy / Cut / Delete / Deactivate / Extract audio run the same commands as their shortcuts;
 * the four slots come from ./registry; AI and later-round items are disabled with a "Soon" tag.
 */
import '../../actions';
import { findClip } from '../../model/project';
import { useEditor } from '../../store';
import { runCommand, type Command } from '../shortcuts';
import { slots } from './registry';
import type { MenuCtx, MenuItem } from './types';

const off = () => true;
const soon = (id: string, label: string, icon: string, sub = false): MenuItem => ({
  id,
  label,
  icon,
  tag: 'Soon',
  disabled: off,
  ...(sub ? { submenu: () => [] } : {}),
});

/** Makes the selection the menu's clips, then runs the shortcut's command. */
function runOn(ctx: MenuCtx, cmd: Command): void {
  const s = useEditor.getState();
  const sel = s.selection.clipIds;
  if (sel.length !== ctx.clipIds.length || ctx.clipIds.some((id) => !sel.includes(id))) s.select(ctx.clipIds);
  runCommand(cmd);
}

const clipsOf = (ctx: MenuCtx) => {
  const p = useEditor.getState().project;
  return ctx.clipIds.map((id) => findClip(p, id)?.clip).filter((c) => !!c);
};

/** True when the clip's audio is already extracted (the store's toggleExtractAudio restores it). */
export function isAudioExtracted(ctx: MenuCtx): boolean {
  const videos = clipsOf(ctx).filter((c) => c.type === 'video');
  return videos.length > 0 && videos.every((c) => !!c.audioLink && c.audio.muted);
}

const slot = (name: keyof typeof slots): MenuItem[] => (slots[name] ? [slots[name]!] : []);

/** The menu for `ctx`, as groups separated by lines. */
export function buildClipMenu(ctx: MenuCtx): MenuItem[][] {
  const clips = clipsOf(ctx);
  const allDisabled = clips.length > 0 && clips.every((c) => c.disabled);
  const extracted = isAudioExtracted(ctx);
  return [
    [soon('editPilot', 'EditPilot', 'sparkle')],
    [
      { id: 'copy', label: 'Copy', icon: 'copy', shortcut: 'copy', run: (c) => runOn(c, 'copy') },
      { id: 'cut', label: 'Cut', icon: 'cut', shortcut: 'cut', run: (c) => runOn(c, 'cut') },
      ...slot('attributes'),
      { id: 'delete', label: 'Delete', icon: 'trash', shortcut: 'delete', run: (c) => runOn(c, 'delete') },
      ...slot('edit'),
    ],
    [
      soon('splitScenes', 'Split scenes', 'scenes'),
      soon('transcript', 'Transcript', 'transcript'),
      soon('generateCaptions', 'Generate captions', 'captions'),
      ...slot('isolateVoice'),
      {
        id: 'extractAudio',
        label: extracted ? 'Restore audio' : 'Extract audio',
        icon: 'extract-audio',
        shortcut: 'extractAudio',
        disabled: () => !clips.some((c) => c.type === 'video'),
        run: (c) => runOn(c, 'extractAudio'),
      },
      soon('removeBackground', 'Remove background', 'remove-bg', true),
    ],
    [
      soon('enhanceAudio', 'Enhance audio', 'enhance-audio', true),
      soon('enhanceVisuals', 'Enhance visuals', 'enhance-visuals', true),
      soon('adjustColor', 'Adjust color', 'adjust-color', true),
      soon('enhanceMotion', 'Enhance motion', 'enhance-motion', true),
    ],
    [
      // CapCut greys Group out for a single clip; grouping is a later round
      { id: 'group', label: 'Group', icon: 'group', disabled: off },
      ...slot('compound'),
      soon('savePreset', 'Save preset', 'preset'),
    ],
    [
      soon('exportSelected', 'Export selected clips', 'export'),
      {
        id: 'toggleDisable',
        label: allDisabled ? 'Activate clip' : 'Deactivate clip',
        icon: 'deactivate',
        shortcut: 'toggleDisable',
        run: (c) => runOn(c, 'toggleDisable'),
      },
      soon('moreActions', 'More clip actions', 'more', true),
    ],
    [soon('range', 'Range', 'range', true), soon('render', 'Render', 'render', true)],
  ];
}
