// @vitest-environment jsdom
/**
 * Project-level commands: leaving a project always saves it, opening one restores it, and
 * create / duplicate / rename / delete keep IndexedDB and the store in step.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { secToUs } from '../model/time';
import { resetAutosaveState, saveNow } from './autosave';
import { useEditor } from './index';
import { lastProjectId, loadProject, projectSummaries } from './persistence';
import { createAndOpenProject, duplicateProject, openProject, removeProject, renameProject } from './projects';
import { resetViewState } from './viewState';

const st = () => useEditor.getState();
const video = () =>
  createAsset({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 1, duration: secToUs(4), width: 1920, height: 1080, hasAudio: true });

function addClip() {
  const a = video();
  st().addAssets([a]);
  st().addClip(a.id, { at: 0 });
}

beforeEach(() => {
  localStorage.clear();
  st().newProject({ name: 'Start' });
  resetAutosaveState();
  resetViewState();
});

describe('project commands', () => {
  it('saves the project you leave and brings it back when you open it again', async () => {
    const a = await createAndOpenProject({ name: 'A' });
    addClip();
    st().setProjectName('A edited');

    const b = await createAndOpenProject({ name: 'B' });
    expect(st().project.id).toBe(b);
    expect(st().project.name).toBe('B');
    // leaving A wrote it, clip and all
    const savedA = await loadProject(a);
    expect(savedA?.name).toBe('A edited');
    expect(savedA?.tracks[0]?.clips).toHaveLength(1);

    expect(await openProject(a)).toBe(true);
    expect(st().project.name).toBe('A edited');
    expect(st().project.tracks[0]?.clips).toHaveLength(1);
    expect(await lastProjectId()).toBe(a);
  });

  it('creates a project that is on disk before the first edit', async () => {
    const id = await createAndOpenProject({ name: 'Fresh', aspect: '16:9' });
    const saved = await loadProject(id);
    expect(saved?.name).toBe('Fresh');
    expect(saved?.settings.aspect).toBe('16:9');
    expect((await projectSummaries()).some((p) => p.id === id)).toBe(true);
  });

  it('opening a project clears undo history and the selection', async () => {
    const a = await createAndOpenProject({ name: 'A' });
    const b = await createAndOpenProject({ name: 'B' });
    addClip();
    expect(st().past.length).toBeGreaterThan(0);
    expect(st().selection.clipIds).toHaveLength(1);
    await openProject(a);
    expect(st().past).toEqual([]);
    expect(st().future).toEqual([]);
    expect(st().selection.clipIds).toEqual([]);
    expect(st().playing).toBe(false);
    await openProject(b);
    expect(st().project.tracks[0]?.clips).toHaveLength(1); // B's clip was saved on the way out
  });

  it('refuses to open a project that is gone, keeping the current one', async () => {
    const a = await createAndOpenProject({ name: 'A' });
    expect(await openProject('prj_missing')).toBe(false);
    expect(st().project.id).toBe(a);
  });

  it('duplicates a project without leaving the one you are in', async () => {
    const a = await createAndOpenProject({ name: 'A' });
    addClip();
    const copyId = await duplicateProject(a);
    expect(copyId).toBeTruthy();
    const copy = await loadProject(copyId!);
    expect(copy?.name).toBe('A copy');
    expect(copy?.id).not.toBe(a);
    expect(copy?.tracks[0]?.clips).toHaveLength(1);
    // media is shared, not copied
    expect(Object.keys(copy!.assets)).toEqual(Object.keys(st().project.assets));
    expect(st().project.id).toBe(a);
    expect(await lastProjectId()).toBe(a);
  });

  it('renames the open project and a closed one', async () => {
    const a = await createAndOpenProject({ name: 'A' });
    const b = await createAndOpenProject({ name: 'B' });
    await renameProject(b, 'B renamed');
    expect(st().project.name).toBe('B renamed');
    expect((await loadProject(b))?.name).toBe('B renamed');

    await renameProject(a, '  Renamed from afar ');
    expect((await loadProject(a))?.name).toBe('Renamed from afar');
    expect(st().project.id).toBe(b); // still in B
    expect(await lastProjectId()).toBe(b);
  });

  it('deletes a project; deleting the open one leaves a blank project and no last project', async () => {
    const a = await createAndOpenProject({ name: 'A' });
    const b = await createAndOpenProject({ name: 'B' });
    await removeProject(a);
    expect(await loadProject(a)).toBeNull();
    expect(st().project.id).toBe(b);

    await removeProject(b);
    expect(await loadProject(b)).toBeNull();
    expect(st().project.id).not.toBe(b);
    expect(st().project.tracks[0]?.clips).toEqual([]);
    expect(await lastProjectId()).toBeNull();
    // the placeholder is not written back
    expect(await saveNow()).toBe(false);
  });
});
