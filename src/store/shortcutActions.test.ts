/** Store actions and command wiring added for the CapCut shortcut set (⌘⇧B, [ ], I/O, ⌘. ⌘, , ⌘⇧S…). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsset } from '../model/defaults';
import { audioLinked, findClip, mainTrack } from '../model/project';
import { clipEnd, secToUs } from '../model/time';
import type { AudioClip, MediaAsset, VideoClip } from '../model/types';
import { runCommand } from '../timeline/shortcuts';
import { useTimelineUi } from '../timeline/uiStore';
import { onAppEvent } from '../ui/appEvents';
import { useEditor } from './index';

const S = secToUs;
const st = () => useEditor.getState();
const proj = () => st().project;
const clip = (id: string) => findClip(proj(), id)!.clip;
const ui = () => useTimelineUi.getState();

const video = (name: string, sec: number, hasAudio = true): MediaAsset =>
  createAsset({ kind: 'video', name, mime: 'video/mp4', size: 1, duration: S(sec), width: 1920, height: 1080, hasAudio });
const audio = (name = 'a.mp3', sec = 10) => createAsset({ kind: 'audio', name, mime: 'audio/mpeg', size: 1, duration: S(sec), hasAudio: true });

/** main: A [0,4s) B [4,10s); overlay O [2,6s); audio M [1,9s). Returns the ids. */
function setup() {
  const a = video('a.mp4', 4);
  const b = video('b.mp4', 6);
  const o = video('o.mp4', 4);
  const m = audio('m.mp3', 8);
  st().addAssets([a, b, o, m]);
  const A = st().addClip(a.id, { at: 0 })!;
  const B = st().addClip(b.id, { at: S(4) })!;
  const O = st().addClip(o.id, { at: S(2), kind: 'overlay' })!;
  const M = st().addClip(m.id, { at: S(1) })!;
  st().clearSelection();
  return { A, B, O, M, assets: { a, b, o, m } };
}

const toasts: string[] = [];
let offToast: () => void;
beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true, zoom: 60 });
  ui().clearArea();
  ui().setTool('select');
  toasts.length = 0;
  offToast = onAppEvent('toast', ({ message }) => toasts.push(message));
});
afterEach(() => offToast());

describe('splitAllAtPlayhead (⌘⇧B)', () => {
  it('splits every unlocked clip under the playhead even when one is selected, in one undo step', () => {
    const { A, O, M } = setup();
    st().setPlayhead(S(3));
    st().select([A]);
    const before = st().past.length;
    const made = st().splitAllAtPlayhead();
    expect(made).toHaveLength(3);
    expect(clipEnd(clip(A))).toBe(S(3));
    expect(clipEnd(clip(O))).toBe(S(3));
    expect(clipEnd(clip(M))).toBe(S(3));
    expect(st().past.length).toBe(before + 1);
    st().undo();
    expect(clipEnd(clip(A))).toBe(S(4));
  });
  it('skips locked tracks; plain ⌘B with a selection still splits only the selection', () => {
    const { A, O } = setup();
    st().setTrack(findClip(proj(), O)!.track.id, { locked: true });
    st().setPlayhead(S(3));
    st().splitAllAtPlayhead();
    expect(clipEnd(clip(O))).toBe(S(6));
    expect(clipEnd(clip(A))).toBe(S(3));
    st().undo();
    st().select([A]);
    st().splitAtPlayhead();
    expect(mainTrack(proj()).clips).toHaveLength(3);
  });
  it('is a no-op (no undo step) with nothing under the playhead', () => {
    setup();
    st().setPlayhead(S(50));
    const before = st().past.length;
    expect(st().splitAllAtPlayhead()).toEqual([]);
    expect(st().past.length).toBe(before);
  });
});

describe('selectSide ([ / ])', () => {
  it('[ selects clips that start before the playhead, ] clips that end after it', () => {
    const { A, B, O, M } = setup();
    st().setPlayhead(S(4));
    expect(new Set(st().selectSide('left'))).toEqual(new Set([A, O, M]));
    expect(new Set(st().selection.clipIds)).toEqual(new Set([A, O, M]));
    expect(new Set(st().selectSide('right'))).toEqual(new Set([B, O, M]));
  });
  it('ignores locked tracks', () => {
    const { O } = setup();
    st().setTrack(findClip(proj(), O)!.track.id, { locked: true });
    st().setPlayhead(S(3));
    expect(st().selectSide('left')).not.toContain(O);
  });
});

