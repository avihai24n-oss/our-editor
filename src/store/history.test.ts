/** Undo history caps: count and estimated bytes; snapshots are plain JSON (no Blobs, no caches). */
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_LIMITS } from '../media/memory';
import { createAsset, createProject } from '../model/defaults';
import { secToUs } from '../model/time';
import { capHistory, snapshotBytes } from './history';
import { useEditor } from './index';

const st = () => useEditor.getState();

beforeEach(() => st().newProject());

describe('undo history caps', () => {
  it('caps by count', () => {
    const many = Array.from({ length: 300 }, () => createProject());
    const out = capHistory(many, 200, Infinity);
    expect(out).toHaveLength(200);
    expect(out[199]).toBe(many[299]);
  });

  it('caps by estimated bytes, keeping the newest steps', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ ...createProject(), name: 'x'.repeat(10_000) + i }));
    const one = snapshotBytes(big[0]!);
    const out = capHistory(big, 200, one * 3.5);
    expect(out).toHaveLength(3);
    expect(out[2]).toBe(big[9]);
  });

  it('the store never keeps more than the caps, and snapshots are JSON-only', () => {
    const a = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: secToUs(5), width: 1080, height: 1920, hasAudio: true });
    st().addAssets([a]);
    for (let i = 0; i < MEMORY_LIMITS.undoSteps + 40; i++) st().setProjectName(`n${i}`);
    expect(st().past.length).toBeLessThanOrEqual(MEMORY_LIMITS.undoSteps);
    for (const p of st().past) {
      // round-trips through JSON unchanged → no Blob / Map / element / cache in a snapshot
      expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    }
  });
});
