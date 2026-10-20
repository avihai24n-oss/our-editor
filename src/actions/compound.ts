/**
 * Compound clips (CapCut "Create compound clip" ⌥G / "Undo compound clip" ⌥⇧G, subprojects).
 *
 * Store-level actions on top of src/store/compoundOps.ts (the edits) and src/model/compound.ts
 * (the pure helpers), the clip right-click menu item (slot 'compound') and the nested-editing
 * navigation (double-click → open, breadcrumb → back).
 *
 * Opening a sequence is not an undo step: it re-frames the whole history (the document and every
 * undo / redo snapshot that shows the same timeline), so ⌘Z inside the compound undoes the last
 * edit — made inside or before — and never jumps out by itself.
 */
import { produce } from 'immer';
import { breadcrumb, canPlaceSequence, closeSequence, focusedSequenceId, openSequence, sequencesOf } from '../model/compound';
import { findClip } from '../model/project';
import type { Id, Project, Us } from '../model/types';
import { useEditor } from '../store';
import { addSequenceInstance, compoundBlocker, createCompound, renameSequence, ungroupCompound } from '../store/compoundOps';
import { minClipUs, normalize } from '../store/ops';
import { showToast } from '../ui/appEvents';
import { registerSlot } from '../timeline/contextMenu/registry';
import type { MenuCtx, MenuItem } from '../timeline/contextMenu/types';

const st = () => useEditor.getState();

/** Why the clips cannot become one compound clip (null = they can). */
export const compoundBlockedReason = (clipIds: readonly Id[]): string | null => compoundBlocker(st().project, clipIds);

/** ⌥G: the given clips (default: the selection) become one compound clip. One undo step. Selects it. */
export function createCompoundClip(clipIds: readonly Id[] = st().selection.clipIds): Id | null {
  const why = compoundBlockedReason(clipIds);
  if (why) {
    showToast(why === 'Select clips first' ? 'Select clips to make a compound clip' : `Cannot make a compound clip: ${why}`);
    return null;
  }
  const id = st().applyEdit((d, ctx) => createCompound(d, clipIds, ctx));
  if (id) useEditor.setState({ selection: { clipIds: [id], transitionId: null } });
  return id;
}

/** ⌥⇧G: every compound clip among the ids (default: the selection) is expanded back. One undo step. */
export function undoCompoundClips(clipIds: readonly Id[] = st().selection.clipIds): Id[] {
  const p = st().project;
  const targets = clipIds.filter((id) => findClip(p, id)?.clip.type === 'compound');
  if (!targets.length) {
    showToast('Select a compound clip first');
    return [];
  }
  const out = st().applyEdit((d, ctx) => targets.flatMap((id) => ungroupCompound(d, id, ctx)));
  if (out.length) useEditor.setState({ selection: { clipIds: out, transitionId: null } });
  return out;
}

const isCompound = (id: Id): boolean => findClip(st().project, id)?.clip.type === 'compound';

/** The compound instance each open level was entered from (UI only: maps the playhead back). */
const enteredFrom: { clipId: Id; start: Us; inPoint: Us }[] = [];

const sameStack = (a: Project, b: Project): boolean => {
  const x = a.focus ?? [];
  const y = b.focus ?? [];
  return x.length === y.length && x.every((f, i) => f.sequenceId === y[i]!.sequenceId);
};

/** Applies a document transform to the document and every history snapshot showing the same timeline. */
function reframe(fn: (p: Project) => Project, after: Partial<ReturnType<typeof st>> = {}): void {
  const s = st();
  if (s.txBase) s.commitTx();
  const cur = st().project;
  const map = (p: Project) => (sameStack(p, cur) ? fn(p) : p);
  useEditor.setState((x) => ({
    project: fn(x.project),
    past: x.past.map(map),
    future: x.future.map(map),
    txBase: null,
    selection: { clipIds: [], transitionId: null },
    playing: false,
    previewTime: null,
    ...after,
  }));
}

