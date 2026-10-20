import { beforeEach, describe, expect, it } from 'vitest';
import { reverseChannels } from '../audio/reverse';
import { getFrameState } from '../engine/frameState';
import { ReverseReader, type TimedFrame } from '../export/frameSource';
import { mixSourceMap, planMix } from '../export/offlineMix';
import { createAsset } from '../model/defaults';
import { findClip, mainTrack, migrateClip } from '../model/project';
import { REVERSE_EPS_US, mediaTimeAt, mirrorInPoint, secToUs, sourceSpan } from '../model/time';
import type { Clip, MediaAsset, Project, VideoClip } from '../model/types';
import { projectViolations } from '../store/invariants';
import { useEditor } from '../store';
import { cropToRect, presetRect, rectToCrop } from './CropDialog';
import { FREEZE_DURATION, insertFreeze, replaceClip, rotate90, sanitizeCrop, setCrop, toggleMirror, toggleReverse } from './editOps';

const S = secToUs;
const st = () => useEditor.getState();
const clip = (id: string) => findClip(st().project, id)!.clip;
const video = (name: string, sec: number): MediaAsset =>
  createAsset({ kind: 'video', name, mime: 'video/mp4', size: 1, duration: S(sec), width: 1920, height: 1080, hasAudio: true });
const image = (name = 'still.png') => createAsset({ kind: 'image', name, mime: 'image/png', size: 1, duration: 0, width: 1920, height: 1080 });
const healthy = () => expect(projectViolations(st().project, { magnet: st().magnet })).toEqual([]);
const ed = <T,>(r: (d: Project) => T): T => st().editProject(r);

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true });
});

function addVideo(sec = 10): string {
  const a = video(`v${sec}.mp4`, sec);
  st().addAssets([a]);
  return st().addClip(a.id, { at: 0 })!;
}

describe('reverse time mapping', () => {
  const D = S(10);
  it('mirrors the in-point (an involution)', () => {
    expect(mirrorInPoint(D, S(2), S(3))).toBe(S(5));
    expect(mirrorInPoint(D, mirrorInPoint(D, S(2), S(3)), S(3))).toBe(S(2));
  });
  it('a reversed clip shows decreasing media times, last frame first', () => {
    const c = { start: 0, inPoint: 0, duration: D, speed: 1, speedCurve: null, reversed: true };
    expect(mediaTimeAt(c, 0, D)).toBe(D - REVERSE_EPS_US);
    const fps = 30;
    let prev = Infinity;
    for (let f = 0; f < 300; f += 7) {
      const m = mediaTimeAt(c, Math.round((f * 1e6) / fps), D);
      expect(m).toBeLessThan(prev);
      // the source frame index shown = 299 - f (30 fps media)
      expect(Math.floor((m + 100) / (1e6 / fps))).toBe(299 - f);
      prev = m;
    }
  });
  it('a reversed sub-span reads the same media span backwards', () => {
    // forward clip reading media [2 s, 5 s)
    const fwd = { start: 0, inPoint: S(2), duration: S(3), speed: 1, speedCurve: null, reversed: false };
    const rev = { ...fwd, inPoint: mirrorInPoint(D, S(2), S(3)), reversed: true };
    expect(mediaTimeAt(fwd, 0, D)).toBe(S(2));
    expect(mediaTimeAt(rev, 0, D)).toBe(S(5) - REVERSE_EPS_US);
    expect(mediaTimeAt(rev, S(3) - 1, D)).toBeGreaterThanOrEqual(S(2) - REVERSE_EPS_US);
  });
  it('at 2x the reversed clip runs backwards twice as fast', () => {
    const c = { start: 0, inPoint: 0, duration: S(5), speed: 2, speedCurve: null, reversed: true };
    expect(mediaTimeAt(c, S(1), D) - mediaTimeAt(c, S(2), D)).toBe(S(2));
  });
  it('audio: reverseChannels mirrors around the media duration', () => {
    const ch = new Float32Array([1, 2, 3, 4]);
    expect(Array.from(reverseChannels([ch], 4, 1)[0]!)).toEqual([4, 3, 2, 1]);
    // media longer than the decoded audio: the missing tail is silence (at the start once reversed)
    expect(Array.from(reverseChannels([ch], 4, 1.5)[0]!)).toEqual([0, 0, 4, 3, 2, 1]);
  });
});