describe('nudgeVolume (⌘. / ⌘,)', () => {
  it('adds dB to clips with audio, clamps to the inspector range, one undo step', () => {
    const { A, M } = setup();
    const before = st().past.length;
    expect(st().nudgeVolume([A, M], 1)).toBe(2);
    expect((clip(A) as VideoClip).audio.volumeDb).toBe(1);
    expect((clip(M) as AudioClip).audio.volumeDb).toBe(1);
    expect(st().past.length).toBe(before + 1);
    for (let i = 0; i < 40; i++) st().nudgeVolume([A], 1);
    expect((clip(A) as VideoClip).audio.volumeDb).toBe(20);
    for (let i = 0; i < 100; i++) st().nudgeVolume([A], -1);
    expect((clip(A) as VideoClip).audio.volumeDb).toBe(-60);
  });
  it('skips silent videos and text; returns 0 when nothing has audio', () => {
    const silent = video('s.mp4', 3, false);
    st().addAssets([silent]);
    const V = st().addClip(silent.id, { at: 0 })!;
    const T = st().addTextClip({ at: 0 });
    const before = st().past.length;
    expect(st().nudgeVolume([V, T], 1)).toBe(0);
    expect(st().past.length).toBe(before);
  });
  it('runCommand volumeUp/volumeDown act on the selection', () => {
    const { A } = setup();
    st().select([A]);
    runCommand('volumeUp');
    runCommand('volumeUp');
    runCommand('volumeDown');
    expect((clip(A) as VideoClip).audio.volumeDb).toBe(1);
    st().clearSelection();
    runCommand('volumeUp');
    expect(toasts.at(-1)).toMatch(/audio/i);
  });
});

describe('toggleExtractAudio (⌘⇧S)', () => {
  it('extracts to a new audio track with the same span and mutes the video; restore undoes it', () => {
    const { B, assets } = setup();
    st().setSpeed(B, 2); // B: 3 s long at 2x
    st().trimStart(B, clip(B).start + S(1)); // inPoint 2 s
    const v = clip(B) as VideoClip;
    const audioTracks = proj().tracks.filter((t) => t.kind === 'audio').length;
    const r = st().toggleExtractAudio([B]);
    expect(r.extracted).toHaveLength(1);
    const x = clip(r.extracted[0]!) as AudioClip;
    expect(x).toMatchObject({ type: 'audio', assetId: assets.b.id, start: v.start, duration: v.duration, inPoint: v.inPoint, speed: 2 });
    expect(findClip(proj(), x.id)!.track.kind).toBe('audio');
    expect(proj().tracks.filter((t) => t.kind === 'audio').length).toBe(audioTracks + 1);
    expect((clip(B) as VideoClip).audio.muted).toBe(true);
    expect(x.audioLink).toBe((clip(B) as VideoClip).audioLink);

    const restored = st().toggleExtractAudio([B]);
    expect(restored.restored).toBe(1);
    expect(findClip(proj(), x.id)).toBeUndefined();
    expect((clip(B) as VideoClip).audio.muted).toBe(false);
    expect((clip(B) as VideoClip).audioLink).toBeUndefined();
    expect(proj().tracks.filter((t) => t.kind === 'audio').length).toBe(audioTracks);
  });
  it('is one undo step each way', () => {
    const { A } = setup();
    const n = st().past.length;
    const id = st().toggleExtractAudio([A]).extracted[0]!;
    expect(st().past.length).toBe(n + 1);
    st().undo();
    expect(findClip(proj(), id)).toBeUndefined();
    expect((clip(A) as VideoClip).audio.muted).toBe(false);
    st().redo();
    expect(findClip(proj(), id)).toBeDefined();
  });
  it('keeps both halves linked after a split, and restores all of them', () => {
    const { A } = setup();
    st().toggleExtractAudio([A]);
    st().setPlayhead(S(2));
    st().splitAllAtPlayhead();
    const link = (clip(A) as VideoClip).audioLink!;
    expect(audioLinked(proj(), link)).toHaveLength(4); // 2 video + 2 audio halves
    st().toggleExtractAudio([A]);
    expect(audioLinked(proj(), link)).toHaveLength(0);
    expect(mainTrack(proj()).clips.every((c) => c.type !== 'video' || !c.audio.muted)).toBe(true);
  });
  it('refuses silent videos and non-video clips', () => {
    const { M } = setup();
    const silent = video('s.mp4', 3, false);
    st().addAssets([silent]);
    const V = st().addClip(silent.id, { at: 0 })!;
    expect(st().toggleExtractAudio([V, M])).toEqual({ extracted: [], restored: 0 });
  });
  it('runCommand toasts the result', () => {
    const { A } = setup();
    runCommand('extractAudio');
    expect(toasts.at(-1)).toMatch(/select a video/i);
    st().select([A]);
    runCommand('extractAudio');
    expect(toasts.at(-1)).toBe('Audio extracted');
    runCommand('extractAudio');
    expect(toasts.at(-1)).toBe('Audio restored');
  });
});

