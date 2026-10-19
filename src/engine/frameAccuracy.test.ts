// @vitest-environment jsdom
/**
 * Render audit (docs/AUDIT-render.md): the pure decisions behind "the preview shows the frame
 * the document says". Each block is the unit-level regression test of a bug the browser audit
 * (e2e/audit-render.spec.ts) found.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SequentialReader, type TimedFrame } from '../export/frameSource';
import { registerAssetUrl, revokeAllAssetUrls } from '../media/registry';
import { createAsset, createClipFromAsset, createProject } from '../model/defaults';
import { frameToUs, sourceTimeAt } from '../model/time';
import type { VideoClip } from '../model/types';
import { MediaPool } from '../player/mediaPool';
import { CATCH_UP_SEC, decideSync, MAX_NUDGE, nudgedRate, type ElementState } from '../player/sync';
import { FRAME_LOOKUP_EPS_US, frameLookupSec, getFrameState, type MediaDrawOp } from './frameState';

const SRC_FPS = 30;

/** Exact source frame index for timeline frame n (rational arithmetic, no µs rounding). */
const exactSourceFrame = (inFrames: number, n: number, projectFps: number, speed: number) =>
  Math.floor(inFrames + (n * speed * SRC_FPS) / projectFps + 1e-9);

describe('frame lookup (bug: speed 2× / 10× showed the previous source frame)', () => {
  const speeds = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4, 10, 16, 33, 100];
  for (const projectFps of [24, 25, 30, 60]) {
    it(`every timeline frame at ${projectFps} fps maps to the exact source frame, speeds ${speeds.join('/')}`, () => {
      const bad: string[] = [];
      for (const speed of speeds) {
        for (const inFrames of [0, 37]) {
          const clip = { start: frameToUs(11, projectFps), inPoint: frameToUs(inFrames, SRC_FPS), speed };
          for (let n = 0; n < 400; n++) {
            const t = frameToUs(11 + n, projectFps);
            const got = Math.floor(frameLookupSec(sourceTimeAt(clip, t)) * SRC_FPS);
            const want = exactSourceFrame(inFrames, n, projectFps, speed);
            if (got !== want) bad.push(`fps ${projectFps} speed ${speed} in ${inFrames} n ${n}: ${got} ≠ ${want}`);
          }
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }

  it('without the epsilon the 2× case is one frame early (documents the root cause)', () => {
    const t = frameToUs(1, 30); // 33 333 µs
    const st = sourceTimeAt({ start: 0, inPoint: 0, speed: 2 }, t); // 66 666 µs
    expect(Math.floor((st / 1e6) * 30)).toBe(1); // exact lookup: frame 1 (wrong)
    expect(Math.floor(frameLookupSec(st) * 30)).toBe(2); // with the epsilon: frame 2
  });

  it('the epsilon stays far below half a frame at 240 fps', () => {
    expect(FRAME_LOOKUP_EPS_US).toBeLessThan(1e6 / 240 / 2);
  });

  it('the export reader picks the same frame as the preview lookup', async () => {
    const frames: TimedFrame[] = Array.from({ length: 400 }, (_, i) => ({ canvas: { width: 1, height: 1 } as never, timestamp: i / SRC_FPS }));
    const open = async function* (start: number) {
      for (const f of frames) if (f.timestamp >= start - 1 / SRC_FPS) yield f;
    };
    const r = new SequentialReader(open);
    for (let n = 0; n < 36; n++) {
      const st = sourceTimeAt({ start: 0, inPoint: 0, speed: 10 }, frameToUs(n, 30));
      const f = await r.frameAt(frameLookupSec(st));
      expect(Math.round(f!.timestamp * SRC_FPS)).toBe(10 * n);
    }
  });

  it('getFrameState sourceTime + lookup across a split piece with an in-point', () => {
    const p = createProject();
    const a = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: 12e6, width: 270, height: 480, hasAudio: true });
    p.assets[a.id] = a;
    const main = p.tracks.find((t) => t.kind === 'main')!;
    const c = createClipFromAsset(a, main.id, 4e6) as VideoClip;
    c.inPoint = 5e6;
    c.speed = 2;
    c.duration = 3e6;
    main.clips = [c];
    for (const n of [0, 1, 7, 44]) {
      const op = getFrameState(p, 4e6 + frameToUs(n, 30)).ops[0] as MediaDrawOp;
      expect(Math.floor(frameLookupSec(op.sourceTime) * 30)).toBe(150 + 2 * n);
    }
  });
});

describe('playback drift correction (bug: picture ~1.5 frames behind the audio clock)', () => {
  const el = (p: Partial<ElementState> = {}): ElementState => ({ currentTime: 5, paused: false, seeking: false, playbackRate: 1, sinceSeekMs: Infinity, ...p });
  const want = { target: 5, running: true, speed: 1, tolerance: 1 / 60, nudge: true };

  it('a lagging video is sped up a little, a leading one slowed down; never by more than MAX_NUDGE', () => {
    expect(decideSync(el({ currentTime: 4.97 }), want).rate).toBeCloseTo(1 + 0.03 / CATCH_UP_SEC, 6);
    expect(decideSync(el({ currentTime: 5.02 }), want).rate).toBeCloseTo(1 - 0.02 / CATCH_UP_SEC, 6);
    expect(decideSync(el({ currentTime: 4.9 }), want).rate).toBeCloseTo(1 + MAX_NUDGE, 6);
    expect(decideSync(el({ currentTime: 4.95 }), want).seek).toBeNull(); // no seek (no stutter)
    expect(nudgedRate(2, 10)).toBeCloseTo(2 * (1 + MAX_NUDGE), 6);
  });

  it('inside the dead band the rate returns to the clip speed; a running nudge finishes first', () => {
    expect(decideSync(el({ currentTime: 5.002, playbackRate: 1.05 }), want).rate).toBe(1);
    // drift 0.012 s (between a quarter and half a frame), still lagging, nudge on → keep it
    expect(decideSync(el({ currentTime: 4.988, playbackRate: 1.05 }), want).rate).toBeNull();
    expect(decideSync(el({ currentTime: 5.004 }), want).rate).toBeNull();
  });

  it('audible elements (no nudge) keep the exact speed', () => {
    expect(decideSync(el({ currentTime: 4.95 }), { ...want, nudge: false }).rate).toBeNull();
  });

  it('beyond driftLimit it still seeks', () => {
    expect(decideSync(el({ currentTime: 4.5 }), want).seek).toBe(5);
  });
});

describe('media pool (bugs: wrong frame after a cut, wrong frame after pause)', () => {
  let n = 0;
  beforeAll(() => {
    URL.createObjectURL = () => `blob:fa/${n++}`;
    URL.revokeObjectURL = () => undefined;
    HTMLMediaElement.prototype.load = vi.fn();
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  });
  afterEach(() => revokeAllAssetUrls());

  function setup() {
    const p = createProject();
    const a = createAsset({ kind: 'video', name: 'b.mp4', mime: 'video/mp4', size: 1, duration: 12e6, width: 270, height: 480, hasAudio: true });
    p.assets[a.id] = a;
    registerAssetUrl(a.id, new Blob(['x']));
    const main = p.tracks.find((t) => t.kind === 'main')!;
    const c = createClipFromAsset(a, main.id, 4e6) as VideoClip;
    c.inPoint = 2e6;
    c.duration = 4e6;
    main.clips = [c];
    const pool = new MediaPool(() => undefined);
    pool.setProject(p);
    const op = (sourceTime: number) =>
      ({ kind: 'media', mediaType: 'video', clipId: c.id, assetId: a.id, sourceTime, fitWidth: 1, fitHeight: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } }) as unknown as MediaDrawOp;
    const video = () => document.querySelector('video') as HTMLVideoElement;
    return { pool, op, video };
  }

  const fakeReady = (v: HTMLVideoElement, currentTime: number) => {
    Object.defineProperty(v, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(v, 'seeking', { configurable: true, get: () => false });
    Object.defineProperty(v, 'duration', { configurable: true, get: () => 12 });
    let ct = currentTime;
    Object.defineProperty(v, 'currentTime', { configurable: true, get: () => ct, set: (x: number) => (ct = x) });
  };

  it('preload parks an upcoming clip on its FIRST frame, not on the look-ahead frame', () => {
    const { pool, op, video } = setup();
    // look-ahead op computed at t + 0.8 s = 4.5 s → source 2.5 s; the clip enters at 4 s with source 2 s
    pool.preload([op(2.5e6)], 3.7e6);
    const v = video();
    fakeReady(v, 0);
    v.dispatchEvent(new Event('loadedmetadata'));
    pool.preload([op(2.5e6)], 3.7e6); // already created: no-op
    // the pending seek from creation is applied on loadedmetadata
    expect(v.currentTime).toBeCloseTo(frameLookupSec(2e6), 6);
    pool.dispose();
  });

  it('paused: an element half a frame off the target (other side of a frame boundary) is re-seeked', () => {
    const { pool, op, video } = setup();
    pool.sync([op(2.4995e6)], 4.5e6, false, 30);
    const v = video();
    fakeReady(v, 2.51); // 10.5 ms away: inside the old half-frame tolerance, but frame 75 ≠ 74
    pool.sync([op(2.4995e6)], 4.5e6, false, 30);
    expect(v.currentTime).toBeCloseTo(frameLookupSec(2.4995e6), 6);
    pool.dispose();
  });
});
