/**
 * The clip right-click menu's "Edit ›" submenu (CapCut desktop). Registered in the context-menu
 * registry under the 'edit' slot. Items: Mirror, Rotate, Crop, Reverse, Freeze, Replace clip —
 * see docs/research/08-context-edit-menu.md for what is verified about CapCut's own menu.
 * Every item is one undo step (store.editProject); the pure ops are in ./editOps.ts.
 */
import { mediaTimeAt, clamp, clipContains } from '../model/time';
import { findClip } from '../model/project';
import type { Clip, Id, Project, Us } from '../model/types';
import { useEditor } from '../store';
import { getBlob } from '../store/persistence';
import { showToast } from '../ui/appEvents';
import { registerSlot } from '../timeline/contextMenu/registry';
import type { MenuCtx, MenuItem } from '../timeline/contextMenu/types';
import { FREEZE_DURATION, insertFreeze, replaceClip, rotate90, toggleMirror, toggleReverse } from './editOps';

const clipOf = (id: Id): Clip | undefined => findClip(useEditor.getState().project, id)?.clip;
const unlocked = (id: Id): boolean => {
  const f = findClip(useEditor.getState().project, id);
  return !!f && !f.track.locked;
};
const anyVisual = (ctx: MenuCtx) => ctx.clipIds.some((id) => unlocked(id) && clipOf(id)?.type !== 'audio');
const primaryType = (ctx: MenuCtx) => (unlocked(ctx.primaryId) ? clipOf(ctx.primaryId)?.type : undefined);

// ---------------------------------------------------------------- async helpers

const loadBlob = (project: Project) => async (assetId: Id): Promise<Blob | null> => {
  const a = project.assets[assetId];
  if (!a || a.missing) return null;
  return getBlob(a.blobKey).catch(() => null);
};

/**
 * The source frame a video clip shows at timeline time t (raw, before its look), as a PNG,
 * decoded with the export's frame source (same frame, same colour handling as the export).
 */
export async function captureClipFrame(project: Project, clipId: Id, t: Us): Promise<Blob | null> {
  const c = findClip(project, clipId)?.clip;
  if (!c || c.type !== 'video') return null;
  const asset = project.assets[c.assetId];
  if (!asset || asset.missing) return null;
  const { ExportFrameSource } = await import('../export/frameSource');
  const src = new ExportFrameSource(project, loadBlob(project));
  try {
    const op = {
      kind: 'media',
      mediaType: 'video',
      clipId,
      assetId: c.assetId,
      sourceTime: clamp(mediaTimeAt(c, t, asset.duration), 0, Math.max(0, asset.duration - 1)),
      reversed: c.reversed === true,
    } as unknown as import('../engine/frameState').MediaDrawOp;
    await src.prepare({ ops: [op] } as unknown as import('../engine/frameState').FrameState);
    const img = src.get(op);
    if (!img || img === 'missing') return null;
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d')?.drawImage(img.image, 0, 0, img.width, img.height);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    await src.dispose();
  }
}

/**
 * Freeze: captures the frame at `t`, imports it as an image and inserts a 3 s still there
 * (one undo step for the timeline change). Returns the still's clip id.
 */
export async function freezeAt(clipId: Id, t: Us, duration: Us = FREEZE_DURATION): Promise<Id | null> {
  const st = useEditor.getState();
  const c = findClip(st.project, clipId)?.clip;
  if (!c || c.type !== 'video' || !clipContains(c, t)) {
    showToast('Put the playhead on a video clip to freeze a frame');
    return null;
  }
  const png = await captureClipFrame(st.project, clipId, t);
  if (!png) {
    showToast('Could not read that frame');
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File([png], `${c.name.replace(/\.[^.]+$/, '')} freeze ${stamp}.png`, { type: 'image/png' });
  const res = await useEditor.getState().importFiles([file]);
  const assetId = res.assetIds[0];
  if (!assetId) {
    showToast(res.errors[0] ?? 'Could not add the freeze frame');
    return null;
  }
  const id = useEditor.getState().editProject((d) => insertFreeze(d, clipId, t, assetId, duration));
  if (id) useEditor.getState().select([id]);
  return id;
}

/** Replace clip with an asset already in the media pool. One undo step. */
export function replaceWithAsset(clipId: Id, assetId: Id): boolean {
  const r = useEditor.getState().editProject((d) => replaceClip(d, clipId, assetId));
  if (!r.ok) showToast(r.reason);
  return r.ok;
}

/** Replace clip: opens a file picker; the picked file is imported and replaces the clip. */
export function pickReplacement(clipId: Id): void {
  const c = clipOf(clipId);
  if (!c) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = c.type === 'audio' ? 'audio/*,video/*' : 'video/*,image/*';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    void useEditor.getState().importFiles([file]).then((res) => {
      const id = res.assetIds[0];
      if (id) replaceWithAsset(clipId, id);
      else showToast(res.errors[0] ?? 'Could not import that file');
    });
  });
  document.body.appendChild(input);
  input.click();
}

export async function openCrop(clipId: Id): Promise<void> {
  const { openCropDialog } = await import('./CropDialog');
  openCropDialog(clipId);
}

// ---------------------------------------------------------------- the submenu

const edit = <T,>(recipe: (d: Project) => T): T => useEditor.getState().editProject(recipe);

export const EDIT_ITEMS: MenuItem[] = [
  { id: 'edit.mirror', label: 'Mirror', icon: 'mirror', disabled: (c) => !anyVisual(c), run: (c) => void edit((d) => toggleMirror(d, c.clipIds)) },
  { id: 'edit.rotate', label: 'Rotate', icon: 'rotate', disabled: (c) => !anyVisual(c), run: (c) => void edit((d) => rotate90(d, c.clipIds)) },
  {
    id: 'edit.crop',
    label: 'Crop',
    icon: 'crop',
    disabled: (c) => primaryType(c) !== 'video' && primaryType(c) !== 'image',
    run: (c) => void openCrop(c.primaryId),
  },
  {
    id: 'edit.reverse',
    label: 'Reverse',
    icon: 'reverse',
    disabled: (c) => primaryType(c) !== 'video' && primaryType(c) !== 'audio',
    run: (c) => void edit((d) => toggleReverse(d, c.clipIds)),
  },
  {
    id: 'edit.freeze',
    label: 'Freeze',
    icon: 'freeze',
    disabled: (c) => {
      const clip = primaryType(c) === 'video' ? clipOf(c.primaryId) : undefined;
      return !clip || !clipContains(clip, c.time);
    },
    run: (c) => void freezeAt(c.primaryId, c.time),
  },
  {
    id: 'edit.replace',
    label: 'Replace clip',
    icon: 'replace',
    disabled: (c) => !primaryType(c) || primaryType(c) === 'text' || primaryType(c) === 'compound',
    run: (c) => pickReplacement(c.primaryId),
  },
];

export const editMenuItem: MenuItem = {
  id: 'edit',
  label: 'Edit',
  hidden: (c) => c.clipIds.length === 0,
  submenu: () => EDIT_ITEMS,
};

registerSlot('edit', editMenuItem);

// Dev-only handle for e2e (stripped from production builds).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __oeEdit?: unknown }).__oeEdit = {
    items: EDIT_ITEMS,
    run: (id: string, ctx: MenuCtx) => EDIT_ITEMS.find((i) => i.id === id)?.run?.(ctx),
    freezeAt,
    replaceWithAsset,
    openCrop,
  };
}
