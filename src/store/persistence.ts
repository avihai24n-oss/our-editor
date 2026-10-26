/**
 * IndexedDB persistence (raw API, no wrapper). DB "our-editor":
 *   projects : key = project.id, value = Project JSON
 *   blobs    : key = asset.blobKey, value = File/Blob
 *   views    : key = project.id, value = ProjectView (playhead / zoom / selection / cover)
 *   meta     : key = 'lastProjectId'
 *
 * Projects, views and blobs are also mirrored to the on-disk library (./diskSync.ts), so every
 * Chrome profile / browser on this machine sees the same projects.
 */
import { projectDuration } from '../model/time';
import type { AspectRatio, Id, Project, Us } from '../model/types';
import { blobFromDisk, mirrorBlob, mirrorDelete, mirrorProject, mirrorView, syncWithDisk } from './diskSync';

const DB_NAME = 'our-editor';
const DB_VERSION = 2;

/**
 * Where the user was in a project: not document data (never undoable, never exported), so it
 * lives beside the project instead of inside it. Restored by src/store/viewState.ts.
 */
export interface ProjectView {
  playhead: Us;
  zoom: number;
  /** Selected clip ids (dropped silently when a clip no longer exists). */
  selection: Id[];
  /** Small JPEG data URL of the last previewed frame — the home screen's cover. */
  cover?: string;
  savedAt: number;
}

/** One card on the home screen. */
export interface ProjectSummary {
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;
  aspect: AspectRatio;
  /** Timeline duration of the main (root) timeline. */
  duration: Us;
  clips: number;
  cover?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['projects', 'blobs', 'views', 'meta']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

/** Test helper: forget the cached connection. */
export function resetDbConnection(): void {
  dbPromise = null;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function saveProject(project: Project): Promise<void> {
  await run('projects', 'readwrite', (s) => s.put(project, project.id));
  await run('meta', 'readwrite', (s) => s.put(project.id, 'lastProjectId'));
  mirrorProject(project);
}

export async function loadProject(id: Id): Promise<Project | null> {
  const p = await run<Project | undefined>('projects', 'readonly', (s) => s.get(id) as IDBRequest<Project | undefined>);
  return p ?? null;
}

export async function lastProjectId(): Promise<Id | null> {
  const id = await run<Id | undefined>('meta', 'readonly', (s) => s.get('lastProjectId') as IDBRequest<Id | undefined>);
  return id ?? null;
}

/** Remembers which project to reopen; `null` forgets it (the next boot shows the home screen). */
export async function setLastProjectId(id: Id | null): Promise<void> {
  if (id === null) await run('meta', 'readwrite', (s) => s.delete('lastProjectId'));
  else await run('meta', 'readwrite', (s) => s.put(id, 'lastProjectId'));
}

/** Any other small setting kept in the meta store (e.g. the Export frame folder handle). */
export async function getMeta<T = unknown>(key: string): Promise<T | null> {
  return ((await run<unknown>('meta', 'readonly', (s) => s.get(key))) as T | undefined) ?? null;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await run('meta', 'readwrite', (s) => s.put(value, key));
}

export async function loadLastProject(): Promise<Project | null> {
  const id = await lastProjectId();
  return id ? loadProject(id) : null;
}

export async function listProjects(): Promise<{ id: Id; name: string; updatedAt: number }[]> {
  const all = await run<Project[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>);
  return all.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every stored project as a home-screen card, newest first. */
export async function projectSummaries(): Promise<ProjectSummary[]> {
  const all = await run<Project[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>);
  const views = await Promise.all(all.map((p) => loadView(p.id).catch(() => null)));
  return all
    .map((p, i) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      aspect: p.settings.aspect,
      duration: projectDuration(p),
      clips: p.tracks.reduce((n, t) => n + t.clips.length, 0),
      cover: views[i]?.cover,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Deletes the project and its view state. Its media blobs are swept on the next boot. */
export async function deleteProject(id: Id): Promise<void> {
  await run('projects', 'readwrite', (s) => s.delete(id));
  await deleteView(id);
  if ((await lastProjectId()) === id) await setLastProjectId(null);
  mirrorDelete(id);
}

export async function saveView(id: Id, view: ProjectView): Promise<void> {
  await run('views', 'readwrite', (s) => s.put(view, id));
  mirrorView(id, view);
}

export async function loadView(id: Id): Promise<ProjectView | null> {
  const v = await run<ProjectView | undefined>('views', 'readonly', (s) => s.get(id) as IDBRequest<ProjectView | undefined>);
  return v ?? null;
}

export async function deleteView(id: Id): Promise<void> {
  await run('views', 'readwrite', (s) => s.delete(id));
}

export async function putBlob(key: Id, blob: Blob): Promise<void> {
  await run('blobs', 'readwrite', (s) => s.put(blob, key));
  mirrorBlob(key, blob);
}

const getLocalBlob = async (key: Id): Promise<Blob | null> =>
  (await run<Blob | undefined>('blobs', 'readonly', (s) => s.get(key) as IDBRequest<Blob | undefined>)) ?? null;

/** The stored media; a blob this browser never had comes from the disk library (and is kept). */
export async function getBlob(key: Id): Promise<Blob | null> {
  const b = await getLocalBlob(key);
  if (b) return b;
  const d = await blobFromDisk(key);
  if (d) await run('blobs', 'readwrite', (s) => s.put(d, key));
  return d;
}

export async function hasBlob(key: Id): Promise<boolean> {
  const n = await run<number>('blobs', 'readonly', (s) => s.count(key));
  return n > 0;
}

export async function listBlobKeys(): Promise<Id[]> {
  const keys = await run<IDBValidKey[]>('blobs', 'readonly', (s) => s.getAllKeys());
  return keys.map(String);
}

/** Every blob key referenced by a saved project. */
export async function referencedBlobKeys(): Promise<Set<Id>> {
  const all = await run<Project[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>);
  return new Set(all.flatMap((p) => Object.values(p.assets ?? {}).map((a) => a.blobKey)));
}

export async function deleteBlob(key: Id): Promise<void> {
  await run('blobs', 'readwrite', (s) => s.delete(key));
}

/** Boot: merges this browser's projects with the disk library (./diskSync.ts). */
export function syncLibrary(): Promise<number> {
  return syncWithDisk({
    allProjects: () => run<Project[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>),
    putProject: async (p) => void (await run('projects', 'readwrite', (s) => s.put(p, p.id))),
    deleteProject: async (id) => {
      await run('projects', 'readwrite', (s) => s.delete(id));
      await deleteView(id);
      if ((await lastProjectId()) === id) await setLastProjectId(null);
    },
    loadView,
    putView: async (id, v) => void (await run('views', 'readwrite', (s) => s.put(v, id))),
    getBlob: getLocalBlob,
    lastProjectId,
    setLastProjectId,
  });
}
