/**
 * IndexedDB persistence (raw API, no wrapper). DB "our-editor":
 *   projects : key = project.id, value = Project JSON
 *   blobs    : key = asset.blobKey, value = File/Blob
 *   meta     : key = 'lastProjectId'
 */
import type { Id, Project } from '../model/types';

const DB_NAME = 'our-editor';
const DB_VERSION = 1;

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
      for (const name of ['projects', 'blobs', 'meta']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
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
}

export async function loadProject(id: Id): Promise<Project | null> {
  const p = await run<Project | undefined>('projects', 'readonly', (s) => s.get(id) as IDBRequest<Project | undefined>);
  return p ?? null;
}

export async function loadLastProject(): Promise<Project | null> {
  const id = await run<Id | undefined>('meta', 'readonly', (s) => s.get('lastProjectId') as IDBRequest<Id | undefined>);
  return id ? loadProject(id) : null;
}

export async function listProjects(): Promise<{ id: Id; name: string; updatedAt: number }[]> {
  const all = await run<Project[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>);
  return all.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: Id): Promise<void> {
  await run('projects', 'readwrite', (s) => s.delete(id));
}

export async function putBlob(key: Id, blob: Blob): Promise<void> {
  await run('blobs', 'readwrite', (s) => s.put(blob, key));
}

export async function getBlob(key: Id): Promise<Blob | null> {
  const b = await run<Blob | undefined>('blobs', 'readonly', (s) => s.get(key) as IDBRequest<Blob | undefined>);
  return b ?? null;
}

export async function deleteBlob(key: Id): Promise<void> {
  await run('blobs', 'readwrite', (s) => s.delete(key));
}
