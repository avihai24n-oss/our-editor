/**
 * CapCut clip right-click › "Copy/paste attributes ›" (Copy attributes ⌥⌘C, Paste attributes ⌥⌘V).
 *
 * Copy takes the primary clip's attribute groups into the attribute clipboard (timeline UI store).
 * Paste opens a small dialog (./AttributesDialog) with one checkbox per group that the copied clip
 * has AND at least one target supports, then applies the ticked groups to every target clip as ONE
 * undo step (a store transaction). Speed goes through setSpeed / setSpeedCurve so durations are
 * recomputed and the model stays valid; everything else goes through updateClip (normalize clamps
 * animation and fade lengths to the new clip length).
 */
import { create } from 'zustand';
import { findClip } from '../model/project';
import type { SpeedCurve } from '../model/speedCurve';
import type {
  Adjust,
  AudioProps,
  BlendMode,
  CanvasBackground,
  ChromaKey,
  Clip,
  ClipAnimation,
  ClipMask,
  ClipPatch,
  ColorGrade,
  Crop,
  FilterRef,
  Id,
  Project,
  TextStyle,
  TrackKind,
  Transform,
} from '../model/types';
import { useEditor } from '../store';
import { registerSlot } from '../timeline/contextMenu/registry';
import type { MenuCtx, MenuItem } from '../timeline/contextMenu/types';
import { shortcutLabel } from '../timeline/shortcutDefs';
import { useTimelineUi } from '../timeline/uiStore';
import { showToast } from '../ui/appEvents';

// ---------------------------------------------------------------- groups

export type AttrGroup = 'transform' | 'blend' | 'mask' | 'chroma' | 'canvas' | 'speed' | 'animation' | 'adjust' | 'audio' | 'text';

/** Dialog order and labels (CapCut-style names; see the note in the branch report). */
export const ATTR_GROUPS: { id: AttrGroup; label: string }[] = [
  { id: 'transform', label: 'Transform' },
  { id: 'blend', label: 'Blend' },
  { id: 'mask', label: 'Mask' },
  { id: 'chroma', label: 'Chroma key' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'speed', label: 'Speed' },
  { id: 'animation', label: 'Animation' },
  { id: 'adjust', label: 'Adjust & filter' },
  { id: 'audio', label: 'Audio' },
  { id: 'text', label: 'Text style' },
];

export interface AttributeData {
  transform: Omit<Transform, 'opacity'> & { crop: Crop };
  blend: { blend: BlendMode; blendEnabled: boolean; opacity: number };
  mask: ClipMask;
  chroma: ChromaKey;
  canvas: CanvasBackground;
  speed: { speed: number; speedCurve: SpeedCurve | null; preservePitch: boolean };
  animation: { in: ClipAnimation | null; out: ClipAnimation | null; combo: ClipAnimation | null; loop: ClipAnimation | null };
  adjust: { filter: FilterRef | null; adjust: Adjust; adjustEnabled: boolean; grade: ColorGrade };
  audio: Omit<AudioProps, 'muted'>;
  text: Omit<TextStyle, 'content'>;
}

export interface AttributeSnapshot {
  sourceId: Id;
  sourceType: Clip['type'];
  groups: Partial<AttributeData>;
}

/** True when a clip of this type (on a track of this kind) has the group. */
export function groupApplies(g: AttrGroup, clip: Clip, trackKind: TrackKind): boolean {
  const t = clip.type;
  switch (g) {
    case 'transform':
    case 'blend':
    case 'animation':
    case 'adjust':
      return t !== 'audio';
    case 'mask':
    case 'chroma':
      return t === 'video' || t === 'image';
    case 'canvas':
      // CapCut shows Canvas only for main-track clips
      return (t === 'video' || t === 'image') && trackKind === 'main';
    case 'speed':
    case 'audio':
      return t === 'video' || t === 'audio';
    case 'text':
      return t === 'text';
  }
}

const clone = <T>(v: T): T => structuredClone(v);

