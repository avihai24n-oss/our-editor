/**
 * Where the user was in a project: playhead, timeline zoom, selected clips and the cover frame
 * shown on the home screen. Saved per project in IndexedDB (store "views", see persistence.ts),
 * next to the document rather than inside it: it is not undoable, not exported and not part of
 * the JSON another machine would open.
 *
 * Write rules:
 * - a change schedules a write DEBOUNCE_MS later; nothing is written while the playhead is only
 *   moving because the project is playing (a 10-minute playback writes nothing);
 * - a write is skipped when nothing changed;
 * - the cover frame is re-captured at most every COVER_GAP_MS, and always on a flush.
 *
 * `restoreView()` puts it back after a project loads, dropping anything the document no longer
 * supports (a playhead past the end, a selection whose clips are gone).
 */
import { allClips } from '../model/project';
import { clamp, projectDuration } from '../model/time';
import type { Id, Project } from '../model/types';
import { useEditor } from './index';
import { loadView, saveView, type ProjectView } from './persistence';

const DEBOUNCE_MS = 1200;
const COVER_GAP_MS = 20_000;
/** Cover width in px; the height follows the project ratio. */
const COVER_W = 320;

let coverSource: (() => HTMLCanvasElement | null) | null = null;

/**
 * Lets the player hand over its canvas, so a cover can be grabbed from the frame on screen
 * without this module reaching into the DOM. Returns the unregister function.
 */
export function setCoverSource(fn: () => HTMLCanvasElement | null): () => void {
  coverSource = fn;
  return () => {
    if (coverSource === fn) coverSource = null;
  };
}

function captureCover(): string | undefined {
  const src = coverSource?.();
  if (!src?.width || !src.height) return undefined;
  try {
    const out = document.createElement('canvas');
    const scale = Math.min(1, COVER_W / src.width);
    out.width = Math.max(1, Math.round(src.width * scale));
    out.height = Math.max(1, Math.round(src.height * scale));
    const g = out.getContext('2d');
    if (!g) return undefined;
    g.drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.7);
  } catch {
    return undefined; // tainted or oversized canvas: the card falls back to a placeholder
  }
}

let lastWritten: string | null = null;
let lastCover: string | undefined;
let lastCoverAt = -Infinity;

/** Test helper. */
export function resetViewState(): void {
  lastWritten = null;
  lastCover = undefined;
  lastCoverAt = -Infinity;
  coverSource = null;
}

const fingerprint = (id: Id, v: ProjectView): string => `${id}|${v.playhead}|${v.zoom}|${v.selection.join(',')}`;

/** Writes the current view unless it is unchanged. Returns true when it wrote. */
export async function saveViewNow(opts: { cover?: boolean } = {}): Promise<boolean> {
  const s = useEditor.getState();
  const id = s.project.id;
  if (opts.cover || Date.now() - lastCoverAt >= COVER_GAP_MS) {
    const shot = captureCover();
    if (shot) {
      lastCover = shot;
      lastCoverAt = Date.now();
    }
  }
  const view: ProjectView = {
    playhead: s.playhead,
    zoom: s.zoom,
    selection: [...s.selection.clipIds],
    cover: lastCover,
    savedAt: Date.now(),
  };
  const fp = fingerprint(id, view);
  if (fp === lastWritten && !opts.cover) return false;
  try {
    await saveView(id, view);
    lastWritten = fp;
    return true;
  } catch {
    return false; // view state is a convenience: never surface it as a save failure
  }
}

let flushPending: (() => void) | null = null;

/** Writes the view now (page hide, leaving the project). */
export function flushView(): void {
  flushPending?.();
}

export function startViewAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void saveViewNow();
    }, DEBOUNCE_MS);
  };
  const unsub = useEditor.subscribe((s, prev) => {
    // playback moves the playhead every frame: let it be, and save once it stops
    if (s.playing) return;
    if (s.playhead === prev.playhead && s.zoom === prev.zoom && s.selection === prev.selection && s.project.id === prev.project.id) return;
    schedule();
  });
  flushPending = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void saveViewNow({ cover: true });
  };
  const stop = flushPending;
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
    if (flushPending === stop) flushPending = null;
  };
}

/** Puts a loaded project's view back. Unknown or stale values are dropped, never applied blindly. */
export async function restoreView(p: Project): Promise<void> {
  let v: ProjectView | null = null;
  try {
    v = await loadView(p.id);
  } catch {
    return;
  }
  lastCover = v?.cover;
  lastCoverAt = v?.cover ? Date.now() : -Infinity;
  if (!v) {
    lastWritten = null;
    return;
  }
  const s = useEditor.getState();
  s.setPlayhead(clamp(v.playhead ?? 0, 0, projectDuration(p)));
  if (typeof v.zoom === 'number' && Number.isFinite(v.zoom)) s.setZoom(v.zoom);
  const ids = new Set(allClips(p).map((c) => c.id));
  const keep = (v.selection ?? []).filter((id) => ids.has(id));
  if (keep.length) s.select(keep);
  else s.clearSelection();
  lastWritten = fingerprint(p.id, {
    playhead: useEditor.getState().playhead,
    zoom: useEditor.getState().zoom,
    selection: keep,
    savedAt: 0,
  });
}
