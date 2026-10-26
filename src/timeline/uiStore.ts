/**
 * Timeline-local UI state that the shared store does not hold (yet): tool mode, linkage and
 * preview-axis toggles, hover time, clipboard, and a handle to the mounted timeline's view
 * (zoom anchored / fit). Toggles persist per user in localStorage.
 */
import { create } from 'zustand';
import type { Clip, Us } from '../model/types';
import { useEditor } from '../store';
import type { AttributeSnapshot } from '../actions/attributes';

import type { Tool } from './tools';
import { moveAreaEdge, NO_AREA, type TimelineArea } from './range';

export type { Tool };

const LS_KEY = 'our-editor.timeline.ui';

interface Persisted {
  linkage: boolean;
  previewAxis: boolean;
  /** Track height multiplier (1 = default 64 / 48 px rows), TRACK_SCALE_MIN … TRACK_SCALE_MAX. */
  trackScale: number;
  /** What the toolbar's zoom slider / − + buttons drive: timeline zoom or track height. */
  zoomMode: 'time' | 'height';
}

export const TRACK_SCALE_MIN = 0.75;
export const TRACK_SCALE_MAX = 3;
const clampScale = (k: number) => Math.min(TRACK_SCALE_MAX, Math.max(TRACK_SCALE_MIN, Number.isFinite(k) ? k : 1));

function load(): Persisted {
  // CapCut ships with the preview axis on (the amber hover line)
  const def: Persisted = { linkage: true, previewAxis: true, trackScale: 1, zoomMode: 'time' };
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (!raw) return def;
    const v = JSON.parse(raw) as Partial<Persisted>;
    return {
      linkage: v.linkage ?? def.linkage,
      previewAxis: v.previewAxis ?? def.previewAxis,
      trackScale: clampScale(v.trackScale ?? def.trackScale),
      zoomMode: v.zoomMode === 'height' ? 'height' : 'time',
    };
  } catch {
    return def;
  }
}

const persisted = (s: Persisted): Persisted => ({ linkage: s.linkage, previewAxis: s.previewAxis, trackScale: s.trackScale, zoomMode: s.zoomMode });

function save(p: Persisted): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: keep in memory */
  }
}

/** Imperative view controls registered by the mounted <Timeline>. */
export interface TimelineView {
  /** Multiply the zoom, anchored at the playhead (or a client X). */
  zoomBy: (factor: number, anchorClientX?: number) => void;
  zoomTo: (pxPerSecond: number, anchorClientX?: number) => void;
  fit: () => void;
}

/** In / out points (CapCut I / O, ⇧X, ⌥X): see ./range.ts. Saved per project with the view state. */
export type { TimelineArea } from './range';

export interface TimelineUiState extends Persisted {
  tool: Tool;
  /** Preview-axis hover time (timeline µs) or null. */
  hoverTime: Us | null;
  /** Snapshots of the clips copied with ⌘C / cut with ⌘X (survive deleting the sources). */
  clipboard: Clip[];
  /** Copy attributes (⌥⌘C): the copied clip's attribute groups; null = nothing copied. */
  attributeClipboard: AttributeSnapshot | null;
  view: TimelineView | null;
  area: TimelineArea;
  /** I: mark in at `t`. An out point at or before it is dropped. */
  setAreaIn: (t: Us) => void;
  /** O: mark out at `t`. An in point at or after it is dropped. */
  setAreaOut: (t: Us) => void;
  /** ⇧X: both ends at once (ignored when out <= in). */
  setArea: (inT: Us, outT: Us) => void;
  /** ⌥X or the range's ✕ (Esc no longer clears it: the marked range is kept for the export). */
  clearArea: () => void;
  /** Drag of an In / Out handle (frame-snapped, never crosses the other edge). */
  moveAreaEdge: (edge: 'in' | 'out', t: Us, fps: number) => void;
  /** Restore (project load / switch): replaces the whole area. */
  replaceArea: (a: TimelineArea) => void;
  setTool: (t: Tool) => void;
  setLinkage: (on: boolean) => void;
  setPreviewAxis: (on: boolean) => void;
  /** Track height multiplier (clamped, saved). */
  setTrackScale: (k: number) => void;
  setZoomMode: (m: 'time' | 'height') => void;
  setHoverTime: (t: Us | null) => void;
  setClipboard: (clips: Clip[]) => void;
  setAttributeClipboard: (snap: AttributeSnapshot | null) => void;
  setView: (v: TimelineView | null) => void;
}

const initial = load();
// the store's edits read the linkage toggle; start it from the user's saved choice
useEditor.getState().setLinkage(initial.linkage);

export const useTimelineUi = create<TimelineUiState>()((set, get) => ({
  ...initial,
  tool: 'select',
  hoverTime: null,
  clipboard: [],
  attributeClipboard: null,
  view: null,
  area: { in: null, out: null },
  setAreaIn: (t) => {
    const v = Math.max(0, Math.round(t));
    const out = get().area.out;
    set({ area: { in: v, out: out !== null && out <= v ? null : out } });
  },
  setAreaOut: (t) => {
    const v = Math.max(0, Math.round(t));
    const inT = get().area.in;
    set({ area: { in: inT !== null && inT >= v ? null : inT, out: v } });
  },
  setArea: (inT, outT) => {
    if (outT <= inT) return;
    set({ area: { in: Math.max(0, Math.round(inT)), out: Math.round(outT) } });
  },
  clearArea: () => {
    const a = get().area;
    if (a.in !== null || a.out !== null) set({ area: NO_AREA });
  },
  moveAreaEdge: (edge, t, fps) => {
    const next = moveAreaEdge(get().area, edge, t, fps);
    const a = get().area;
    if (next.in !== a.in || next.out !== a.out) set({ area: next });
  },
  replaceArea: (area) => {
    const a = get().area;
    if (area.in !== a.in || area.out !== a.out) set({ area: { in: area.in, out: area.out } });
  },
  setTool: (tool) => set({ tool }),
  setLinkage: (linkage) => {
    set({ linkage });
    useEditor.getState().setLinkage(linkage);
    save({ ...persisted(get()), linkage });
  },
  setPreviewAxis: (previewAxis) => {
    set({ previewAxis, hoverTime: previewAxis ? get().hoverTime : null });
    if (!previewAxis) useEditor.getState().setPreviewTime(null);
    save({ ...persisted(get()), previewAxis });
  },
  setTrackScale: (k) => {
    const trackScale = Math.round(clampScale(k) * 100) / 100;
    if (trackScale === get().trackScale) return;
    set({ trackScale });
    save({ ...persisted(get()), trackScale });
  },
  setZoomMode: (zoomMode) => {
    set({ zoomMode });
    save({ ...persisted(get()), zoomMode });
  },
  setHoverTime: (hoverTime) => {
    if (get().hoverTime !== hoverTime) set({ hoverTime });
    // the player shows the hovered frame (preview axis) while paused; playback is never overridden
    const ed = useEditor.getState();
    ed.setPreviewTime(get().previewAxis && !ed.playing ? hoverTime : null);
  },
  setClipboard: (clipboard) => set({ clipboard }),
  setAttributeClipboard: (attributeClipboard) => set({ attributeClipboard }),
  setView: (view) => set({ view }),
}));
