/** In / Out range export: the span, the mix window and per-clip scheduling maths (offlineMix.ts). */
import { describe, expect, it } from 'vitest';
import { secToUs } from '../model/time';
import { mixWindow, scheduleClip, type MixClip } from './offlineMix';
import { exportSpan } from './runExport';

const S = secToUs;
const SR = 48_000;

const clip = (o: Partial<MixClip> = {}): MixClip => ({
  clipId: 'c',
  assetId: 'a',
  startSec: 2,
  durationSec: 6,
  inSec: 1,
  speed: 1,
  speedCurve: null,
  durationUs: S(6),
  inPointUs: S(1),
  preservePitch: true,
  volume: 1,
  fadeInSec: 0,
  fadeOutSec: 0,
  reversed: false,
  mediaSec: 20,
  realInSec: 1,
  fx: { normalize: false, reduceNoise: false, fillChannel: null, voiceFilter: null },
  ...o,
});

describe('exportSpan', () => {
  it('whole timeline without a range', () => {
    expect(exportSpan(S(10))).toEqual({ from: 0, durationUs: S(10) });
  });
  it('the range, clamped to the timeline', () => {
    expect(exportSpan(S(10), { from: S(2), to: S(5) })).toEqual({ from: S(2), durationUs: S(3) });
    expect(exportSpan(S(10), { from: S(8), to: S(20) })).toEqual({ from: S(8), durationUs: S(2) });
    expect(exportSpan(S(10), { from: S(12), to: S(20) }).durationUs).toBe(0);
  });
});

describe('mixWindow', () => {
  it('sample-aligned, 1 s pre-roll before the In point', () => {
    const w = mixWindow(S(12.5), S(3), SR);
    expect(w.prerollFrames).toBe(SR);
    expect(w.baseSec).toBe(11.5);
    expect(w.frames).toBe(3 * SR);
    expect(w.toSec).toBeCloseTo(15.5, 9);
  });
  it('the pre-roll never reaches before 0', () => {
    const w = mixWindow(S(0.25), S(1), SR);
    expect(w.prerollFrames).toBe(0.25 * SR);
    expect(w.baseSec).toBe(0);
  });
  it('In at a frame boundary of 30 / 25 / 24 fps lands on a whole sample', () => {
    for (const fps of [24, 25, 30]) {
      const inUs = Math.round((37 * 1e6) / fps);
      const w = mixWindow(inUs, S(1), SR);
      expect((w.baseSec + w.prerollFrames / SR) * fps).toBeCloseTo(37, 6);
    }
  });
});

describe('scheduleClip', () => {
  it('no window: the full-mix schedule (unchanged behaviour)', () => {
    const s = scheduleClip(clip(), false, 20, null)!;
    expect(s).toMatchObject({ startAt: 2, stopAt: 8, offset: 1, playFor: 6 });
    expect(s.gain).toEqual([[2, 1]]);
  });
  it('a clip straddling the In point starts at the In point, at the matching source position', () => {
    // range [5, 7): the context starts at 4 (1 s pre-roll); the clip [2, 8) source 1 s in
    const w = { baseSec: 4, fromSec: 4, toSec: 7 };
    const s = scheduleClip(clip(), false, 20, w)!;
    expect(s.startAt).toBe(0); // context time 0 = timeline 4 s
    expect(s.offset).toBe(1 + 2); // timeline 4 s is 2 s into the clip
    expect(s.playFor).toBe(3);
    expect(s.stopAt).toBe(3);
    // the source heard at the In point (timeline 5 s, context 1 s) = 1 + 3 = 4 s
    expect(s.offset + (5 - 4 - s.startAt)).toBe(4);
  });
  it('fades are cut at the window edges with their value there (no jump to full volume)', () => {
    const c = clip({ fadeInSec: 4 }); // 0 → 1 over [2, 6)
    const s = scheduleClip(c, false, 20, { baseSec: 3, fromSec: 3, toSec: 5 })!;
    expect(s.gain[0]).toEqual([0, 0.25]); // timeline 3 s: a quarter into the fade
    expect(s.gain.at(-1)![0]).toBe(2);
    expect(s.gain.at(-1)![1]).toBeCloseTo(0.75, 9);
  });
  it('a speed-mapped clip skips into its rate-1 buffer by the cut-off clip time', () => {
    const s = scheduleClip(clip({ speed: 2 }), true, 6, { baseSec: 4, fromSec: 4, toSec: 7 })!;
    expect(s).toMatchObject({ startAt: 0, offset: 2, playFor: null, stopAt: 3 });
  });
  it('clips outside the window are not scheduled', () => {
    expect(scheduleClip(clip(), false, 20, { baseSec: 8, fromSec: 8, toSec: 12 })).toBeNull();
    expect(scheduleClip(clip(), false, 20, { baseSec: 0, fromSec: 0, toSec: 2 })).toBeNull();
  });
  it('a clip nested in a compound window keeps both limits', () => {
    const s = scheduleClip(clip({ windowSec: [3, 6] }), false, 20, { baseSec: 5, fromSec: 5, toSec: 9 })!;
    expect(s).toMatchObject({ startAt: 0, stopAt: 1, offset: 1 + 3, playFor: 1 });
  });
});
