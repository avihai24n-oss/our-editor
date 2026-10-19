/**
 * The browser-wide LUT library (CapCut keeps imported LUTs app-wide, not per project).
 *
 * IndexedDB "our-editor-luts", store "luts": { id, name, size, text, addedAt }. Parsed cubes are
 * cached in memory; the renderer reads them synchronously with getLoadedLut(). A clip stores only
 * the LUT id + file name. Missing LUTs are skipped by the renderer and shown as "missing" in the UI.
 */
import { newId } from '../../model/defaults';
import { parseCube, type Lut3D } from './cube';

export interface LutMeta {
  id: string;
  name: string;
  /** Cube edge length (e.g. 33). */
  size: number;
  addedAt: number;
}

interface LutRecord extends LutMeta {
  text: string;
}

const DB_NAME = 'our-editor-luts';
const STORE = 'luts';
/** Larger files are refused (a 65³ cube is ~7 MB of text). */
export const MAX_CUBE_BYTES = 20 * 1024 * 1024;

const loaded = new Map<string, Lut3D>();
let metas: LutMeta[] | null = null;
const listeners = new Set<() => void>();
let dbPromise: Promise<IDBDatabase> | null = null;

function emit(): void {
  listeners.forEach((l) => l());
}

/** Subscribe to library changes (import, delete, a LUT finished loading). */
export function onLutsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error ?? req.error);
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Parsed LUT if it is in memory (synchronous, for the renderer). */
export function getLoadedLut(id: string): Lut3D | undefined {
  return loaded.get(id);
}

/** Cached list (null until listLuts() has run once). */
export const cachedLutList = (): LutMeta[] | null => metas;

export async function listLuts(): Promise<LutMeta[]> {
  try {
    const all = await tx<LutRecord[]>('readonly', (s) => s.getAll() as IDBRequest<LutRecord[]>);
    metas = all.map(({ id, name, size, addedAt }) => ({ id, name, size, addedAt })).sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    metas ??= [];
  }
  emit();
  return metas;
}

/** Loads (parses) the given LUTs into memory. Unknown ids are ignored. */
export async function ensureLuts(ids: Iterable<string>): Promise<void> {
  const want = [...new Set(ids)].filter((id) => id && !loaded.has(id));
  if (!want.length) return;
  let changed = false;
  for (const id of want) {
    try {
      const rec = await tx<LutRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<LutRecord | undefined>);
      if (!rec) continue;
      loaded.set(id, parseCube(rec.text));
      changed = true;
    } catch (e) {
      console.warn(`LUT ${id} could not be loaded`, e);
    }
  }
  if (changed) emit();
}

const pending = new Set<string>();
/** Fire-and-forget load for the renderer: true when the LUT is ready now. */
export function requestLut(id: string): boolean {
  if (loaded.has(id)) return true;
  if (!pending.has(id)) {
    pending.add(id);
    void ensureLuts([id]).finally(() => pending.delete(id));
  }
  return false;
}

/** Imports a .cube file: validates it, stores it and returns its meta. Throws CubeParseError. */
export async function importCubeFile(file: File | Blob, name = (file as File).name ?? 'LUT.cube'): Promise<LutMeta> {
  if (file.size > MAX_CUBE_BYTES) throw new Error(`${name} is larger than ${MAX_CUBE_BYTES / 1024 / 1024} MB`);
  const text = await file.text();
  return importCubeText(text, name);
}

export async function importCubeText(text: string, name: string): Promise<LutMeta> {
  const lut = parseCube(text);
  const rec: LutRecord = { id: newId('lut'), name, size: lut.size, addedAt: Date.now(), text };
  loaded.set(rec.id, lut);
  try {
    await tx('readwrite', (s) => s.put(rec));
  } catch (e) {
    console.warn('LUT kept for this session only (IndexedDB unavailable)', e);
  }
  const meta: LutMeta = { id: rec.id, name: rec.name, size: rec.size, addedAt: rec.addedAt };
  metas = [...(metas ?? []).filter((m) => m.id !== meta.id), meta];
  emit();
  return meta;
}

export async function deleteLut(id: string): Promise<void> {
  loaded.delete(id);
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
  metas = (metas ?? []).filter((m) => m.id !== id);
  emit();
}

/** Test helper. */
export function resetLutLibrary(): void {
  loaded.clear();
  metas = null;
  pending.clear();
  dbPromise = null;
}
