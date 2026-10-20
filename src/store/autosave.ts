/**
 * Autosave + boot. `startAutosave()` saves the project JSON MEMORY_LIMITS.autosaveDebounceMs after
 * the last change and on page hide. `bootProject()` loads the last project (and its media URLs)
 * or keeps a new one.
 *
 * Write rules (an idle tab writes nothing):
 * - only the project JSON is written; media blobs are written once, at import (media/import.ts);
 * - a save is skipped when the JSON (minus `updatedAt`) equals the last one written;
 * - two writes are at least MEMORY_LIMITS.autosaveMinGapMs apart;
 * - only `project` changes schedule a save; the save itself only touches `saveStatus`, so a save
 *   can never schedule another one.
 */
import { blobsBeingWritten, restoreAssetUrls } from '../media/import';
import { MEMORY_LIMITS } from '../media/memory';
import { rootProject } from '../model/compound';
import type { Project } from '../model/types';
import { useEditor } from './index';
import { deleteBlob, listBlobKeys, loadLastProject, referencedBlobKeys, saveProject } from './persistence';

const DEBOUNCE_MS = MEMORY_LIMITS.autosaveDebounceMs;
const MIN_GAP_MS = MEMORY_LIMITS.autosaveMinGapMs;

/** JSON of the project without its timestamp: equal fingerprints = nothing to save. */
export function projectFingerprint(p: Project): string {
  return JSON.stringify({ ...p, updatedAt: 0 });
}

let lastWritten: string | null = null;
let lastWriteAt = -Infinity;
let writes = 0;

/** Number of project writes this session (tests, debug readout). */
export const autosaveWrites = (): number => writes;

/** Test helper. */
export function resetAutosaveState(): void {
  lastWritten = null;
  lastWriteAt = -Infinity;
  writes = 0;
}

/** Saves now unless the project is unchanged since the last write. Returns true when it wrote. */
export async function saveNow(force = false): Promise<boolean> {
  const { project, setSaveStatus } = useEditor.getState();
  const fp = projectFingerprint(project);
  if (!force && fp === lastWritten) return false;
  setSaveStatus({ saving: true });
  try {
    lastWriteAt = Date.now();
    writes++;
    await saveProject(rootProject(project)); // an open compound clip is saved closed
    lastWritten = fp;
    setSaveStatus({ saving: false, lastSavedAt: Date.now(), error: null });
    return true;
  } catch (e) {
    setSaveStatus({ saving: false, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // the loaded project is already on disk: do not write it back
  lastWritten ??= projectFingerprint(useEditor.getState().project);
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      void saveNow();
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    const wait = Math.max(DEBOUNCE_MS, lastWriteAt + MIN_GAP_MS - Date.now());
    timer = setTimeout(() => {
      timer = null;
      void saveNow();
    }, wait);
  };
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    schedule();
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHide);
  }
  return () => {
    unsub();
    flush();
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onHide);
    }
  };
}

let booting: Promise<boolean> | null = null;

/**
 * Loads the last saved project into the store. Returns true when one was found.
 * Single-flight: React StrictMode runs the boot effect twice in dev, and a second boot would
 * re-register every asset URL and revoke the first ones while media elements still load them.
 */
export function bootProject(): Promise<boolean> {
  booting ??= doBoot();
  return booting;
}

/**
 * Deletes stored media no saved project and no live asset refers to. A deleted asset keeps its
 * blob while ⌘Z can still bring it back; once the tab is closed that blob is unreachable, so the
 * next boot sweeps it. Returns how many blobs were deleted.
 */
export async function sweepOrphanBlobs(): Promise<number> {
  const [keys, saved] = await Promise.all([listBlobKeys(), referencedBlobKeys()]);
  const live = new Set(Object.values(useEditor.getState().project.assets).map((a) => a.blobKey));
  let n = 0;
  for (const k of keys) {
    if (saved.has(k) || live.has(k) || blobsBeingWritten().has(k)) continue;
    await deleteBlob(k);
    n++;
  }
  return n;
}

async function doBoot(): Promise<boolean> {
  try {
    const p = await loadLastProject();
    void sweepOrphanBlobs().catch((e) => console.warn('Could not sweep unused media', e));
    if (!p) return false;
    useEditor.getState().setProject(p);
    const missing = await restoreAssetUrls(p);
    useEditor.getState().setAssetsMissing(missing);
    useEditor.getState().setSaveStatus({ lastSavedAt: p.updatedAt });
    return true;
  } catch (e) {
    console.warn('Could not load the last project', e);
    return false;
  }
}
