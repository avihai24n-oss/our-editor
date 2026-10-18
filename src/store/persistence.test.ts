import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createProject } from '../model/defaults';
import { deleteProject, getBlob, listProjects, loadLastProject, loadProject, putBlob, saveProject } from './persistence';
import { useEditor } from './index';
import { saveNow } from './autosave';

describe('IndexedDB persistence', () => {
  it('saves and loads projects; remembers the last one', async () => {
    const a = createProject({ name: 'A' });
    const b = createProject({ name: 'B', aspect: '16:9' });
    await saveProject(a);
    await saveProject(b);
    expect((await loadProject(a.id))?.name).toBe('A');
    expect((await loadLastProject())?.id).toBe(b.id);
    expect((await listProjects()).map((p) => p.name).sort()).toEqual(['A', 'B']);
    await deleteProject(a.id);
    expect(await loadProject(a.id)).toBeNull();
  });

  it('stores blobs', async () => {
    await putBlob('k1', new Blob(['hello'], { type: 'text/plain' }));
    const b = await getBlob('k1');
    expect(b).not.toBeNull();
    expect(await getBlob('missing')).toBeNull();
  });

  it('saveNow writes the store project and updates the status', async () => {
    useEditor.getState().newProject({ name: 'Saved' });
    await saveNow();
    const st = useEditor.getState().saveStatus;
    expect(st.lastSavedAt).not.toBeNull();
    expect(st.error).toBeNull();
    expect((await loadLastProject())?.name).toBe('Saved');
  });
});
