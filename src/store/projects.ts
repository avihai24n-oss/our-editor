/**
 * Project-level commands behind the home screen: open, create, duplicate, rename, delete.
 *
 * Every one of them leaves the open project saved first — switching away is exactly as safe as
 * refreshing the tab. Opening a project is a three-step hand-over that must happen in this order:
 *   1. save the current document and its view state;
 *   2. release the old media (object URLs, thumbnail / waveform caches) — nothing on screen may
 *      still reference it;
 *   3. load the new document, re-create its object URLs, then restore its view.
 * The store is only given the new project once its media is back, so the player never renders a
 * document whose assets have no URLs.
 */
import { restoreAssetUrls } from '../media/import';
import { flushAllCaches } from '../media/memory';
import { revokeAllAssetUrls } from '../media/registry';
import { newId } from '../model/defaults';
import type { AspectRatio, Id, Project } from '../model/types';
import { markSaved, saveNow, sweepOrphanBlobs } from './autosave';
import { useEditor } from './index';
import {
  deleteProject as deleteStoredProject,
  loadProject,
  saveProject,
  setLastProjectId,
} from './persistence';
import { flushView, restoreView, saveViewNow } from './viewState';

/**
 * An empty project that was never saved is the placeholder the store starts with (boot found
 * nothing). It has nothing to lose, and writing it would put a phantom "Untitled project" on the
 * home screen every time the user creates a real one.
 */
function worthSaving(): boolean {
  const s = useEditor.getState();
  if (s.saveStatus.lastSavedAt !== null) return true; // already on disk
  const p = s.project;
  return Object.keys(p.assets).length > 0 || p.tracks.some((t) => t.clips.length > 0);
}

/** Saves the open project and where the user was in it. Call before leaving it, always. */
export async function saveAndFlush(): Promise<void> {
  if (!worthSaving()) return;
  await saveNow();
  await saveViewNow({ cover: true });
  flushView();
}

function releaseMedia(): void {
  revokeAllAssetUrls();
  flushAllCaches();
}

/** Hands the store a loaded document: media first, then the project, then the view. */
async function handOver(p: Project): Promise<void> {
  releaseMedia();
  const missing = await restoreAssetUrls(p);
  const ed = useEditor.getState();
  ed.setProject(p);
  markSaved(p);
  ed.setAssetsMissing(missing);
  ed.setSaveStatus({ lastSavedAt: p.updatedAt, saving: false, error: null });
  await restoreView(p);
  await setLastProjectId(p.id);
}

/**
 * Opens a stored project. Returns false when it is gone (deleted in another tab), leaving the
 * current one untouched.
 */
export async function openProject(id: Id): Promise<boolean> {
  if (useEditor.getState().project.id === id) return true;
  await saveAndFlush();
  const p = await loadProject(id);
  if (!p) return false;
  await handOver(p);
  return true;
}

/** Creates an empty project, saves it immediately and opens it. Returns its id. */
export async function createAndOpenProject(opts: { name?: string; aspect?: AspectRatio } = {}): Promise<Id> {
  await saveAndFlush();
  releaseMedia();
  const ed = useEditor.getState();
  ed.newProject(opts);
  ed.setSaveStatus({ lastSavedAt: null, saving: false, error: null });
  const p = useEditor.getState().project;
  await saveNow(true); // on disk before the first edit, so it shows on the home screen
  await restoreView(p); // no stored view: resets the cover so the new project gets its own
  await setLastProjectId(p.id);
  return p.id;
}

/** Copies a stored project (media is shared, not duplicated). Returns the copy's id. */
export async function duplicateProject(id: Id): Promise<Id | null> {
  const open = useEditor.getState().project;
  if (open.id === id) await saveAndFlush();
  const src = await loadProject(id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src)) as Project;
  copy.id = newId('prj');
  copy.name = `${src.name} copy`;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  await saveProject(copy);
  // saveProject points lastProjectId at the copy; the user is still in the project they were in
  await setLastProjectId(useEditor.getState().project.id);
  return copy.id;
}

/** Renames a project, open or not. */
export async function renameProject(id: Id, name: string): Promise<void> {
  const clean = name.trim() || 'Untitled project';
  if (useEditor.getState().project.id === id) {
    useEditor.getState().setProjectName(clean);
    await saveNow();
    return;
  }
  const p = await loadProject(id);
  if (!p) return;
  await saveProject({ ...p, name: clean, updatedAt: Date.now() });
  await setLastProjectId(useEditor.getState().project.id);
}

/**
 * Deletes a project and its view state, then frees the media no remaining project uses.
 * Deleting the open project leaves an empty untitled one in the editor (nothing to show).
 */
export async function removeProject(id: Id): Promise<void> {
  const wasOpen = useEditor.getState().project.id === id;
  await deleteStoredProject(id);
  if (wasOpen) {
    releaseMedia();
    useEditor.getState().newProject();
    markSaved(useEditor.getState().project); // never write the placeholder back to disk
    useEditor.getState().setSaveStatus({ lastSavedAt: null, saving: false, error: null });
    await restoreView(useEditor.getState().project); // drops the deleted project's cover frame
    await setLastProjectId(null);
  }
  await sweepOrphanBlobs().catch(() => 0);
}
