/**
 * Linkage (toolbar link toggle, ~): clips on other tracks are attached to the main / overlay clip
 * under their start and follow its ripple, move, trim and delete (ops.followAttached).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import { secToUs } from '../model/time';
import type { MediaAsset } from '../model/types';
import { useEditor } from './index';
import { projectViolations } from './invariants';
import { attachedAnchors } from './ops';
import { presetCurve } from '../model/speedCurve';

const S = secToUs;
const st = () => useEditor.getState();
const video = (sec: number): MediaAsset =>
  createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(sec), width: 1920, height: 1080, hasAudio: true });
const audio = (sec: number): MediaAsset => createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: S(sec), hasAudio: true });
const at = (id: string) => findClip(st().project, id)?.clip;
const start = (id: string) => at(id)?.start;
const clean = () => expect(projectViolations(st().project, { magnet: st().magnet, selection: st().selection.clipIds })).toEqual([]);

/** One edit = one undo step, and undo gives back the exact document. */
function oneStep(fn: () => unknown) {
  const before = JSON.stringify(st().project);
  const n = st().past.length;
  fn();
  expect(st().past.length).toBe(n + 1);
  clean();
  const after = JSON.stringify(st().project);
  st().undo();
  expect(JSON.stringify(st().project)).toBe(before);
  st().redo();
  expect(JSON.stringify(st().project)).toBe(after);
}

/**
 * Avihai's layout: main track empty; overlay V1 (0-5) V2 (5-10) V3 (10-15); the voice of V2 (5-9)
 * and of V3 (10-14) on an audio track; a sound effect inside V2 (7-8) on another; music 0-30.
 */
function overlayLayout() {
  const v = video(20);
  const voice = audio(4);
  const sfx = audio(1);
  const music = audio(30);
  st().addAssets([v, voice, sfx, music]);
  useEditor.setState({ linkage: false });
  const V1 = st().addClip(v.id, { at: 0, kind: 'overlay' })!;
  st().trimEnd(V1, S(5));
  const ov = findClip(st().project, V1)!.track.id;
  const V2 = st().addClip(v.id, { at: S(5), trackId: ov })!;
  st().trimEnd(V2, S(10));
  const V3 = st().addClip(v.id, { at: S(10), trackId: ov })!;
  st().trimEnd(V3, S(15));
  const a2 = st().addClip(voice.id, { at: S(5) })!;
  const au = findClip(st().project, a2)!.track.id;
  const a3 = st().addClip(voice.id, { at: S(10), trackId: au })!;
  const fx = st().addClip(sfx.id, { at: S(7) })!;
  const m = st().addClip(music.id, { at: 0 })!;
  useEditor.setState({ linkage: true });
  return { V1, V2, V3, a2, a3, fx, m, ov, au };
}

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true, linkage: true });
});

describe('attachment rule', () => {
  it('a clip is attached to the anchor clip under its START (main first, then overlays)', () => {
    const { V1, V2, V3, a2, a3, fx, m } = overlayLayout();
    const p = st().project;
    expect(attachedAnchors(p, a2)).toEqual([V2]);
    expect(attachedAnchors(p, a3)).toEqual([V3]);
    expect(attachedAnchors(p, fx)).toEqual([V2]);
    expect(attachedAnchors(p, m)).toEqual([V1]); // the music hangs on the first shot only
    expect(attachedAnchors(p, V2)).toEqual([]); // no main-track clip under it
  });
  it('an overlay clip hangs on the main-track clip; a text clip on main then overlay', () => {
    const v = video(20);
    st().addAssets([v]);
    const A = st().addClip(v.id, { at: 0 })!;
    st().trimEnd(A, S(5));
    const O = st().addClip(v.id, { at: S(2), kind: 'overlay' })!;
    st().trimEnd(O, S(4));
    const T = st().addTextClip({ at: S(3) });
    expect(attachedAnchors(st().project, O)).toEqual([A]);
    expect(attachedAnchors(st().project, T)).toEqual([A, O]);
    expect(attachedAnchors(st().project, A)).toEqual([]);
  });
});