describe('in / out area (I, O, ⇧X, ⌥X, Esc)', () => {
  it('I and O mark the playhead; an inverted end is dropped', () => {
    st().setPlayhead(S(2));
    runCommand('markIn');
    st().setPlayhead(S(5));
    runCommand('markOut');
    expect(ui().area).toEqual({ in: S(2), out: S(5) });
    st().setPlayhead(S(6));
    runCommand('markIn');
    expect(ui().area).toEqual({ in: S(6), out: null });
    st().setPlayhead(S(1));
    runCommand('markOut');
    expect(ui().area).toEqual({ in: null, out: S(1) });
  });
  it('⇧X spans the selected clips; ⌥X clears; Esc clears before deselecting', () => {
    const { A, O } = setup();
    st().select([A, O]);
    runCommand('areaFromClip');
    expect(ui().area).toEqual({ in: 0, out: S(6) });
    runCommand('clearArea');
    expect(ui().area).toEqual({ in: null, out: null });
    runCommand('areaFromClip');
    runCommand('escape');
    expect(ui().area.in).toBeNull();
    expect(st().selection.clipIds).toHaveLength(2);
    runCommand('escape');
    expect(st().selection.clipIds).toHaveLength(0);
  });
  it('⇧X without a selection only toasts', () => {
    runCommand('areaFromClip');
    expect(ui().area).toEqual({ in: null, out: null });
    expect(toasts).toHaveLength(1);
  });
});

describe('UI commands', () => {
  it('~ toggles linkage', () => {
    const was = ui().linkage;
    runCommand('toggleLinkage');
    expect(ui().linkage).toBe(!was);
    runCommand('toggleLinkage');
    expect(ui().linkage).toBe(was);
  });
  it('emits app events for export, import, full screen, fit preview and library tabs', () => {
    const seen: string[] = [];
    const offs = [
      onAppEvent('export', () => seen.push('export')),
      onAppEvent('import', () => seen.push('import')),
      onAppEvent('fullscreenPreview', () => seen.push('fs')),
      onAppEvent('fitPreview', () => seen.push('fit')),
      onAppEvent('libraryTab', ({ dir }) => seen.push(`tab${dir}`)),
    ];
    for (const c of ['export', 'importMedia', 'fullscreenPreview', 'fitPreview', 'libraryNext', 'libraryPrev'] as const) expect(runCommand(c)).toBe(true);
    expect(seen).toEqual(['export', 'import', 'fs', 'fit', 'tab1', 'tab-1']);
    offs.forEach((f) => f());
  });
  it('⌘R / ⇧B open Speed (Standard / Curve) for one timed clip, else toast', () => {
    const { A } = setup();
    const req: unknown[] = [];
    const off = onAppEvent('inspectorTab', (r) => req.push(r));
    runCommand('speedPanel');
    expect(req).toHaveLength(0);
    expect(toasts.at(-1)).toMatch(/speed/i);
    st().select([A]);
    runCommand('speedPanel');
    runCommand('curveSpeed');
    expect(req).toEqual([
      { tab: 'speed', sub: 'standard' },
      { tab: 'speed', sub: 'curve' },
    ]);
    off();
  });
  it('later features answer with a "Coming soon" toast and leave the project alone', () => {
    setup();
    const before = proj();
    for (const c of ['group', 'ungroup', 'compound', 'undoCompound', 'matchCut', 'splitCaption', 'keyframePanel'] as const) {
      expect(runCommand(c)).toBe(true);
    }
    expect(toasts).toEqual([
      'Coming soon: Group',
      'Coming soon: Ungroup',
      'Coming soon: Create compound clip',
      'Coming soon: Undo compound clip',
      'Coming soon: Match cut',
      'Coming soon: Split caption',
      'Keyframes — coming soon',
    ]);
    expect(proj()).toBe(before);
  });
  it('splitAll and selectLeft/Right run through runCommand', () => {
    const { A, O, M } = setup();
    st().setPlayhead(S(3));
    runCommand('selectLeft');
    expect(new Set(st().selection.clipIds)).toEqual(new Set([A, O, M]));
    const spy = vi.spyOn(st(), 'splitAllAtPlayhead');
    runCommand('splitAll');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
