/**
 * Timeline-local UI state that the shared store does not hold (yet): tool mode, linkage and
 * preview-axis toggles, hover time, clipboard, and a handle to the mounted timeline's view
 * (zoom anchored / fit). Toggles persist per user in localStorage.
 */
import { create } from 'zustand';
import type { Clip, Us } from '../model/types';
import { useEditor } from '../store';

export type Tool = 'select' | 'split';

const LS_KEY = 'our-editor.timeline.ui';

interface Persisted {
  linkage: boolean;
  previewAxis: boolean;
}

function load(): Persisted {
  const def: Persisted = { linkage: true, previewAxis: false };
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (!raw) return def;
    const v = JSON.parse(raw) as Partial<Persisted>;
    return { linkage: v.linkage ?? def.linkage, previewAxis: v.previewAxis ?? def.previewAxis };
  } catch {
    return def;
  }
}

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

export interface TimelineUiState extends Persisted {
  tool: Tool;
  /** Preview-axis hover time (timeline µs) or null. */
  hoverTime: Us | null;
  /** Snapshots of the clips copied with ⌘C / cut with ⌘X (survive deleting the sources). */
  clipboard: Clip[];
  view: TimelineView | null;
  setTool: (t: Tool) => void;
  setLinkage: (on: boolean) => void;
  setPreviewAxis: (on: boolean) => void;
  setHoverTime: (t: Us | null) => void;
  setClipboard: (clips: Clip[]) => void;
  setView: (v: TimelineView | null) => void;
}

export const useTimelineUi = create<TimelineUiState>()((set, get) => ({
  ...load(),
  tool: 'select',
  hoverTime: null,
  clipboard: [],
  view: null,
  setTool: (tool) => set({ tool }),
  setLinkage: (linkage) => {
    set({ linkage });
    save({ linkage, previewAxis: get().previewAxis });
  },
  setPreviewAxis: (previewAxis) => {
    set({ previewAxis, hoverTime: previewAxis ? get().hoverTime : null });
    if (!previewAxis) useEditor.getState().setPreviewTime(null);
    save({ linkage: get().linkage, previewAxis });
  },
  setHoverTime: (hoverTime) => {
    if (get().hoverTime !== hoverTime) set({ hoverTime });
    // the player follows the hovered frame (preview axis) while paused
    useEditor.getState().setPreviewTime(get().previewAxis ? hoverTime : null);
  },
  setClipboard: (clipboard) => set({ clipboard }),
  setView: (view) => set({ view }),
}));