describe('overlay track + magnet (his project)', () => {
  it('trim the END of V1: V2, V3 and their voices move left together; the music stays', () => {
    const { V1, V2, V3, a2, a3, fx, m } = overlayLayout();
    oneStep(() => st().trimEnd(V1, S(4)));
    expect([start(V2), start(V3), start(a2), start(a3), start(fx)]).toEqual([S(4), S(9), S(4), S(9), S(6)]);
    expect(at(m)).toMatchObject({ start: 0, duration: S(30) });
  });
  it('lengthening V1 pushes them right the same way', () => {
    const { V1, V2, a2, a3, m } = overlayLayout();
    st().trimEnd(V1, S(4));
    st().trimEnd(V1, S(4.5));
    expect([start(V2), start(a2), start(a3), start(m)]).toEqual([S(4.5), S(4.5), S(9.5), 0]);
  });
  it('linkage off: the video ripples, the audio stays', () => {
    const { V1, V2, a2, a3, fx } = overlayLayout();
    st().setLinkage(false);
    st().trimEnd(V1, S(4));
    expect(start(V2)).toBe(S(4));
    expect([start(a2), start(a3), start(fx)]).toEqual([S(5), S(10), S(7)]);
  });
  it('trim the START of V2 (ripple): its content moves left — the effect follows it, the voice whose start was cut stays', () => {
    const { V2, V3, a2, a3, fx, m } = overlayLayout();
    oneStep(() => st().trimStart(V2, S(6)));
    expect(at(V2)).toMatchObject({ start: S(5), duration: S(4) });
    expect(start(V3)).toBe(S(9));
    expect(start(a3)).toBe(S(9));
    expect(start(fx)).toBe(S(6)); // was 2 s into V2's content, still is
    expect(start(a2)).toBe(S(5)); // its start point was trimmed away: keeps its place
    expect(start(m)).toBe(0);
  });
  it('REGRESSION: a left trim of a speed-curve clip ripples too (was: shift lost, the clip moved and left a gap)', () => {
    const { V2, V3, a3 } = overlayLayout();
    st().setSpeedCurve(V2, presetCurve('custom')); // flat 1x curve
    const d0 = at(V2)!.duration;
    const v3 = start(V3)!;
    st().trimStart(V2, S(6));
    const cut = d0 - at(V2)!.duration;
    expect(cut).toBeGreaterThan(0);
    expect(start(V2)).toBe(S(5));
    expect(start(V3)).toBe(v3 - cut);
    expect(start(a3)).toBe(v3 - cut);
  });
  it('trim the END of V2: its own clips stay, V3 and its voice move', () => {
    const { V2, V3, a2, a3, fx } = overlayLayout();
    st().trimEnd(V2, S(9));
    expect([start(a2), start(fx), start(V3), start(a3)]).toEqual([S(5), S(7), S(9), S(9)]);
  });
  it('magnet off: no ripple, so nothing follows a trim', () => {
    const { V1, V2, a2 } = overlayLayout();
    st().setMagnet(false);
    st().trimEnd(V1, S(4));
    expect([start(V2), start(a2)]).toEqual([S(5), S(5)]);
  });
  it('delete V2: the clips lying inside it go with it (CapCut); the music and V3 stay', () => {
    const { V2, V3, a2, a3, fx, m } = overlayLayout();
    oneStep(() => st().deleteClips([V2]));
    expect(at(a2)).toBeUndefined();
    expect(at(fx)).toBeUndefined();
    expect([start(V3), start(a3), start(m)]).toEqual([S(10), S(10), 0]);
  });
  it('delete V1: the music attached to it is longer than V1, so it is kept', () => {
    const { V1, m } = overlayLayout();
    st().deleteClips([V1]);
    expect(at(m)).toMatchObject({ start: 0, duration: S(30) });
  });
  it('delete with linkage off keeps every other clip', () => {
    const { V2, a2, fx } = overlayLayout();
    st().setLinkage(false);
    st().deleteClips([V2]);
    expect(at(a2)).toBeDefined();
    expect(at(fx)).toBeDefined();
  });
  it('split V2 at 6.5 s and delete the right part: the effect (7 s) goes, the voice (5 s) stays', () => {
    const { V2, a2, fx } = overlayLayout();
    st().setPlayhead(S(6.5));
    st().select([V2]);
    const [right] = st().splitAtPlayhead();
    expect(right).toBeTruthy();
    expect([start(a2), start(fx)]).toEqual([S(5), S(7)]); // a split moves nothing
    st().deleteClips([right!]);
    expect(at(fx)).toBeUndefined();
    expect(start(a2)).toBe(S(5));
  });
  it('moving V3 carries its voice; moving both together moves the voice once', () => {
    const { V3, a3 } = overlayLayout();
    oneStep(() => st().moveClip(V3, { start: S(20) }));
    expect([start(V3), start(a3)]).toEqual([S(20), S(20)]);
    st().undo();
    st().moveClips([V3, a3], S(2), 0);
    expect([start(V3), start(a3)]).toEqual([S(12), S(12)]);
  });
  it('a clip on a locked track never moves', () => {
    const { V1, V2, a2, a3, au } = overlayLayout();
    st().setTrack(au, { locked: true });
    st().trimEnd(V1, S(4));
    expect(start(V2)).toBe(S(4));
    expect([start(a2), start(a3)]).toEqual([S(5), S(10)]);
  });
  it('a followed clip that would overlap goes to a new track instead of being pushed', () => {
    const { V1, a2, au } = overlayLayout();
    // a clip on the voice track right before a2, attached to V1 (stays) — a2 moving left would hit it
    const blip = st().addClip(st().project.assets[Object.keys(st().project.assets)[2]!]!.id, { at: S(4), trackId: au })!;
    st().trimEnd(V1, S(4));
    expect(start(blip)).toBe(S(4));
    expect(start(a2)).toBe(S(4));
    expect(findClip(st().project, a2)!.track.id).not.toBe(au);
    clean();
  });
});

