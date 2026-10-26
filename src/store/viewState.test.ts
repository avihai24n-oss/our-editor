// @vitest-environment jsdom
/** Per-project view state: saved where the user was, restored only where it still makes sense. */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../model/catalog';
import { createAsset } from '../model/defaults';
import { projectDuration, secToUs } from '../model/time';
import { resetAutosaveState } from './autosave';
import { useEditor } from './index';
import * as persistence from './persistence';
import { createAndOpenProject, openProject } from './projects';
import { resetViewState, restoreView, saveViewNow, startViewAutosave } from './viewState';

const st = () => useEditor.getState();

function addClip() {
  const a = createAsset({ kind: 'video', name: 'c.mp4', mime: 'video/mp4', size: 1, duration: secToUs(4), width: 1920, height: 1080, hasAudio: true });
  st().addAssets([a]);
  return st().addClip(a.id, { at: 0 })!;
}

beforeEach(() => {
  localStorage.clear();
  st().newProject({ name: 'V' });
  resetAutosaveState();
  resetViewState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('view state', () => {
  it('brings back the playhead, the zoom and the selection of the project you reopen', async () => {
    const a = await createAndOpenProject({ name: 'A' });
    const clip = addClip();
    st().setPlayhead(secToUs(2));
    st().setZoom(120);
    st().select([clip]);

    await createAndOpenProject({ name: 'B' }); // leaving A saves its view
    expect(st().playhead).toBe(0);
    expect(st().selection.clipIds).toEqual([]);

    await openProject(a);
    expect(st().playhead).toBe(secToUs(2));
    expect(st().zoom).toBe(120);
    expect(st().selection.clipIds).toEqual([clip]);
  });

  it('drops what the document no longer supports', async () => {
    addClip();
    const p = st().project;
    await persistence.saveView(p.id, { playhead: secToUs(999), zoom: 99_999, selection: ['gone'], savedAt: Date.now() });
    await restoreView(p);
    expect(st().playhead).toBe(projectDuration(p));
    expect(st().zoom).toBe(LIMITS.zoomMax);
    expect(st().selection.clipIds).toEqual([]);
  });

  it('writes nothing while the project is playing, and once it stops', async () => {
    addClip();
    const put = vi.spyOn(persistence, 'saveView');
    const stop = startViewAutosave();
    try {
      st().play();
      for (let i = 1; i <= 20; i++) st().setPlayhead(secToUs(i / 10));
      await new Promise((r) => setTimeout(r, 1400));
      expect(put).not.toHaveBeenCalled();

      st().pause();
      st().setPlayhead(secToUs(3));
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1), { timeout: 4000 });
    } finally {
      stop();
    }
  });

  it('skips a write when nothing moved', async () => {
    const put = vi.spyOn(persistence, 'saveView');
    expect(await saveViewNow()).toBe(true);
    expect(await saveViewNow()).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
