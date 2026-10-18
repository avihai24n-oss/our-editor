/**
 * THE editor store (Zustand). One store, every v1 action.
 *
 * - `project` is the document: undoable and persisted.
 * - selection / playhead / playing / zoom / magnet / snapping / saveStatus are UI state:
 *   NOT undoable, NOT persisted in the project.
 * - Every edit goes through `edit()` → immer draft → ops.ts → normalize() → one undo step.
 * - Continuous gestures (drag, trim, slider): call beginTx() on pointer-down, call the actions
 *   freely while moving, then commitTx() on pointer-up (or cancelTx() on Escape) → ONE undo step.
 *
 * Owned by the architect/QA. Builders: do not edit; request changes in docs/integration-notes/.
 */
import { produce } from 'immer';
import { create } from 'zustand';
import { importFiles as importMediaFiles } from '../media/import';
import { aspectSize, LIMITS } from '../model/catalog';
import { createProject, makeAnimation } from '../model/defaults';
import { findClip, findTransition, mainTrack } from '../model/project';
import {
  clamp,
  clipContains,
  frameToUs,
  nextEditPoint,
  prevEditPoint,
  projectDuration,
  snapToFrame,
  usToFrame,
} from '../model/time';
import type {
  AnimationType,
  AspectRatio,
  ClipPatch,
  Id,
  MediaAsset,
  Project,
  Track,
  TrackKind,
  Transition,
  TransitionType,
  Us,
} from '../model/types';
import * as ops from './ops';

export type SelectMode = 'replace' | 'add' | 'toggle';

export interface SaveStatus {
  lastSavedAt: number | null;
  saving: boolean;
  error: string | null;
}

export interface EditorState {
  // ---- document + history
  project: Project;
  past: Project[];
  future: Project[];
  /** Snapshot taken by beginTx(); null when no gesture is in progress. */
  txBase: Project | null;

  // ---- UI state (not undoable)
  selection: { clipIds: Id[]; transitionId: Id | null };
  playhead: Us;
  playing: boolean;
  /** Timeline zoom in px per second. */
  zoom: number;
  /** Main track magnet (CapCut default ON). */
  magnet: boolean;
  /** Auto snapping (CapCut default ON). */
  snapping: boolean;
  saveStatus: SaveStatus;

  // ---- project
  newProject: (opts?: { name?: string; aspect?: AspectRatio }) => void;
  /** Replaces the document (load). Clears history and selection. */
  setProject: (project: Project) => void;
  setProjectName: (name: string) => void;
  setAspectRatio: (aspect: AspectRatio) => void;

  // ---- media
  /** Adds probed assets to the bin. Not an undo step (assets survive undo). */
  addAssets: (assets: MediaAsset[]) => void;
  /** Browser: probe + store blobs + addAssets. Resolves with the new asset ids and errors. */
  importFiles: (files: Iterable<File>) => Promise<{ assetIds: Id[]; errors: string[] }>;
  /** Removes an asset and every clip that uses it. */
  removeAsset: (assetId: Id) => void;
  setAssetsMissing: (assetIds: Id[]) => void;

  // ---- clips
  /** Adds a clip for an asset. Default at = playhead; video/image → main track (insert, magnet),
   *  kind:'overlay' → free overlay track; audio → free audio track. Selects and returns the new id. */
  addClip: (assetId: Id, opts?: { at?: Us; trackId?: Id; kind?: 'main' | 'overlay' }) => Id | null;
  addTextClip: (opts?: { at?: Us; content?: string; trackId?: Id }) => Id;
  moveClip: (clipId: Id, to: { start: Us; trackId?: Id }) => boolean;
  trimStart: (clipId: Id, newStart: Us) => boolean;
  trimEnd: (clipId: Id, newEnd: Us) => boolean;
  /** Splits the selected clips under the playhead; if none selected, every clip under it (unlocked tracks). */
  splitAtPlayhead: () => Id[];
  splitClip: (clipId: Id, t: Us) => Id | null;
  /** Q: selected clips under the playhead, else the main-track clip under it. */
  deleteLeft: () => void;
  /** W: same targeting as deleteLeft. */
  deleteRight: () => void;
  deleteClips: (ids: Id[]) => void;
  deleteSelected: () => void;
  duplicateClips: (ids: Id[]) => Id[];
  duplicateSelected: () => Id[];
  updateClip: (clipId: Id, patch: ClipPatch) => void;
  /** Same patch to many clips (used by "Apply to all"). One undo step. */
  updateClips: (clipIds: Id[], patch: ClipPatch) => void;
  setSpeed: (clipId: Id, speed: number) => void;
  setDuration: (clipId: Id, duration: Us) => void;
  /** Toolbar mirror: toggles transform.flipH on the selected visual clips. */
  mirrorSelected: () => void;
  /** Toolbar rotate: +90° on the selected visual clips. */
  rotateSelected: (deg?: number) => void;
  /** Convenience: set or clear the In/Out animation (duration defaults to 0.5 s). */
  setAnimation: (clipId: Id, phase: 'in' | 'out', type: AnimationType | null, duration?: Us) => void;