/** Every attribute group of a clip, deep-copied (survives edits / deletion of the source). */
export function extractAttributes(p: Project, clipId: Id): AttributeSnapshot | null {
  const f = findClip(p, clipId);
  if (!f) return null;
  const c = f.clip;
  const g: Partial<AttributeData> = {};
  const has = (x: AttrGroup) => groupApplies(x, c, f.track.kind);
  if (c.type !== 'audio') {
    const { opacity, ...tr } = c.transform;
    if (has('transform')) g.transform = clone({ ...tr, crop: c.crop });
    if (has('blend')) g.blend = { blend: c.blend, blendEnabled: c.blendEnabled, opacity };
    if (has('animation'))
      g.animation = clone({ in: c.animationIn ?? null, out: c.animationOut ?? null, combo: c.animationCombo ?? null, loop: c.animationLoop ?? null });
    if (has('adjust')) g.adjust = clone({ filter: c.filter, adjust: c.adjust, adjustEnabled: c.adjustEnabled, grade: c.grade });
  }
  if (c.type === 'video' || c.type === 'image') {
    if (has('mask')) g.mask = clone(c.mask);
    if (has('chroma')) g.chroma = clone(c.chroma);
    if (has('canvas')) g.canvas = clone(c.canvas);
  }
  if (c.type === 'video' || c.type === 'audio') {
    g.speed = clone({ speed: c.speed, speedCurve: c.speedCurve, preservePitch: c.preservePitch });
    const { muted: _m, ...audio } = c.audio;
    g.audio = clone(audio);
  }
  if (c.type === 'text') {
    const { content: _c, ...style } = c.text;
    g.text = clone(style);
  }
  return { sourceId: c.id, sourceType: c.type, groups: g };
}

/** Groups of the snapshot that at least one of the (unlocked) target clips supports, dialog order. */
export function applicableGroups(snap: AttributeSnapshot | null, p: Project, clipIds: readonly Id[]): AttrGroup[] {
  if (!snap) return [];
  const targets = clipIds.map((id) => findClip(p, id)).filter((f): f is NonNullable<typeof f> => !!f && !f.track.locked);
  return ATTR_GROUPS.map((x) => x.id).filter((g) => snap.groups[g] !== undefined && targets.some((f) => groupApplies(g, f.clip, f.track.kind)));
}

/** The updateClip patch for the non-speed groups that apply to one target. */
function patchFor(snap: AttributeSnapshot, groups: readonly AttrGroup[], clip: Clip, trackKind: TrackKind): ClipPatch {
  const d = snap.groups;
  const patch: ClipPatch = {};
  const on = (g: AttrGroup) => groups.includes(g) && d[g] !== undefined && groupApplies(g, clip, trackKind);
  if (on('transform')) {
    const { crop, ...tr } = d.transform!;
    patch.transform = { ...tr };
    patch.crop = { ...crop };
  }
  if (on('blend')) {
    patch.blend = d.blend!.blend;
    patch.blendEnabled = d.blend!.blendEnabled;
    patch.transform = { ...patch.transform, opacity: d.blend!.opacity };
  }
  if (on('mask')) patch.mask = d.mask!;
  if (on('chroma')) patch.chroma = d.chroma!;
  if (on('canvas')) patch.canvas = d.canvas!;
  if (on('animation')) {
    const a = d.animation!;
    if (clip.type === 'text') {
      // text has In / Out / Loop (no Combo)
      patch.animationIn = a.in;
      patch.animationOut = a.out;
      patch.animationLoop = a.loop;
      patch.animationCombo = null;
    } else {
      // video / image have In / Out / Combo (no Loop); Combo excludes In / Out
      patch.animationCombo = a.combo;
      patch.animationIn = a.combo ? null : a.in;
      patch.animationOut = a.combo ? null : a.out;
      patch.animationLoop = null;
    }
  }
  if (on('adjust')) {
    const a = d.adjust!;
    patch.filter = a.filter;
    patch.adjust = a.adjust;
    patch.adjustEnabled = a.adjustEnabled;
    patch.grade = a.grade;
  }
  if (on('audio')) patch.audio = d.audio!;
  if (on('text')) patch.text = d.text!;
  if (on('speed')) patch.preservePitch = d.speed!.preservePitch;
  // targets never share nested objects with the clipboard or each other
  return clone(patch);
}

/**
 * Applies the chosen groups of `snap` to every target clip as ONE undo step. Returns the ids of
 * the clips that were changed.
 */