describe('toggleReverse (store)', () => {
  it('flips the flag, mirrors the in-point, is one undo step and keeps invariants', () => {
    const id = addVideo(10);
    st().trimStart(id, S(2)); // reads media [2, 10)
    const before = clip(id) as VideoClip;
    expect(before.inPoint).toBe(S(2));
    const n = st().past.length;
    ed((d) => toggleReverse(d, [id]));
    const c = clip(id) as VideoClip;
    expect(c.reversed).toBe(true);
    expect(c.inPoint).toBe(0); // reversed media [0, 8) = real [2, 10)
    expect(st().past.length).toBe(n + 1);
    healthy();
    // frame state: first frame of the clip is the media's last frame, speed negative
    const op = getFrameState(st().project, 0).ops.find((o) => o.kind === 'media')!;
    expect(op.kind === 'media' && op.sourceTime).toBe(S(10) - REVERSE_EPS_US);
    expect(op.kind === 'media' && op.speed).toBe(-1);
    st().undo();
    expect((clip(id) as VideoClip).reversed).toBe(false);
    expect((clip(id) as VideoClip).inPoint).toBe(S(2));
  });
  it('splitting a reversed clip keeps one continuous backwards read', () => {
    const id = addVideo(10);
    ed((d) => toggleReverse(d, [id]));
    const right = st().splitClip(id, S(4))!;
    const D = S(10);
    const a = clip(id) as VideoClip;
    const b = clip(right) as VideoClip;
    // the left part ends where the right part starts (in real media time)
    expect(Math.abs(mediaTimeAt(a, S(4) - 1, D) - mediaTimeAt(b, S(4), D))).toBeLessThan(5);
    expect(mediaTimeAt(b, S(10) - S(1) / 30, D)).toBeLessThan(S(1) / 30 + 1);
    healthy();
  });
  it('export mix plan: reversed clips carry the axis and the real span start', () => {
    const id = addVideo(10);
    st().trimEnd(id, S(6)); // real [0, 6)
    ed((d) => toggleReverse(d, [id]));
    const m = planMix(st().project)[0]!;
    expect(m.reversed).toBe(true);
    expect(m.mediaSec).toBe(10);
    expect(m.inSec).toBe(4); // reversed media [4, 10)
    expect(m.realInSec).toBe(0);
    // the mix reads the reversed buffer forward from inSec
    expect(mixSourceMap(m, 48000)(48000)).toBe(5);
  });
  it('a reversed video’s extracted audio is reversed with it', () => {
    const id = addVideo(10);
    const r = st().toggleExtractAudio([id]);
    ed((d) => toggleReverse(d, [id]));
    expect((clip(r.extracted[0]!) as Clip & { reversed: boolean }).reversed).toBe(true);
    healthy();
  });
  it('migration fills reversed=false on old clips and keeps up-to-date clips identical', () => {
    const id = addVideo(5);
    const c = clip(id);
    expect(migrateClip(c)).toBe(c);
    const old = { ...c } as Record<string, unknown>;
    delete old.reversed;
    expect((migrateClip(old as unknown as Clip) as VideoClip).reversed).toBe(false);
  });
});

