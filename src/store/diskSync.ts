/**
 * The on-disk project library (vite-plugins/projectStore.js, ~/.our-editor/library).
 *
 * IndexedDB stays the working copy, but it belongs to ONE browser profile: opened in another Chrome
 * profile the editor looked empty. So every save is mirrored to disk (persistence.ts calls the
 * mirror* functions), and at boot `syncWithDisk()` merges both ways, newest `updatedAt` wins:
 * - disk → here: projects / views this browser lacks or has older; deletions (tombstones);
 * - here → disk: projects the disk lacks or has older, and their media blobs.
 * Media comes over lazily: `blobFromDisk()` when a project opens and its blob is not here yet.
 *
 * Off in unit tests and when the server has no library (a static build): every call is then a no-op.
 */
import type { Id, Project } from '../model/types';
import type { ProjectView } from './persistence';

const enabled = (): boolean => import.meta.env.MODE !== 'test' && typeof window !== 'undefined' && typeof fetch === 'function';
let available = true; // the server answered; false after a failed sync (no library here)

const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);

// ---------------------------------------------------------------- mirror (fire and forget)

/** Latest pending JSON per project id: rapid autosaves coalesce into one write. */
const pendingProjects = new Map<Id, string>();
let flushing: Promise<void> | null = null;

async function flushProjects(): Promise<void> {
  while (pendingProjects.size) {
    const [id, body] = pendingProjects.entries().next().value as [Id, string];
    pendingProjects.delete(id);
    await fetch(`/__store/project?id=${encodeURIComponent(id)}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } }).catch(() => undefined);
  }
  flushing = null;
}

export function mirrorProject(p: Project): void {
  if (!enabled() || !available) return;
  pendingProjects.set(p.id, JSON.stringify(p));
  flushing ??= flushProjects();
}

export function mirrorView(id: Id, view: ProjectView): void {
  if (!enabled() || !available) return;
  quiet(fetch(`/__store/view?id=${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(view), headers: { 'Content-Type': 'application/json' } }));
}

export function mirrorDelete(id: Id): void {
  if (!enabled() || !available) return;
  quiet(fetch(`/__store/project?id=${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

const blobsOnDisk = new Set<Id>();
const blobQueue: [Id, Blob][] = [];
let uploading = false;

/** Uploads a media blob once (skipped when the disk has it). One at a time: blobs can be large. */
export function mirrorBlob(key: Id, blob: Blob): void {
  if (!enabled() || !available || blobsOnDisk.has(key)) return;
  blobQueue.push([key, blob]);
  if (!uploading) void drainBlobs();
}

async function drainBlobs(): Promise<void> {
  uploading = true;
  try {
    while (blobQueue.length) {
      const [key, blob] = blobQueue.shift()!;
      if (blobsOnDisk.has(key)) continue;
      const url = `/__store/blob?key=${encodeURIComponent(key)}`;
      try {
        const head = await fetch(url, { method: 'HEAD' });
        if (head.status !== 200) await fetch(url, { method: 'PUT', body: blob }); // 204 = not there
        blobsOnDisk.add(key);
      } catch {
        /* retried at the next boot's sync */
      }
    }
  } finally {
    uploading = false;
  }
}

/** A media blob from the disk library, or null. */
export async function blobFromDisk(key: Id): Promise<Blob | null> {
  if (!enabled() || !available) return null;
  try {
    const r = await fetch(`/__store/blob?key=${encodeURIComponent(key)}`);
    if (r.status !== 200) return null; // 204 = not in the library
    blobsOnDisk.add(key);
    return await r.blob();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- boot sync

interface Library {
  /** The server keeps no library for this browser (e2e contexts without the opt-in cookie). */
  off?: boolean;
  projects: Project[];
  views: Record<Id, ProjectView>;
  deleted: Record<Id, number>;
}

/** What the boot sync needs from IndexedDB, without mirroring its own writes back. */
export interface LocalStore {
  allProjects(): Promise<Project[]>;
  putProject(p: Project): Promise<void>;
  deleteProject(id: Id): Promise<void>;
  loadView(id: Id): Promise<ProjectView | null>;
  putView(id: Id, v: ProjectView): Promise<void>;
  getBlob(key: Id): Promise<Blob | null>;
  lastProjectId(): Promise<Id | null>;
  setLastProjectId(id: Id): Promise<void>;
}

/** Merges this browser's projects with the disk library. Returns how many came in from disk. */
export async function syncWithDisk(local: LocalStore): Promise<number> {
  if (!enabled()) return 0;
  let lib: Library;
  try {
    const r = await fetch('/__store/projects');
    if (!r.ok || !(r.headers.get('Content-Type') ?? '').includes('json')) throw new Error(String(r.status));
    lib = (await r.json()) as Library;
    if (lib.off) throw new Error('library off');
  } catch {
    available = false; // no library on this server: IndexedDB only, as before
    return 0;
  }
  const mine = new Map((await local.allProjects()).map((p) => [p.id, p]));
  const disk = new Map(lib.projects.map((p) => [p.id, p]));
  let pulled = 0;

  // deleted elsewhere (and not edited here since): delete here too
  for (const [id, at] of Object.entries(lib.deleted)) {
    const p = mine.get(id);
    if (p && !disk.has(id) && p.updatedAt <= at) {
      await local.deleteProject(id);
      mine.delete(id);
    }
  }
  // disk → here
  for (const p of disk.values()) {
    const here = mine.get(p.id);
    if (!here || here.updatedAt < p.updatedAt) {
      await local.putProject(p);
      mine.set(p.id, p);
      pulled++;
    }
    const v = lib.views[p.id];
    if (v && !(await local.loadView(p.id))) await local.putView(p.id, v);
  }
  // here → disk (the first boot after this feature migrates everything already in this browser)
  for (const p of mine.values()) {
    const there = disk.get(p.id);
    if (!there || there.updatedAt < p.updatedAt) mirrorProject(p);
    if (!lib.views[p.id]) {
      const v = await local.loadView(p.id);
      if (v) mirrorView(p.id, v);
    }
    for (const a of Object.values(p.assets ?? {})) {
      if (blobsOnDisk.has(a.blobKey)) continue;
      const b = await local.getBlob(a.blobKey);
      if (b) mirrorBlob(a.blobKey, b);
    }
  }
  // a fresh browser profile: open the newest project instead of an empty one
  if (!(await local.lastProjectId()) && mine.size) {
    const newest = [...mine.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
    await local.setLastProjectId(newest.id);
  }
  return pulled;
}