  // ---- transitions
  addTransition: (fromClipId: Id, type: TransitionType, duration?: Us) => Id | null;
  updateTransition: (transitionId: Id, patch: Partial<Pick<Transition, 'type' | 'duration'>>) => void;
  removeTransition: (transitionId: Id) => void;
  applyTransitionToAll: (transitionId: Id) => void;

  // ---- tracks
  addTrack: (kind: Exclude<TrackKind, 'main'>, index?: number) => Id;
  removeTrack: (trackId: Id) => void;
  setTrack: (trackId: Id, patch: Partial<Pick<Track, 'locked' | 'hidden' | 'muted' | 'name'>>) => void;

  // ---- markers
  addMarker: (at?: Us, color?: string) => Id;
  removeMarker: (markerId: Id) => void;

  // ---- selection
  select: (clipIds: Id[], mode?: SelectMode) => void;
  selectTransition: (transitionId: Id | null) => void;
  selectAll: () => void;
  clearSelection: () => void;

  // ---- playback (not undoable)
  setPlayhead: (t: Us) => void;
  stepFrames: (n: number) => void;
  goToPrevEdit: () => void;
  goToNextEdit: () => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;

  // ---- timeline view / toggles (not undoable)
  setZoom: (pxPerSecond: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setMagnet: (on: boolean) => void;
  setSnapping: (on: boolean) => void;

  // ---- history
  undo: () => void;
  redo: () => void;
  beginTx: () => void;
  commitTx: () => void;
  cancelTx: () => void;

  // ---- persistence
  setSaveStatus: (s: Partial<SaveStatus>) => void;
}

type SetFn = (partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => void;
type GetFn = () => EditorState;

/** Runs a recipe on the project as one undoable edit (or inside the open transaction). */
function edit<T>(set: SetFn, get: GetFn, recipe: (draft: Project, ctx: ops.EditCtx) => T): T {
  const s = get();
  const before = s.project;
  const ctx: ops.EditCtx = { magnet: s.magnet };
  let result!: T;
  let next = produce(before, (d) => {
    result = recipe(d, ctx);
    ops.normalize(d, ctx);
  });
  if (next === before) return result;
  next = produce(next, (d) => {
    d.updatedAt = Date.now();
  });
  if (s.txBase) {
    set({ project: next });
  } else {
    set({ project: next, past: [...s.past, before].slice(-LIMITS.undoCap), future: [] });
  }
  pruneSelection(set, get);
  return result;
}

/** Drops selected ids that no longer exist. */
function pruneSelection(set: SetFn, get: GetFn): void {
  const { project, selection } = get();
  const ids = selection.clipIds.filter((id) => findClip(project, id));
  const tr = selection.transitionId && findTransition(project, selection.transitionId) ? selection.transitionId : null;
  if (ids.length !== selection.clipIds.length || tr !== selection.transitionId) set({ selection: { clipIds: ids, transitionId: tr } });
}

/** Undo/redo keep the media bin: assets of the current doc are carried into the restored one. */
const withAssets = (target: Project, current: Project): Project =>
  produce(target, (d) => {
    for (const [id, a] of Object.entries(current.assets)) if (!d.assets[id]) d.assets[id] = a;
  });

/** Targets for Q/W: selected clips under the playhead, else the main-track clip under it. */
function qwTargets(s: EditorState): Id[] {
  const t = s.playhead;
  const selected = s.selection.clipIds.filter((id) => {
    const f = findClip(s.project, id);
    return f && clipContains(f.clip, t);
  });
  if (selected.length) return selected;
  const c = mainTrack(s.project).clips.find((x) => clipContains(x, t));
  return c ? [c.id] : [];
}

export const useEditor = create<EditorState>()((set, get) => ({
  project: createProject(),
  past: [],
  future: [],
  txBase: null,
  selection: { clipIds: [], transitionId: null },
  playhead: 0,
  playing: false,
  zoom: LIMITS.zoomDefault,
  magnet: true,
  snapping: true,
  saveStatus: { lastSavedAt: null, saving: false, error: null },

  // ---- project
  newProject: (opts) =>
    set({
      project: createProject(opts),
      past: [],
      future: [],
      txBase: null,
      selection: { clipIds: [], transitionId: null },
      playhead: 0,
      playing: false,
    }),
  setProject: (project) =>
    set({ project, past: [], future: [], txBase: null, selection: { clipIds: [], transitionId: null }, playhead: 0, playing: false }),
  setProjectName: (name) =>
    edit(set, get, (d) => {
      d.name = name.trim() || 'Untitled project';
    }),
  setAspectRatio: (aspect) =>
    edit(set, get, (d) => {
      d.settings.aspect = aspect;
      Object.assign(d.settings, aspectSize(aspect));
    }),

  // ---- media
  addAssets: (assets) =>
    set((s) => ({
      project: produce(s.project, (d) => {
        for (const a of assets) d.assets[a.id] = a;
      }),
    })),
  importFiles: async (files) => {
    const { assets, errors } = await importMediaFiles(files);
    get().addAssets(assets);
    return { assetIds: assets.map((a) => a.id), errors };
  },
  removeAsset: (assetId) => {
    // Removing from the bin is not undoable (matches CapCut), clips using it are removed as an edit.
    const ids = get()
      .project.tracks.flatMap((t) => t.clips)
      .filter((c) => c.type !== 'text' && c.assetId === assetId)
      .map((c) => c.id);
    if (ids.length) edit(set, get, (d) => ops.deleteClips(d, ids));
    set((s) => ({
      project: produce(s.project, (d) => {
        delete d.assets[assetId];
      }),
      past: s.past.map((p) => (p.assets[assetId] ? produce(p, (d) => void delete d.assets[assetId]) : p)),
      future: s.future.map((p) => (p.assets[assetId] ? produce(p, (d) => void delete d.assets[assetId]) : p)),
    }));
  },
  setAssetsMissing: (assetIds) =>
    set((s) => ({
      project: produce(s.project, (d) => {
        for (const a of Object.values(d.assets)) a.missing = assetIds.includes(a.id) || undefined;
      }),
    })),

  // ---- clips
  addClip: (assetId, opts = {}) => {
    const id = edit(set, get, (d, ctx) => ops.addClipFromAsset(d, assetId, { ...opts, at: opts.at ?? get().playhead }, ctx));
    if (id) set({ selection: { clipIds: [id], transitionId: null } });
    return id;
  },
  addTextClip: (opts = {}) => {
    const id = edit(set, get, (d) => ops.addTextClip(d, { ...opts, at: opts.at ?? get().playhead }));
    set({ selection: { clipIds: [id], transitionId: null } });
    return id;
  },
  moveClip: (clipId, to) => edit(set, get, (d, ctx) => ops.moveClip(d, clipId, to, ctx)),
  trimStart: (clipId, newStart) => edit(set, get, (d, ctx) => ops.trimStart(d, clipId, newStart, ctx)),
  trimEnd: (clipId, newEnd) => edit(set, get, (d, ctx) => ops.trimEnd(d, clipId, newEnd, ctx)),
  splitClip: (clipId, t) => edit(set, get, (d) => ops.splitClip(d, clipId, t)),
  splitAtPlayhead: () => {
    const s = get();
    const t = s.playhead;
    let targets = s.selection.clipIds.filter((id) => {
      const f = findClip(s.project, id);
      return f && clipContains(f.clip, t);
    });
    if (!targets.length) {
      targets = s.project.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => clipContains(c, t)).map((c) => c.id));
    }
    return edit(set, get, (d) => targets.map((id) => ops.splitClip(d, id, t)).filter((x): x is Id => !!x));
  },
  deleteLeft: () => {
    const s = get();
    const t = s.playhead;
    const targets = qwTargets(s);
    if (!targets.length) return;
    // With the magnet on, a main-track clip keeps its slot, so the playhead goes to its old start.
    const mainHit = s.magnet ? targets.map((id) => findClip(s.project, id)).find((f) => f?.track.kind === 'main') : undefined;
    edit(set, get, (d, ctx) => targets.forEach((id) => ops.deleteLeft(d, id, t, ctx)));
    if (mainHit) set({ playhead: mainHit.clip.start });
  },
  deleteRight: () => {
    const s = get();
    const t = s.playhead;
    const targets = qwTargets(s);
    edit(set, get, (d, ctx) => targets.forEach((id) => ops.deleteRight(d, id, t, ctx)));
  },
  deleteClips: (ids) => {
    edit(set, get, (d) => ops.deleteClips(d, ids));
  },
  deleteSelected: () => {
    const s = get();
    if (s.selection.transitionId) {
      s.removeTransition(s.selection.transitionId);
      return;
    }
    if (s.selection.clipIds.length) s.deleteClips(s.selection.clipIds);
  },
  duplicateClips: (ids) => {
    const out = edit(set, get, (d, ctx) => ops.duplicateClips(d, ids, ctx));
    if (out.length) set({ selection: { clipIds: out, transitionId: null } });
    return out;
  },
  duplicateSelected: () => get().duplicateClips(get().selection.clipIds),
  updateClip: (clipId, patch) => {
    edit(set, get, (d) => ops.updateClip(d, clipId, patch));
  },
  updateClips: (clipIds, patch) => {
    edit(set, get, (d) => clipIds.forEach((id) => ops.updateClip(d, id, patch)));
  },
  setSpeed: (clipId, speed) => {
    edit(set, get, (d) => ops.setSpeed(d, clipId, speed));
  },
  setDuration: (clipId, duration) => {
    edit(set, get, (d) => ops.setDuration(d, clipId, duration));
  },
  mirrorSelected: () => {
    edit(set, get, (d) => {
      for (const id of get().selection.clipIds) {
        const f = findClip(d, id);
        if (f && !f.track.locked && f.clip.type !== 'audio') f.clip.transform.flipH = !f.clip.transform.flipH;
      }
    });
  },
  rotateSelected: (deg = 90) => {
    edit(set, get, (d) => {
      for (const id of get().selection.clipIds) {
        const f = findClip(d, id);
        if (f && !f.track.locked && f.clip.type !== 'audio') {
          let r = (f.clip.transform.rotation + deg) % 360;
          if (r > 180) r -= 360;
          if (r <= -180) r += 360;
          f.clip.transform.rotation = r;
        }
      }
    });
  },
  setAnimation: (clipId, phase, type, duration) => {
    edit(set, get, (d) =>
      ops.updateClip(d, clipId, phase === 'in' ? { animationIn: type ? makeAnimation(type, duration) : null } : { animationOut: type ? makeAnimation(type, duration) : null }),
    );
  },

  // ---- transitions
  addTransition: (fromClipId, type, duration) => {
    const id = edit(set, get, (d) => ops.addTransition(d, fromClipId, type, duration));
    if (id) set({ selection: { clipIds: [], transitionId: id } });
    return id;
  },
  updateTransition: (transitionId, patch) => {
    edit(set, get, (d) => {
      const f = findTransition(d, transitionId);
      if (f && !f.track.locked) Object.assign(f.transition, patch);
    });
  },
  removeTransition: (transitionId) => {
    edit(set, get, (d) => {
      for (const t of d.tracks) if (!t.locked) t.transitions = t.transitions.filter((x) => x.id !== transitionId);
    });
  },
  applyTransitionToAll: (transitionId) => {
    edit(set, get, (d) => ops.applyTransitionToTrack(d, transitionId));
  },

  // ---- tracks
  addTrack: (kind, index) => edit(set, get, (d) => ops.addTrack(d, kind, index).id),
  removeTrack: (trackId) => {
    edit(set, get, (d) => {
      d.tracks = d.tracks.filter((t) => t.kind === 'main' || t.id !== trackId);
    });
  },
  setTrack: (trackId, patch) => {
    edit(set, get, (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t) Object.assign(t, patch);
    });
  },

  // ---- markers
  addMarker: (at, color = '#22d3ee') => {
    const time = snapToFrame(at ?? get().playhead, get().project.settings.fps);
    const existing = get().project.markers.find((m) => m.time === time);
    if (existing) return existing.id;
    return edit(set, get, (d) => {
      const id = `mrk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      d.markers.push({ id, time, color });
      d.markers.sort((a, b) => a.time - b.time);
      return id;
    });
  },
  removeMarker: (markerId) => {
    edit(set, get, (d) => {
      d.markers = d.markers.filter((m) => m.id !== markerId);
    });
  },

  // ---- selection
  select: (clipIds, mode = 'replace') =>
    set((s) => {
      let ids: Id[];
      if (mode === 'replace') ids = [...clipIds];
      else if (mode === 'add') ids = [...new Set([...s.selection.clipIds, ...clipIds])];
      else {
        const cur = new Set(s.selection.clipIds);
        for (const id of clipIds) (cur.has(id) ? cur.delete(id) : cur.add(id));
        ids = [...cur];
      }
      ids = ids.filter((id) => {
        const f = findClip(s.project, id);
        return f && !f.track.locked;
      });
      return { selection: { clipIds: ids, transitionId: null } };
    }),
  selectTransition: (transitionId) => set({ selection: { clipIds: [], transitionId } }),
  selectAll: () =>
    set((s) => ({
      selection: { clipIds: s.project.tracks.filter((t) => !t.locked).flatMap((t) => t.clips.map((c) => c.id)), transitionId: null },
    })),
  clearSelection: () => set({ selection: { clipIds: [], transitionId: null } }),

  // ---- playback
  setPlayhead: (t) => set({ playhead: Math.max(0, Math.round(t)) }),
  stepFrames: (n) => {
    const s = get();
    const fps = s.project.settings.fps;
    const f = usToFrame(s.playhead, fps) + n;
    set({ playhead: clamp(frameToUs(f, fps), 0, Math.max(0, projectDuration(s.project))), playing: false });
  },
  goToPrevEdit: () => set((s) => ({ playhead: prevEditPoint(s.project, s.playhead), playing: false })),
  goToNextEdit: () => set((s) => ({ playhead: nextEditPoint(s.project, s.playhead), playing: false })),
  play: () => {
    const s = get();
    const end = projectDuration(s.project);
    if (end <= 0) return;
    set({ playing: true, playhead: s.playhead >= end ? 0 : s.playhead });
  },
  pause: () => set({ playing: false }),
  togglePlay: () => (get().playing ? get().pause() : get().play()),

  // ---- view / toggles
  setZoom: (px) => set({ zoom: clamp(px, LIMITS.zoomMin, LIMITS.zoomMax) }),
  zoomIn: () => get().setZoom(get().zoom * 1.25),
  zoomOut: () => get().setZoom(get().zoom / 1.25),
  setMagnet: (on) => {
    set({ magnet: on });
    // turning the magnet on packs the main track immediately (one undo step)
    if (on) edit(set, get, () => undefined);
  },
  setSnapping: (on) => set({ snapping: on }),

  // ---- history
  undo: () => {
    const s = get();
    if (s.txBase) s.commitTx();
    const { past, future, project } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({ project: withAssets(prev, project), past: past.slice(0, -1), future: [project, ...future], playing: false });
    pruneSelection(set, get);
  },
  redo: () => {
    const s = get();
    if (s.txBase) s.commitTx();
    const { past, future, project } = get();
    const next = future[0];
    if (!next) return;
    set({ project: withAssets(next, project), past: [...past, project].slice(-LIMITS.undoCap), future: future.slice(1), playing: false });
    pruneSelection(set, get);
  },
  beginTx: () => {
    const s = get();
    if (!s.txBase) set({ txBase: s.project });
  },
  commitTx: () => {
    const s = get();
    if (!s.txBase) return;
    if (s.txBase !== s.project) set({ past: [...s.past, s.txBase].slice(-LIMITS.undoCap), future: [], txBase: null });
    else set({ txBase: null });
  },
  cancelTx: () => {
    const s = get();
    if (!s.txBase) return;
    set({ project: withAssets(s.txBase, s.project), txBase: null });
    pruneSelection(set, get);
  },

  setSaveStatus: (st) => set((s) => ({ saveStatus: { ...s.saveStatus, ...st } })),
}));

export * from './selectors';