describe('mirror / rotate / crop', () => {
  it('mirror toggles flipH, rotate steps 90° and wraps', () => {
    const id = addVideo(3);
    ed((d) => toggleMirror(d, [id]));
    expect((clip(id) as VideoClip).transform.flipH).toBe(true);
    for (let i = 0; i < 3; i++) ed((d) => rotate90(d, [id]));
    expect((clip(id) as VideoClip).transform.rotation).toBe(-90);
    ed((d) => rotate90(d, [id]));
    expect((clip(id) as VideoClip).transform.rotation).toBe(0);
    st().undo();
    expect((clip(id) as VideoClip).transform.rotation).toBe(-90);
  });
  it('crop is sanitized and set as one step', () => {
    const id = addVideo(3);
    ed((d) => setCrop(d, [id], { left: 0.25, top: 0, right: 0.25, bottom: 0 }));
    expect((clip(id) as VideoClip).crop).toEqual({ left: 0.25, top: 0, right: 0.25, bottom: 0 });
    expect(sanitizeCrop({ left: 0.9, top: -1, right: 0.9, bottom: 2 })).toEqual({ left: 0.9, top: 0, right: 0.08, bottom: 0.98 });
  });
  it('ratio presets: largest centred rect of the pixel ratio', () => {
    const r = presetRect(9 / 16, 1920, 1080);
    expect(r.h).toBe(1);
    expect(r.w * 1920 / (r.h * 1080)).toBeCloseTo(9 / 16, 6);
    expect(r.x).toBeCloseTo((1 - r.w) / 2, 9);
    expect(presetRect(16 / 9, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const c = rectToCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
    const back = cropToRect(c);
    expect(back.x).toBeCloseTo(0.1);
    expect(back.w).toBeCloseTo(0.5);
    expect(back.h).toBeCloseTo(0.6);
  });
});

describe('freeze', () => {
  it('splits at t and inserts a 3 s still that keeps the look; later clips ripple', () => {
    const id = addVideo(10);
    const a2 = video('b.mp4', 4);
    st().addAssets([a2]);
    st().addClip(a2.id, { at: S(10) });
    st().updateClip(id, { transform: { scale: 1.5 }, crop: { left: 0.1 } });
    const img = image();
    st().addAssets([img]);
    const n = st().past.length;
    const still = ed((d) => insertFreeze(d, id, S(4), img.id));
    expect(st().past.length).toBe(n + 1);
    const m = mainTrack(st().project).clips;
    expect(m.map((c) => c.type)).toEqual(['video', 'image', 'video', 'video']);
    expect(m[1]!.id).toBe(still);
    expect(m[1]!.start).toBe(S(4));
    expect(m[1]!.duration).toBe(FREEZE_DURATION);
    expect(m[2]!.start).toBe(S(7));
    expect(m[3]!.start).toBe(S(13));
    expect((m[1] as Clip & { transform: { scale: number } }).transform.scale).toBe(1.5);
    expect((m[1] as Clip & { crop: { left: number } }).crop.left).toBe(0.1);
    healthy();
    st().undo();
    expect(mainTrack(st().project).clips).toHaveLength(2);
  });
  it('at the clip start the still goes before the clip without a split', () => {
    const id = addVideo(5);
    const img = image();
    st().addAssets([img]);
    ed((d) => insertFreeze(d, id, 0, img.id));
    const m = mainTrack(st().project).clips;
    expect(m.map((c) => c.type)).toEqual(['image', 'video']);
    expect(m[1]!.duration).toBe(S(5));
    healthy();
  });
});

describe('replace clip', () => {
  it('video → video keeps timing and attributes', () => {
    const id = addVideo(10);
    st().trimStart(id, S(3));
    st().updateClip(id, { transform: { rotation: 45 } });
    const b = video('long.mp4', 20);
    st().addAssets([b]);
    expect(ed((d) => replaceClip(d, id, b.id)).ok).toBe(true);
    const c = clip(id) as VideoClip;
    expect(c.assetId).toBe(b.id);
    expect(c.inPoint).toBe(S(3));
    expect(c.duration).toBe(S(7));
    expect(c.transform.rotation).toBe(45);
    healthy();
  });
  it('refuses media shorter than the clip and moves the in-point back when needed', () => {
    const id = addVideo(10);
    st().trimStart(id, S(6)); // span 4 s at in 6
    const short = video('short.mp4', 3);
    const mid = video('mid.mp4', 5);
    st().addAssets([short, mid]);
    expect(ed((d) => replaceClip(d, id, short.id)).ok).toBe(false);
    expect((clip(id) as VideoClip).assetId).not.toBe(short.id);
    ed((d) => replaceClip(d, id, mid.id));
    expect((clip(id) as VideoClip).inPoint).toBe(S(1));
    expect(sourceSpan(clip(id) as VideoClip)).toBe(S(4));
    healthy();
  });
  it('video → image changes the clip type, keeping id, place and look', () => {
    const id = addVideo(4);
    st().updateClip(id, { transform: { flipH: true } });
    const img = image();
    st().addAssets([img]);
    ed((d) => replaceClip(d, id, img.id));
    const c = clip(id);
    expect(c.type).toBe('image');
    expect(c.duration).toBe(S(4));
    expect((c as Clip & { transform: { flipH: boolean } }).transform.flipH).toBe(true);
    healthy();
  });
});

describe('ReverseReader (export)', () => {
  // a 30 fps stream of 90 frames; `open(start)` yields from the frame covering start
  const step = 1 / 30;
  let opens = 0;
  const open = async function* (start: number): AsyncGenerator<TimedFrame, void, unknown> {
    opens++;
    const first = Math.max(0, Math.floor(start / step + 1e-9));
    for (let i = first; i < 90; i++) yield { canvas: { width: i, height: 1 } as unknown as TimedFrame['canvas'], timestamp: i * step };
  };
  it('serves decreasing times frame-exact with bounded decodes', async () => {
    opens = 0;
    const r = new ReverseReader(open, 10, 1000);
    for (let i = 89; i >= 0; i--) {
      const f = await r.frameAt(i * step + 1e-4);
      expect(f?.canvas.width).toBe(i);
    }
    // ~one decode per 10 frames (plus the first window)
    expect(opens).toBeLessThanOrEqual(11);
  });
});
