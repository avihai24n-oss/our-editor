import { beforeEach, describe, expect, it } from 'vitest';
import { getFrameState } from '../engine/frameState';
import { useEditor } from '../store';
import { rotate90 } from '../actions/editOps';
import { createAsset, defaultTransform } from './defaults';
import {
  clearKeysPatch,
  contentAt,
  easeAt,
  easeValue,
  keyedTransformPatch,
  kenBurnsKeys,
  keysValueAt,
  motionKeyTimes,
  motionTransformAt,
  timeAtContent,
  toggleKeysPatch,
  withEaseAt,
  withKeysMoved,
  withMotionKeyAt,
  withoutMotionKeyPatch,
  type MotionClip,
} from './motionKeys';
import { findClip } from './project';
import { secToUs } from './time';
import type { MotionKeys, VisualClip } from './types';

const S = secToUs;
const TOL = 1e6 / 60;
// 4 s video at 2 s on the timeline, reading its source from 10 s
const video = (motionKeys?: MotionKeys, speed = 1): MotionClip => ({ type: 'video', start: S(2), duration: S(4), inPoint: S(10), speed, speedCurve: null, transform: defaultTransform(), motionKeys });
const image = (motionKeys?: MotionKeys): MotionClip => ({ type: 'image', start: S(2), duration: S(4), transform: defaultTransform(), motionKeys });

