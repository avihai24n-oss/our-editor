// @vitest-environment jsdom
/**
 * Never losing work: a flush saves whatever differs from the last write, the page-hide events are
 * all wired, and a project whose IndexedDB write never committed is recovered on the next boot.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readUnsavedSnapshot,
  recoverUnsaved,
  resetAutosaveState,
  saveNow,
  startAutosave,
} from './autosave';
import { useEditor } from './index';
import * as persistence from './persistence';
import { resetViewState } from './viewState';

const st = () => useEditor.getState();

describe('durability', () => {
  let stop: (() => void) | null = null;
  beforeEach(() => {
    localStorage.clear();
    st().newProject({ name: 'Durable' });
    resetAutosaveState();
    resetViewState();
  });
  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The write starts inside the event handler, so it is observable as soon as it returns. */
  const settle = () => vi.waitFor(() => expect(st().saveStatus.saving).toBe(false));

  it('saves on pagehide without waiting for the debounce', async () => {
    const put = vi.spyOn(persistence, 'saveProject');
    stop = startAutosave();
    st().setProjectName('leaving');
    window.dispatchEvent(new Event('pagehide'));
    expect(put).toHaveBeenCalledTimes(1); // not in 800 ms — now
    await settle();
    expect((await persistence.loadProject(st().project.id))?.name).toBe('leaving');
  });

  it('saves on beforeunload and when the tab is hidden', async () => {
    const put = vi.spyOn(persistence, 'saveProject');
    stop = startAutosave();
    st().setProjectName('unloading');
    window.dispatchEvent(new Event('beforeunload'));
    expect(put).toHaveBeenCalledTimes(1);
    await settle();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    st().setProjectName('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(put).toHaveBeenCalledTimes(2);
    await settle();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect((await persistence.loadProject(st().project.id))?.name).toBe('hidden');
  });

  it('flushes a change the minimum-gap wait is still holding back', async () => {
    const put = vi.spyOn(persistence, 'saveProject');
    stop = startAutosave();
    st().setProjectName('first');
    window.dispatchEvent(new Event('pagehide'));
    expect(put).toHaveBeenCalledTimes(1);
    await settle();
    // inside the 2 s minimum gap the scheduled write has not run yet — the flush still saves
    st().setProjectName('second');
    window.dispatchEvent(new Event('pagehide'));
    expect(put).toHaveBeenCalledTimes(2);
    await settle();
    expect((await persistence.loadProject(st().project.id))?.name).toBe('second');
  });

  it('keeps a snapshot of a save that did not reach IndexedDB, and commits it on the next boot', async () => {
    vi.spyOn(persistence, 'saveProject').mockRejectedValueOnce(new Error('tab killed'));
    st().setProjectName('Unwritten');
    const id = st().project.id;
    expect(await saveNow()).toBe(false);
    expect(st().saveStatus.error).toBe('tab killed');
    // the synchronous snapshot survived
    expect(readUnsavedSnapshot()?.name).toBe('Unwritten');
    expect(await persistence.loadProject(id)).toBeNull();

    vi.restoreAllMocks();
    const recovered = await recoverUnsaved();
    expect(recovered?.name).toBe('Unwritten');
    expect((await persistence.loadProject(id))?.name).toBe('Unwritten');
    expect(readUnsavedSnapshot()).toBeNull();
    expect(await persistence.lastProjectId()).toBe(id);
  });

  it('clears the snapshot once the write lands', async () => {
    st().setProjectName('Written');
    expect(await saveNow()).toBe(true);
    expect(readUnsavedSnapshot()).toBeNull();
  });

  it('drops a snapshot the stored project is newer than', async () => {
    vi.spyOn(persistence, 'saveProject').mockRejectedValueOnce(new Error('tab killed'));
    st().setProjectName('Stale');
    await saveNow();
    const snap = readUnsavedSnapshot()!;
    vi.restoreAllMocks();
    // another tab saved the same project after the crash
    await persistence.saveProject({ ...snap, name: 'Newer', updatedAt: snap.updatedAt + 10_000 });
    expect(await recoverUnsaved()).toBeNull();
    expect((await persistence.loadProject(snap.id))?.name).toBe('Newer');
    expect(readUnsavedSnapshot()).toBeNull();
  });

  it('survives localStorage being unavailable', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    st().setProjectName('NoStorage');
    expect(await saveNow()).toBe(true);
    setItem.mockRestore();
  });
});

/**
 * Projects saved before the `views` store existed open a schema-v1 database. The version bump
 * must add the store and leave every saved project and media blob untouched.
 */
describe('upgrading a database written by an older build', () => {
  it('adds the views store and keeps the saved project and its media', async () => {
    // close the connection this suite's earlier tests opened, or the delete below is blocked
    (await persistence.openDb()).close();
    persistence.resetDbConnection();
    await new Promise<void>((res, rej) => {
      const r = indexedDB.deleteDatabase('our-editor');
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
      r.onblocked = () => res();
    });
    // the old schema, exactly as the previous build created it
    const legacy = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('our-editor', 1);
      r.onupgradeneeded = () => {
        for (const n of ['projects', 'blobs', 'meta']) r.result.createObjectStore(n);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const project = { ...useEditor.getState().project, id: 'prj_legacy', name: 'Made by the old build' };
    await new Promise<void>((res, rej) => {
      const tx = legacy.transaction(['projects', 'blobs', 'meta'], 'readwrite');
      tx.objectStore('projects').put(project, project.id);
      tx.objectStore('blobs').put(new Blob(['media']), 'blob_legacy');
      tx.objectStore('meta').put(project.id, 'lastProjectId');
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    legacy.close();

    // the new build opens it
    persistence.resetDbConnection();
    const db = await persistence.openDb();
    expect(db.version).toBe(2);
    expect([...db.objectStoreNames].sort()).toEqual(['blobs', 'meta', 'projects', 'views']);
    expect((await persistence.loadLastProject())?.name).toBe('Made by the old build');
    expect(await persistence.getBlob('blob_legacy')).not.toBeNull();
    // and the new per-project view state works on it
    await persistence.saveView('prj_legacy', { playhead: 1_000_000, zoom: 80, selection: [], savedAt: Date.now() });
    expect((await persistence.loadView('prj_legacy'))?.zoom).toBe(80);
  });
});
