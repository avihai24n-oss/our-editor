/**
 * Media bin lifecycle (audit 2026-10-19): deleting an asset is one undo step that ⌘Z fully
 * reverses, imports and "Media lost" flags are not undo steps, the same file is never imported
 * twice, a lost file is relinked by importing it again, and unreachable blobs are swept.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip, mainTrack } from '../model/project';
import { secToUs } from '../model/time';
import type { MediaAsset } from '../model/types';
import { getAssetUrl } from '../media/registry';
import { sweepOrphanBlobs } from './autosave';
import { liveAssets, useEditor } from './index';
import { getBlob, listBlobKeys, putBlob, saveProject } from './persistence';

const S = secToUs;
const st = () => useEditor.getState();
const proj = () => st().project;
const video = (name: string, sec: number, size = 100): MediaAsset =>
  createAsset({ kind: 'video', name, mime: 'video/mp4', size, duration: S(sec), width: 1080, height: 1920, hasAudio: true });
const orphanClips = () =>
  proj().tracks.flatMap((t) => t.clips).filter((c) => c.type !== 'text' && c.type !== 'compound' && !proj().assets[c.assetId]).length;

beforeAll(() => {
  // node has no object URLs
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${++n}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
});

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true });
});

describe('removeAsset is one undo step', () => {
  it('undo brings back the asset and its clips; redo removes both again; no orphan clips', () => {
    const a = video('a.mp4', 4);
    const b = video('b.mp4', 3);
    st().addAssets([a, b]);
    const ca = st().addClip(a.id, { at: 0 })!;
    st().addClip(b.id, { at: S(10) });
    st().addTransition(ca, 'mix');
    st().removeAsset(a.id);
    expect(proj().assets[a.id]).toBeUndefined();
    expect(findClip(proj(), ca)).toBeUndefined();
    expect(mainTrack(proj()).transitions).toHaveLength(0);
    expect(mainTrack(proj()).clips[0]!.start).toBe(0); // magnet closed the gap
    st().undo();
    expect(proj().assets[a.id]).toBeDefined();
    expect(findClip(proj(), ca)).toBeDefined();
    expect(mainTrack(proj()).transitions).toHaveLength(1);
    expect(orphanClips()).toBe(0);
    st().redo();
    expect(proj().assets[a.id]).toBeUndefined();
    expect(findClip(proj(), ca)).toBeUndefined();
    expect(orphanClips()).toBe(0);
    // undoing the step BEFORE the delete never resurrects a clip without its asset
    st().undo();
    st().undo();
    expect(orphanClips()).toBe(0);
  });

  it('removes clips on a locked track too (a clip never outlives its media)', () => {
    const a = video('a.mp4', 4);
    st().addAssets([a]);
    st().addClip(a.id, { at: 0, kind: 'overlay' });
    const overlay = proj().tracks.find((t) => t.kind === 'overlay')!;
    st().setTrack(overlay.id, { locked: true });
    st().removeAsset(a.id);
    expect(orphanClips()).toBe(0);
    expect(proj().tracks.flatMap((t) => t.clips)).toHaveLength(0);
  });

  it('keeps the asset live (URL + blob) while history holds it', () => {
    const a = video('a.mp4', 4);
    st().addAssets([a]);
    st().removeAsset(a.id);
    expect(liveAssets().has(a.id)).toBe(true);
    st().newProject();
    expect(liveAssets().has(a.id)).toBe(false);
  });
});

describe('media-bin changes are not undo steps', () => {
  it('an import lands in every snapshot: undo / redo / cancel never drop it', () => {
    const a = video('a.mp4', 4);
    st().addAssets([a]);
    st().addClip(a.id);
    const b = video('b.mp4', 2);
    st().addAssets([b]); // imported after the edit
    st().undo();
    expect(proj().assets[b.id]).toBeDefined();
    st().redo();
    expect(proj().assets[b.id]).toBeDefined();
    st().beginTx();
    st().setProjectName('x');
    const c = video('c.mp4', 2);
    st().addAssets([c]);
    st().cancelTx();
    expect(proj().assets[c.id]).toBeDefined();
  });

  it('a relinked asset stays found after undo', () => {
    const a = video('a.mp4', 4);
    st().addAssets([a]);
    st().setAssetsMissing([a.id]);
    st().addClip(a.id);
    st().setAssetsMissing([]);
    st().undo();
    expect(proj().assets[a.id]!.missing).toBeUndefined();
  });
});

describe('locked main track', () => {
  it('addClip never touches a locked main track: the clip goes to an overlay track (qa-timeline rule)', () => {
    const a = video('a.mp4', 4);
    st().addAssets([a]);
    st().setTrack(mainTrack(proj()).id, { locked: true });
    const id = st().addClip(a.id);
    expect(id).not.toBeNull();
    expect(mainTrack(proj()).clips).toHaveLength(0);
    expect(proj().tracks.find((t) => t.clips.some((c) => c.id === id))!.kind).toBe('overlay');
  });
});

describe('importFiles: the same file twice, relink', () => {
  const file = (name: string, size: number, type = 'video/mp4') => new File([new Uint8Array(size)], name, { type });

  it('a file already in the bin is not imported again', async () => {
    const a = video('clip.mp4', 4, 1234);
    st().addAssets([a]);
    const r = await st().importFiles([file('clip.mp4', 1234), file('clip.mp4', 1234)]);
    expect(r).toEqual({ assetIds: [a.id], errors: [], reused: [a.id], relinked: [] });
    expect(Object.keys(proj().assets)).toEqual([a.id]);
  });

  it('a "Media lost" asset gets its file back (blob stored under its key, URL registered)', async () => {
    const a = video('clip.mp4', 4, 50);
    st().addAssets([a]);
    st().setAssetsMissing([a.id]);
    const r = await st().importFiles([file('clip.mp4', 50)]);
    expect(r.relinked).toEqual([a.id]);
    expect(r.assetIds).toEqual([a.id]);
    expect(proj().assets[a.id]!.missing).toBeUndefined();
    expect(Object.keys(proj().assets)).toHaveLength(1);
    expect(getAssetUrl(a.id)).toMatch(/^blob:/);
    expect((await getBlob(a.blobKey))?.size).toBe(50);
  });

  it('a relink of the wrong kind is refused', async () => {
    const a = video('clip.mp4', 4, 50);
    st().addAssets([a]);
    st().setAssetsMissing([a.id]);
    const r = await st().importFiles([file('clip.mp4', 50, 'audio/mpeg')]);
    expect(r.errors[0]).toMatch(/Cannot relink/);
    expect(proj().assets[a.id]!.missing).toBe(true);
  });
});

describe('sweepOrphanBlobs', () => {
  it('deletes stored blobs no saved project and no live asset uses', async () => {
    const keep = video('keep.mp4', 1);
    const live = video('live.mp4', 1);
    await putBlob(keep.blobKey, new Blob(['k']));
    await putBlob(live.blobKey, new Blob(['l']));
    await putBlob('ast_orphan', new Blob(['o']));
    const saved = proj();
    await saveProject({ ...saved, assets: { [keep.id]: keep } });
    st().addAssets([live]);
    expect(await sweepOrphanBlobs()).toBeGreaterThanOrEqual(1); // + blobs left by the tests above
    const keys = await listBlobKeys();
    expect(keys).toContain(keep.blobKey);
    expect(keys).toContain(live.blobKey);
    expect(keys).not.toContain('ast_orphan');
  });
});
