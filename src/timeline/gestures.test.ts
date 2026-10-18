import { describe, expect, it } from 'vitest';
import { createAsset, createClipFromAsset, createProject, createTextClip, createTrack } from '../model/defaults';
import { mainTrack } from '../model/project';
import { secToUs } from '../model/time';
import type { Clip, Project, Track } from '../model/types';
import { assetDropOptions, bandTrackKind, moveInsertCut, resolveMoveTarget, snapMove, snapPoint, textDropTrack } from './gestures';

const S = secToUs;
const vid = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(60), width: 1920, height: 1080, hasAudio: true });
const aud = createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: S(60), hasAudio: true });

function setup(): { p: Project; main: Track; overlay: Track; audio: Track; text: Track; clips: Clip[] } {
  const p = createProject();
  p.assets[vid.id] = vid;
  p.assets[aud.id] = aud;
  const main = mainTrack(p);
  const add = (t: Track, c: Clip, start: number, dur: number) => {
    c.trackId = t.id;
    c.start = S(start);
    c.duration = S(dur);
    t.clips.push(c);
    return c;
  };
  const a = add(main, createClipFromAsset(vid, main.id, 0), 0, 4);
  const b = add(main, createClipFromAsset(vid, main.id, 0), 4, 4);
  const overlay = createTrack('overlay');
  const audio = createTrack('audio');
  const text = createTrack('text');
  p.tracks.push(overlay, audio, text);
  const o = add(overlay, createClipFromAsset(vid, overlay.id, 0), 10, 2);
  const x = add(audio, createClipFromAsset(aud, audio.id, 0), 0, 6);
  const t = add(text, createTextClip(text.id, 0), 2, 3);
  return { p, main, overlay, audio, text, clips: [a, b, o, x, t] };
}

describe('bandTrackKind', () => {
  it('top band takes visual clips, bottom band takes audio', () => {
    expect(bandTrackKind('video', 'top')).toBe('overlay');
    expect(bandTrackKind('image', 'top')).toBe('overlay');
    expect(bandTrackKind('text', 'top')).toBe('text');
    expect(bandTrackKind('audio', 'top')).toBeNull();
    expect(bandTrackKind('audio', 'bottom')).toBe('audio');
    expect(bandTrackKind('video', 'bottom')).toBeNull();
  });
});

describe('resolveMoveTarget', () => {
  it('moves between compatible tracks only', () => {
    const { p, main, overlay, audio, text, clips } = setup();
    const [a, , o, x, t] = clips as [Clip, Clip, Clip, Clip, Clip];
    expect(resolveMoveTarget(p, a, main, { type: 'track', trackId: overlay.id })).toEqual({ trackId: overlay.id });
    expect(resolveMoveTarget(p, o, overlay, { type: 'track', trackId: main.id })).toEqual({ trackId: main.id });
    // incompatible → stays on its own track
    expect(resolveMoveTarget(p, a, main, { type: 'track', trackId: audio.id })).toEqual({ trackId: main.id });
    expect(resolveMoveTarget(p, t, text, { type: 'track', trackId: main.id })).toEqual({ trackId: text.id });
    expect(resolveMoveTarget(p, x, audio, null)).toEqual({ trackId: audio.id });
  });
  it('bands create new tracks', () => {
    const { p, main, audio, clips } = setup();
    const [a, , , x] = clips as [Clip, Clip, Clip, Clip];
    expect(resolveMoveTarget(p, a, main, { type: 'band', band: 'top' })).toEqual({ newKind: 'overlay' });
    expect(resolveMoveTarget(p, x, audio, { type: 'band', band: 'bottom' })).toEqual({ newKind: 'audio' });
    expect(resolveMoveTarget(p, a, main, { type: 'band', band: 'bottom' })).toEqual({ trackId: main.id });
  });
  it('locked tracks refuse', () => {
    const { p, main, overlay, clips } = setup();
    overlay.locked = true;
    expect(resolveMoveTarget(p, clips[0]!, main, { type: 'track', trackId: overlay.id })).toEqual({ trackId: main.id });
  });
});

describe('snapping', () => {
  it('snaps a moving range to a neighbouring edge within 8px', () => {
    const { p, clips } = setup();
    const o = clips[2]!; // overlay at 10..12
    // 60 px/s → 8 px ≈ 0.133 s. Move so that its start lands at 8.1 s → snaps to main end (8 s)
    const r = snapMove(p, S(30), o.id, S(8.1), o.duration, 60, true);
    expect(r.value).toBe(S(8));
    expect(r.guide).toBe(S(8));
    expect(snapMove(p, S(30), o.id, S(8.1), o.duration, 60, false)).toEqual({ value: S(8.1), guide: null });
    // far from anything → no snap
    expect(snapMove(p, S(30), o.id, S(20.5), o.duration, 60, true).guide).toBeNull();
  });
  it('snaps a point to the playhead and markers', () => {
    const { p } = setup();
    p.markers.push({ id: 'm', time: S(15), color: '#fff' });
    expect(snapPoint(p, S(20), S(20.05), 60, true).value).toBe(S(20));
    expect(snapPoint(p, S(20), S(15.1), 60, true).value).toBe(S(15));
    expect(snapPoint(p, S(20), S(-1), 60, true).value).toBe(0);
  });
});

describe('moveInsertCut', () => {
  it('only on the magnetic main track', () => {
    const { p, main, overlay, clips } = setup();
    const a = clips[0]!;
    expect(moveInsertCut(p, { trackId: main.id }, a, S(5), true)).toBe(S(4));
    expect(moveInsertCut(p, { trackId: main.id }, a, S(5), false)).toBeNull();
    expect(moveInsertCut(p, { trackId: overlay.id }, a, S(5), true)).toBeNull();
    expect(moveInsertCut(p, { newKind: 'overlay' }, a, S(5), true)).toBeNull();
  });
});

describe('drop targets', () => {
  it('asset drops pick a compatible track or fall back to defaults', () => {
    const { p, main, overlay, audio } = setup();
    expect(assetDropOptions(p, 'video', { type: 'track', trackId: overlay.id }, S(1))).toEqual({ at: S(1), trackId: overlay.id });
    expect(assetDropOptions(p, 'video', { type: 'track', trackId: main.id }, S(1))).toEqual({ at: S(1), trackId: main.id });
    expect(assetDropOptions(p, 'video', { type: 'track', trackId: audio.id }, S(1))).toEqual({ at: S(1) });
    expect(assetDropOptions(p, 'audio', { type: 'track', trackId: main.id }, S(1))).toEqual({ at: S(1) });
    expect(assetDropOptions(p, 'image', { type: 'band', band: 'top' }, S(2))).toEqual({ at: S(2), kind: 'overlay' });
    expect(assetDropOptions(p, 'video', null, 0)).toEqual({ at: 0 });
  });
  it('text drops use a text row when hovered', () => {
    const { p, main, text } = setup();
    expect(textDropTrack(p, { type: 'track', trackId: text.id })).toBe(text.id);
    expect(textDropTrack(p, { type: 'track', trackId: main.id })).toBeUndefined();
    expect(textDropTrack(p, null)).toBeUndefined();
  });
});