export function pasteAttributes(clipIds: readonly Id[], groups: readonly AttrGroup[], snap: AttributeSnapshot | null = useTimelineUi.getState().attributeClipboard): Id[] {
  if (!snap || !groups.length) return [];
  const st = useEditor.getState();
  const ownTx = !st.txBase;
  if (ownTx) st.beginTx();
  const changed: Id[] = [];
  for (const id of clipIds) {
    const before = useEditor.getState().project;
    const f = findClip(before, id);
    if (!f || f.track.locked) continue;
    const s = useEditor.getState();
    // speed first: the clip's new length is what animations and fades are clamped to
    if (groups.includes('speed') && snap.groups.speed && groupApplies('speed', f.clip, f.track.kind)) {
      const sp = snap.groups.speed;
      if (sp.speedCurve) s.setSpeedCurve(id, clone(sp.speedCurve));
      else s.setSpeed(id, sp.speed);
    }
    const patch = patchFor(snap, groups, f.clip, f.track.kind);
    if (Object.keys(patch).length) s.updateClip(id, patch);
    if (useEditor.getState().project !== before) changed.push(id);
  }
  if (ownTx) useEditor.getState().commitTx();
  return changed;
}

// ---------------------------------------------------------------- commands

/** Copy attributes: the primary clip's groups into the attribute clipboard. */
export function copyAttributes(clipId: Id | undefined): boolean {
  if (!clipId) return false;
  const snap = extractAttributes(useEditor.getState().project, clipId);
  if (!snap) return false;
  useTimelineUi.getState().setAttributeClipboard(snap);
  showToast('Attributes copied');
  return true;
}

/** Paste-attributes dialog state. */
interface PasteDialogState {
  open: boolean;
  targets: Id[];
  show: (targets: Id[]) => void;
  close: () => void;
}
export const usePasteAttributesDialog = create<PasteDialogState>()((set) => ({
  open: false,
  targets: [],
  show: (targets) => set({ open: true, targets }),
  close: () => set({ open: false, targets: [] }),
}));

/** Paste attributes: opens the dialog for the targets (or explains why it cannot). */
export function requestPasteAttributes(clipIds: readonly Id[]): boolean {
  const snap = useTimelineUi.getState().attributeClipboard;
  if (!snap) {
    showToast('Copy attributes from a clip first');
    return false;
  }
  if (!clipIds.length) {
    showToast('Select the clips to paste attributes to');
    return false;
  }
  if (!applicableGroups(snap, useEditor.getState().project, clipIds).length) {
    showToast('These attributes do not apply to the selected clips');
    return false;
  }
  usePasteAttributesDialog.getState().show([...clipIds]);
  return true;
}

/** The menu context for the keyboard shortcuts: the current selection. */
export function selectionCtx(): MenuCtx {
  const s = useEditor.getState();
  const ids = s.selection.clipIds;
  const f = ids[0] ? findClip(s.project, ids[0]) : undefined;
  return { clipIds: [...ids], primaryId: ids[0] ?? '', trackId: f?.track.id ?? '', time: s.playhead };
}

const primaryMissing = (ctx: MenuCtx) => !findClip(useEditor.getState().project, ctx.primaryId);

export const copyAttributesItem: MenuItem = {
  id: 'copyAttributes',
  label: 'Copy attributes',
  get shortcut() {
    return shortcutLabel('copyAttributes');
  },
  disabled: primaryMissing,
  run: (ctx) => void copyAttributes(ctx.primaryId),
};

export const pasteAttributesItem: MenuItem = {
  id: 'pasteAttributes',
  label: 'Paste attributes',
  get shortcut() {
    return shortcutLabel('pasteAttributes');
  },
  disabled: (ctx) => !applicableGroups(useTimelineUi.getState().attributeClipboard, useEditor.getState().project, ctx.clipIds.length ? ctx.clipIds : [ctx.primaryId]).length,
  run: (ctx) => void requestPasteAttributes(ctx.clipIds.length ? ctx.clipIds : [ctx.primaryId]),
};

export const attributesMenuItem: MenuItem = {
  id: 'attributes',
  label: 'Copy/paste attributes',
  submenu: () => [copyAttributesItem, pasteAttributesItem],
};

registerSlot('attributes', attributesMenuItem);
