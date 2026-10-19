/** Store additions applied by QA from docs/integration-notes (preview axis, multi-move, paste, flags, 3:4). */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip, mainTrack, migrateProject, timelineRows } from '../model/project';
import { secToUs } from '../model/time';
import { getFrameState } from '../engine/frameState';
import type { Clip, MediaAsset, Project } from '../model/types';
import { onAssetRemoved, useEditor } from './index';

const S = secToUs;
const st = () => useEditor.getState();
const proj = () => st().project;
const video = (name: string, sec: number): MediaAsset =>
  createAsset({ kind: 'video', name, mime: 'video/mp4', size: 1, duration: S(sec), width: 1080, height: 1920, hasAudio: true });
const image = () => createAsset({ kind: 'image', name: 'i.png', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100 });

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true });
});

describe('3:4 aspect', () => {
  it('sets 1080x1440', () => {
    st().setAspectRatio('3:4');
    expect(proj().settings).toMatchObject({ aspect: '3:4', width: 1080, height: 1440 });
  });
});

describe('previewTime', () => {
  it('is UI state, rounded, cleared by setProject', () => {
    st().setPreviewTime(1234.6);
    expect(st().previewTime).toBe(1235);
    expect(st().past).toHaveLength(0);
    st().setProject(proj());
    expect(st().previewTime).toBeNull();
  });
});

describe('moveClips', () => {
  it('moves overlay clips together by a delta in one undo step', () => {
    const a = image();
    st().addAssets([a]);
    const c1 = st().addClip(a.id, { at: 0, kind: 'overlay' })!;
    const c2 = st().addClip(a.id, { at: S(6), kind: 'overlay' })!;
    const before = st().past.length;
    expect(st().moveClips([c1, c2], S(2))).toBe(true);
    expect(findClip(proj(), c1)!.clip.start).toBe(S(2));
    expect(findClip(proj(), c2)!.clip.start).toBe(S(8));
    expect(st().past.length).toBe(before + 1);
    st().undo();
    expect(findClip(proj(), c1)!.clip.start).toBe(0);
  });
  it('moves a clip one row down onto the main track', () => {
    const v = video('v', 4);
    st().addAssets([v]);
    st().addClip(v.id, { at: 0 });
    const o = st().addClip(v.id, { at: 0, kind: 'overlay' })!;
    expect(timelineRows(proj())[0]!.kind).toBe('overlay');
    st().moveClips([o], S(10), 1);
    expect(findClip(proj(), o)!.track.kind).toBe('main');
    expect(proj().tracks.filter((t) => t.kind === 'overlay')).toHaveLength(0);
  });
});

describe('moveClip newTrack', () => {
  it('creates an overlay track between two overlays', () => {
    const a = image();
    st().addAssets([a]);
    const lo = st().addClip(a.id, { at: 0, kind: 'overlay' })!;
    const hi = st().addClip(a.id, { at: 0, kind: 'overlay' })!; // overlaps → second overlay above
    const m = st().addClip(a.id, { at: 0 })!; // main
    const loTrack = findClip(proj(), lo)!.track.id;
    st().moveClip(m, { start: 0, trackId: loTrack, newTrack: 'above' });
    const kinds = proj().tracks.map((t) => t.kind);
    expect(kinds).toEqual(['main', 'overlay', 'overlay', 'overlay']);
    const order = proj().tracks.map((t) => t.clips[0]?.id);
    expect(order.slice(1)).toEqual([lo, m, hi]);
  });
  it('a visual "below main" lands above main', () => {
    const a = image();
    st().addAssets([a]);
    st().addClip(a.id, { at: 0 });
    const o = st().addClip(a.id, { at: 0, kind: 'overlay' })!;
    st().moveClip(o, { start: S(1), trackId: mainTrack(proj()).id, newTrack: 'below' });
    expect(proj().tracks[0]!.kind).toBe('main');
    expect(findClip(proj(), o)!.clip.start).toBe(S(1));
  });
});

describe('insertClips', () => {
  it('pastes copies after the sources were deleted', () => {
    const v = video('v', 4);
    st().addAssets([v]);
    const id = st().addClip(v.id, { at: 0 })!;
    st().addTextClip({ at: S(1) });
    const snap: Clip[] = proj().tracks.flatMap((t) => t.clips).map((c) => structuredClone(c));
    st().deleteClips(snap.map((c) => c.id));
    expect(proj().tracks.flatMap((t) => t.clips)).toHaveLength(0);
    const out = st().insertClips(snap, S(2));
    expect(out).toHaveLength(2);
    expect(out).not.toContain(id);
    const text = proj().tracks.find((t) => t.kind === 'text')!.clips[0]!;
    expect(text.start).toBe(S(3));
    expect(st().selection.clipIds).toEqual(out);
  });
});

describe('enable flags', () => {
  it('blendEnabled=false draws normal at full opacity; adjustEnabled=false drops adjust', () => {
    const a = image();
    st().addAssets([a]);
    const id = st().addClip(a.id, { at: 0 })!;
    st().updateClip(id, { blend: 'screen', transform: { opacity: 0.5 }, adjust: { brightness: 30 } });
    let op = getFrameState(proj(), 0).ops[0]!;
    expect(op.kind === 'media' && op.composite).toBe('screen');
    st().updateClip(id, { blendEnabled: false, adjustEnabled: false });
    op = getFrameState(proj(), 0).ops[0]!;
    if (op.kind !== 'media') throw new Error('expected media op');
    expect(op.composite).toBe('source-over');
    expect(op.transform.opacity).toBe(1);
    expect(op.color.brightness).toBe(0);
  });
  it('migrates old clips without flags', () => {
    const a = image();
    st().addAssets([a]);
    const id = st().addClip(a.id, { at: 0 })!;
    const old = structuredClone(proj()) as Project;
    const c = old.tracks[0]!.clips[0]! as unknown as Record<string, unknown>;
    delete c.blendEnabled;
    delete c.adjustEnabled;
    st().setProject(old);
    expect(findClip(proj(), id)!.clip).toMatchObject({ blendEnabled: true, adjustEnabled: true });
    expect(migrateProject(proj())).toBe(proj());
  });
});

describe('onAssetRemoved', () => {
  it('runs hooks once an asset is gone from the document AND the undo history', () => {
    const a = image();
    st().addAssets([a]);
    const seen: string[] = [];
    const off = onAssetRemoved((id) => seen.push(id));
    st().removeAsset(a.id);
    expect(seen).toEqual([]); // ⌘Z can still bring it back: its media must stay
    st().undo();
    st().redo();
    expect(seen).toEqual([]);
    st().newProject(); // history gone: now it is unreachable
    off();
    expect(seen).toEqual([a.id]);
  });
});