describe('main track (CapCut linkage)', () => {
  function mainLayout() {
    const v = video(20);
    const voice = audio(2);
    const music = audio(30);
    st().addAssets([v, voice, music]);
    useEditor.setState({ linkage: false });
    const A = st().addClip(v.id, { at: 0 })!;
    st().trimEnd(A, S(5));
    const B = st().addClip(v.id, { at: S(5) })!;
    st().trimEnd(B, S(10));
    const T = st().addTextClip({ at: S(6) });
    st().trimEnd(T, S(7));
    const O = st().addClip(v.id, { at: S(6), kind: 'overlay' })!;
    st().trimEnd(O, S(8));
    const va = st().addClip(voice.id, { at: S(1) })!;
    const m = st().addClip(music.id, { at: 0 })!;
    useEditor.setState({ linkage: true });
    return { A, B, T, O, va, m };
  }
  it('ripple delete of A: B moves to 0 with its text and overlay; A\'s voice goes; the music stays', () => {
    const { A, B, T, O, va, m } = mainLayout();
    oneStep(() => st().deleteClips([A]));
    expect([start(B), start(T), start(O)]).toEqual([0, S(1), S(1)]);
    expect(at(va)).toBeUndefined();
    expect(at(m)).toMatchObject({ start: 0, duration: S(30) });
  });
  it('reorder: B dragged before A takes its clips along', () => {
    const { A, B, T, O, va } = mainLayout();
    st().moveClip(B, { start: 0 });
    expect([start(B), start(A)]).toEqual([0, S(5)]);
    expect([start(T), start(O), start(va)]).toEqual([S(1), S(1), S(6)]);
  });
  it('trim the end of A: B\'s clips ripple with it', () => {
    const { A, T, O, va, m } = mainLayout();
    st().trimEnd(A, S(4));
    expect([start(T), start(O), start(va), start(m)]).toEqual([S(5), S(5), S(1), 0]);
  });
  it('a new clip inserted at the start pushes the attached clips with the main track', () => {
    const { T, O } = mainLayout();
    const v2 = video(3);
    st().addAssets([v2]);
    st().addClip(v2.id, { at: 0 });
    expect([start(T), start(O)]).toEqual([S(9), S(9)]);
  });
  it('linkage off: other tracks stay put', () => {
    const { A, T, O, va } = mainLayout();
    st().setLinkage(false);
    st().deleteClips([A]);
    expect([start(T), start(O), start(va)]).toEqual([S(6), S(6), S(1)]);
  });
});