/** Double-click: opens the compound clip's sequence in the timeline. Edits there change every instance. */
export function openCompound(clipId: Id): boolean {
  const f = findClip(st().project, clipId);
  if (!f || f.clip.type !== 'compound') return false;
  const c = f.clip;
  if (!sequencesOf(st().project)[c.sequenceId] || (st().project.focus ?? []).some((x) => x.sequenceId === c.sequenceId)) return false;
  const local = Math.max(0, c.inPoint + Math.min(Math.max(0, st().playhead - c.start), c.duration));
  enteredFrom.push({ clipId: c.id, start: c.start, inPoint: c.inPoint });
  reframe((p) => openSequence(p, c.sequenceId), { playhead: local });
  return true;
}

/** Closes open sequences until `level` remain open (0 = back to the main timeline). */
export function closeCompoundTo(level = 0): void {
  while ((st().project.focus ?? []).length > level) {
    const magnet = st().magnet;
    const min = minClipUs(st().project);
    const from = enteredFrom.pop();
    const local = st().playhead;
    reframe(
      (p) => {
        const id = focusedSequenceId(p);
        const closed = closeSequence(p, min);
        // instances whose length followed the sequence may need the main track rippled
        const resized = !!id && closed.sequences?.[id]?.duration !== p.sequences?.[id]?.duration;
        return resized ? produce(closed, (d) => normalize(d, { magnet })) : closed;
      },
      { playhead: from ? Math.max(0, from.start + (local - from.inPoint)) : 0 },
    );
    if (from) useEditor.setState({ selection: findClip(st().project, from.clipId) ? { clipIds: [from.clipId], transitionId: null } : { clipIds: [], transitionId: null } });
  }
}

/** Breadcrumb of the timeline ("Main › Compound 1"). */
export const timelineBreadcrumb = (p: Project = st().project) => breadcrumb(p);
export const openSequenceId = (p: Project = st().project) => focusedSequenceId(p);

/** Media › Subprojects: another instance of a sequence on the open timeline. One undo step. Selects it. */
export function addSubproject(sequenceId: Id, opts: { at?: Us; trackId?: Id; kind?: 'main' | 'overlay' } = {}): Id | null {
  if (!canPlaceSequence(st().project, sequenceId)) {
    showToast('A compound clip cannot contain itself');
    return null;
  }
  const id = st().applyEdit((d, ctx) => addSequenceInstance(d, sequenceId, { at: opts.at ?? st().playhead, trackId: opts.trackId, kind: opts.kind }, ctx));
  if (id) useEditor.setState({ selection: { clipIds: [id], transitionId: null } });
  return id;
}

export const renameSubproject = (sequenceId: Id, name: string): boolean => st().applyEdit((d) => renameSequence(d, sequenceId, name));

// ---------------------------------------------------------------- right-click menu (slot 'compound')

const ungroupMode = (ctx: Pick<MenuCtx, 'clipIds' | 'primaryId'>): boolean => {
  const ids = ctx.clipIds.length ? ctx.clipIds : [ctx.primaryId];
  return ids.length > 0 && ids.every(isCompound);
};

const currentMenuCtx = (): MenuCtx => {
  const s = st();
  const ids = s.selection.clipIds;
  const f = ids[0] ? findClip(s.project, ids[0]) : undefined;
  return { clipIds: ids, primaryId: ids[0] ?? '', trackId: f?.track.id ?? '', time: s.playhead };
};

/**
 * "Create compound clip" ⌥G, or — when every clicked clip is already a compound — "Undo compound
 * clip" ⌥⇧G. The label and shortcut follow the current selection (read when the menu renders).
 */
export const compoundMenuItem: MenuItem = {
  id: 'compound',
  get label() {
    return ungroupMode(currentMenuCtx()) ? 'Undo compound clip' : 'Create compound clip';
  },
  get shortcut() {
    return ungroupMode(currentMenuCtx()) ? '⌥⇧G' : '⌥G';
  },
  icon: 'compound',
  disabled: (ctx) => {
    const ids = ctx.clipIds.length ? ctx.clipIds : [ctx.primaryId];
    return ungroupMode(ctx) ? false : compoundBlockedReason(ids) !== null;
  },
  run: (ctx) => {
    const ids = ctx.clipIds.length ? ctx.clipIds : [ctx.primaryId];
    if (ungroupMode(ctx)) undoCompoundClips(ids);
    else createCompoundClip(ids);
  },
} as MenuItem;

registerSlot('compound', compoundMenuItem);