describe('easing', () => {
  it('linear, ease in / out / in-out hit 0 and 1 and bend the right way', () => {
    for (const e of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      expect(easeValue(e, 0)).toBeCloseTo(0, 5);
      expect(easeValue(e, 1)).toBeCloseTo(1, 5);
    }
    expect(easeValue('linear', 0.25)).toBe(0.25);
    expect(easeValue('ease-in', 0.25)).toBeLessThan(0.25);
    expect(easeValue('ease-out', 0.25)).toBeGreaterThan(0.25);
    expect(easeValue('ease-in-out', 0.5)).toBeCloseTo(0.5, 4);
    expect(easeValue('ease-in-out', 0.2)).toBeLessThan(0.2);
    expect(easeValue('ease-in-out', 0.8)).toBeGreaterThan(0.8);
    // monotonic
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.05) {
      const y = easeValue('ease-in-out', x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});

describe('interpolation', () => {
  const keys = { position: [{ src: S(11), v: [0, 0] }, { src: S(13), v: [200, -100] }], rotation: [{ src: S(11), v: [0] }, { src: S(13), v: [360] }] };
  it('holds before / after, lerps between (position, rotation without wrap)', () => {
    const c = video(keys);
    expect(motionTransformAt(c, S(2)).x).toBe(0);
    const mid = motionTransformAt(c, S(4)); // src 12
    expect(mid.x).toBeCloseTo(100);
    expect(mid.y).toBeCloseTo(-50);
    expect(mid.rotation).toBeCloseTo(180); // 0 → 360 is a turn, not a jump
    expect(motionTransformAt(c, S(5.9)).x).toBe(200);
  });
  it('the ease of the first key bends its segment', () => {
    const v = keysValueAt([{ src: 0, v: [0], ease: 'ease-in' }, { src: 100, v: [100] }], 25);
    expect(v[0]!).toBeLessThan(25);
  });
  it('no keys: the transform object itself', () => {
    const c = video();
    expect(motionTransformAt(c, S(3))).toBe(c.transform);
  });
  it('unkeyed properties come from transform', () => {
    const c = video({ opacity: [{ src: S(11), v: [0.5] }] });
    c.transform.scale = 2;
    const t = motionTransformAt(c, S(3));
    expect(t.opacity).toBe(0.5);
    expect(t.scale).toBe(2);
  });
});

describe('content time', () => {
  it('video keys sit on the source: speed 2 moves them on the timeline', () => {
    const c = video({ scale: [{ src: S(12), v: [1, 1, 1] }] }, 2);
    expect(contentAt(c, S(3))).toBe(S(12));
    expect(timeAtContent(c, S(12))).toBe(S(3));
    expect(motionKeyTimes(c)).toEqual([S(3)]);
  });
  it('image keys count from the left edge', () => {
    const c = image({ scale: [{ src: S(1), v: [1, 1, 1] }] });
    expect(motionKeyTimes(c)).toEqual([S(3)]);
  });
});

describe('edits', () => {
  it('add / replace / remove a key; the last one leaves its value on transform', () => {
    let mk = withMotionKeyAt(video(), 'position', S(3), [10, 20], TOL);
    expect(mk.position).toEqual([{ src: S(11), v: [10, 20] }]);
    mk = withMotionKeyAt(video(mk), 'position', S(3) + 1000, [30, 40], TOL);
    expect(mk.position).toEqual([{ src: S(11), v: [30, 40] }]);
    const p = withoutMotionKeyPatch(video(mk), ['position'], S(3), TOL);
    expect(p.motionKeys).toBeNull();
    expect(p.transform).toEqual({ x: 30, y: 40 });
  });

  it('keyedTransformPatch: plain without keys, key at the playhead, shift off the clip', () => {
    expect(keyedTransformPatch(video(), { x: 5 }, S(3), TOL)).toEqual({ transform: { x: 5 } });
    const c = video({ position: [{ src: S(11), v: [0, 0] }] });
    const inside = keyedTransformPatch(c, { x: 50, rotation: 10 }, S(5), TOL);
    expect(inside.motionKeys!.position).toEqual([
      { src: S(11), v: [0, 0] },
      { src: S(13), v: [50, 0] },
    ]);
    expect(inside.transform).toEqual({ rotation: 10 }); // rotation has no keys
    const two = video(inside.motionKeys!);
    const off = keyedTransformPatch(two, { y: 30 }, S(9), TOL); // after the clip: every key moves
    expect(off.motionKeys!.position!.map((k) => k.v)).toEqual([
      [0, 30],
      [50, 30],
    ]);
  });

  it('scale keys clamp, opacity keys clamp', () => {
    const c = video({ scale: [{ src: S(11), v: [1, 1, 1] }], opacity: [{ src: S(11), v: [1] }] });
    const p = keyedTransformPatch(c, { scale: 9, opacity: 3 }, S(3), TOL);
    expect(p.motionKeys!.scale![0]!.v[0]).toBe(4);
    expect(p.motionKeys!.opacity![0]!.v[0]).toBe(1);
  });

  it('toggle a group: adds all with current values, then removes them', () => {
    const c = video();
    c.transform.x = 7;
    const add = toggleKeysPatch(c, ['position', 'scale', 'rotation'], S(3), TOL)!;
    expect(Object.keys(add.motionKeys!).sort()).toEqual(['position', 'rotation', 'scale']);
    expect(add.motionKeys!.position![0]!.v).toEqual([7, 0]);
    const rm = toggleKeysPatch(video(add.motionKeys!), ['position', 'scale', 'rotation'], S(3), TOL)!;
    expect(rm.motionKeys).toBeNull();
    expect(toggleKeysPatch(c, ['position'], S(9), TOL)).toBeNull(); // off the clip
  });

  it('ease at the playhead: read and set', () => {
    const c = video({ position: [{ src: S(11), v: [0, 0] }], opacity: [{ src: S(11), v: [1] }] });
    expect(easeAt(c, S(3), TOL)).toBe('linear');
    const mk = withEaseAt(c, S(3), TOL, 'ease-in-out')!;
    expect(mk.position![0]!.ease).toBe('ease-in-out');
    expect(mk.opacity![0]!.ease).toBe('ease-in-out');
    expect(withEaseAt(c, S(5), TOL, 'ease-in')).toBeNull();
    expect(withEaseAt(video(mk), S(3), TOL, 'linear')!.position![0]!.ease).toBeUndefined();
  });

  it('moving keys in time', () => {
    const c = video({ position: [{ src: S(11), v: [0, 0] }, { src: S(13), v: [9, 9] }] });
    const mk = withKeysMoved(c, S(3), S(4), TOL);
    expect(mk.position!.map((k) => k.src)).toEqual([S(12), S(13)]);
    const onto = withKeysMoved(c, S(3), S(5), TOL); // onto the other key: replaces it
    expect(onto.position).toEqual([{ src: S(13), v: [0, 0] }]);
  });

  it('clearKeysPatch removes only the given props', () => {
    const c = video({ position: [{ src: 0, v: [0, 0] }], opacity: [{ src: 0, v: [1] }] });
    expect(clearKeysPatch(c, ['position', 'scale', 'rotation']).motionKeys).toEqual({ opacity: [{ src: 0, v: [1] }] });
    expect(clearKeysPatch(c, ['position', 'opacity']).motionKeys).toBeNull();
  });

  it('Ken Burns: scale + position keys at the first and last frame', () => {
    const c = image();
    const mk = kenBurnsKeys(c, 'in', 1e6 / 30, { pan: { x: 40, y: 0 } });
    expect(mk.scale!.map((k) => k.v[0])).toEqual([1, 1.15]);
    expect(mk.position!.map((k) => k.v)).toEqual([
      [0, 0],
      [40, 0],
    ]);
    const c2 = { ...c, motionKeys: mk };
    expect(motionTransformAt(c2, S(4)).scale).toBeCloseTo(1.075, 2);
  });
});

// ---------------------------------------------------------------- store: keys stay on their content

const st = () => useEditor.getState();
const clipOf = (id: string) => findClip(st().project, id)!.clip as VisualClip;

describe('store: keys follow the content', () => {
  beforeEach(() => {
    st().newProject();
    useEditor.setState({ magnet: false, snapping: false });
  });

  function addVideo() {
    const a = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(10), width: 1920, height: 1080, hasAudio: false });
    st().addAssets([a]);
    return st().addClip(a.id, { at: 0 })!;
  }
  function addImage() {
    const a = createAsset({ kind: 'image', name: 'i.png', mime: 'image/png', size: 1, duration: 0, width: 1920, height: 1080 });
    st().addAssets([a]);
    const id = st().addClip(a.id, { at: 0, kind: 'overlay' })!;
    st().setDuration(id, S(6));
    return id;
  }
  const scaleKeys = (a: number, b: number): MotionKeys => ({ scale: [{ src: S(a), v: [1, 1, 1] }, { src: S(b), v: [2, 2, 2] }] });

  it('updateClip sets and clears motionKeys (undoable)', () => {
    const id = addVideo();
    st().updateClip(id, { motionKeys: scaleKeys(1, 3) });
    expect(clipOf(id).motionKeys?.scale).toHaveLength(2);
    st().updateClip(id, { motionKeys: null });
    expect(clipOf(id).motionKeys).toBeUndefined();
    st().undo();
    expect(clipOf(id).motionKeys?.scale).toHaveLength(2);
  });

  it('video: trim start, split and speed keep the keys on their source frames', () => {
    const id = addVideo();
    st().updateClip(id, { motionKeys: scaleKeys(2, 4) });
    const at = (cid: string, t: number) => motionTransformAt(clipOf(cid), t).scale;
    expect(at(id, S(3))).toBeCloseTo(1.5);
    st().trimStart(id, S(1)); // source 1 s now at timeline 1 s (no magnet)
    expect(at(id, S(3))).toBeCloseTo(1.5);
    const b = st().splitClip(id, S(3))!;
    expect(at(id, S(2.5))).toBeCloseTo(1.25);
    expect(at(b, S(3.5))).toBeCloseTo(1.75);
    st().setSpeed(b, 2); // b reads source 3 s.. at double speed from timeline 3 s
    expect(at(b, S(3.5))).toBeCloseTo(2); // source 4 s
  });

  it('image: trim start and split keep keys where they were on screen', () => {
    const id = addImage();
    st().updateClip(id, { motionKeys: scaleKeys(2, 4) });
    const at = (cid: string, t: number) => motionTransformAt(clipOf(cid), t).scale;
    expect(at(id, S(3))).toBeCloseTo(1.5);
    st().trimStart(id, S(1));
    expect(clipOf(id).start).toBe(S(1));
    expect(at(id, S(3))).toBeCloseTo(1.5);
    const b = st().splitClip(id, S(3))!;
    expect(at(id, S(2.5))).toBeCloseTo(1.25);
    expect(at(b, S(3.5))).toBeCloseTo(1.75);
    expect(at(b, S(3))).toBeCloseTo(1.5);
  });

  it('frame state (preview + export) draws the interpolated transform', () => {
    const id = addVideo();
    st().updateClip(id, { motionKeys: { position: [{ src: S(1), v: [0, 0] }, { src: S(3), v: [100, 0] }], opacity: [{ src: S(1), v: [1] }, { src: S(3), v: [0] }] } });
    const op = getFrameState(st().project, S(2)).ops.find((o) => 'clipId' in o && o.clipId === id) as { transform: { x: number; opacity: number } };
    expect(op.transform.x).toBeCloseTo(50);
    expect(op.transform.opacity).toBeCloseTo(0.5);
  });

  it('Edit › Rotate turns every rotation key', () => {
    const id = addVideo();
    st().updateClip(id, { motionKeys: { rotation: [{ src: 0, v: [0] }, { src: S(2), v: [45] }] } });
    st().editProject((d) => rotate90(d, [id]));
    expect(clipOf(id).motionKeys!.rotation!.map((k) => k.v[0])).toEqual([90, 135]);
  });

  it('locked track: no edit', () => {
    const id = addVideo();
    st().setTrack(findClip(st().project, id)!.track.id, { locked: true });
    st().updateClip(id, { motionKeys: scaleKeys(1, 2) });
    expect(clipOf(id).motionKeys).toBeUndefined();
  });
});
