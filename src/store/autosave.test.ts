/** Autosave write rules: debounced, JSON only, skipped when unchanged, never self-triggering. */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autosaveWrites, projectFingerprint, resetAutosaveState, saveNow, startAutosave } from './autosave';
import { useEditor } from './index';
import * as persistence from './persistence';

const st = () => useEditor.getState();

describe('autosave', () => {
  let stop: (() => void) | null = null;
  beforeEach(() => {
    st().newProject({ name: 'A' });
    resetAutosaveState();
  });
  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not write while nothing changes, and a save does not schedule another save', async () => {
    vi.useFakeTimers();
    const put = vi.spyOn(persistence, 'saveProject');
    stop = startAutosave();
    await vi.advanceTimersByTimeAsync(10 * 60_000); // ten idle minutes
    expect(put).not.toHaveBeenCalled();

    st().setProjectName('B');
    await vi.advanceTimersByTimeAsync(5000);
    expect(put).toHaveBeenCalledTimes(1);
    // the save only changed saveStatus → nothing else is scheduled
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('debounces a burst of edits into one write, and keeps writes ≥ the minimum gap apart', async () => {
    vi.useFakeTimers();
    const put = vi.spyOn(persistence, 'saveProject');
    stop = startAutosave();
    for (let i = 0; i < 50; i++) {
      st().setProjectName(`n${i}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);
    st().setProjectName('again');
    await vi.advanceTimersByTimeAsync(900); // past the debounce but inside the 2 s gap
    expect(put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('skips a save when only updatedAt differs', async () => {
    const put = vi.spyOn(persistence, 'saveProject');
    expect(await saveNow()).toBe(true);
    useEditor.setState({ project: { ...st().project, updatedAt: st().project.updatedAt + 5000 } });
    expect(await saveNow()).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
    expect(autosaveWrites()).toBe(1);
  });

  it('writes only the project JSON (no Blobs)', async () => {
    const put = vi.spyOn(persistence, 'saveProject');
    const blob = vi.spyOn(persistence, 'putBlob');
    st().setProjectName('json only');
    await saveNow();
    expect(blob).not.toHaveBeenCalled();
    const written = put.mock.calls[0]![0];
    expect(JSON.parse(projectFingerprint(written)).name).toBe('json only');
  });
});
