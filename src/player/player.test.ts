import { describe, expect, it } from 'vitest';
import { PlaybackClock } from './clock';
import { decideSync, driftLimit, followRate, SEEK_GRACE_MS, type ElementState } from './sync';

describe('PlaybackClock', () => {
  it('advances from the anchor on the injected clock', () => {
    let now = 10;
    const c = new PlaybackClock(() => now);
    c.start(2_000_000);
    now = 10.5;
    expect(c.time()).toBe(2_500_000);
    c.seek(0);
    now = 11;
    expect(c.time()).toBe(500_000);
    expect(c.stop()).toBe(500_000);
    now = 20;
    expect(c.time()).toBe(500_000);
    expect(c.isRunning).toBe(false);
  });

  it('switching the time source keeps the current time', () => {
    let a = 100;
    let b = 3;
    const c = new PlaybackClock(() => a);
    c.start(1_000_000);
    a = 101;
    c.setSource(() => b);
    expect(c.time()).toBe(2_000_000);
    b = 3.25;
    expect(c.time()).toBe(2_250_000);
  });
});

describe('decideSync', () => {
  const el = (p: Partial<ElementState> = {}): ElementState => ({
    currentTime: 0,
    paused: true,
    seeking: false,
    playbackRate: 1,
    sinceSeekMs: Infinity,
    ...p,
  });
  const want = { target: 5, running: true, speed: 1, tolerance: 0.016 };

  it('starts a paused element at the target', () => {
    expect(decideSync(el(), want)).toEqual({ seek: 5, play: true, pause: false, rate: null });
    expect(decideSync(el({ currentTime: 5 }), want)).toEqual({ seek: null, play: true, pause: false, rate: null });
  });

  it('only corrects drift beyond the limit and outside the seek grace period', () => {
    const playing = el({ paused: false, currentTime: 5.1 });
    expect(decideSync(playing, want).seek).toBeNull();
    expect(decideSync({ ...playing, currentTime: 5 + driftLimit(1) + 0.01 }, want).seek).toBe(5);
    expect(decideSync({ ...playing, currentTime: 6, sinceSeekMs: SEEK_GRACE_MS - 1 }, want).seek).toBeNull();
  });

  it('sets the playback rate for speed', () => {
    expect(decideSync(el({ paused: false, currentTime: 5 }), { ...want, speed: 2 }).rate).toBe(2);
  });

  it('paused timeline: pause and seek to the frame', () => {
    expect(decideSync(el({ paused: false, currentTime: 1 }), { ...want, running: false })).toEqual({ seek: 5, play: false, pause: true, rate: null });
    expect(decideSync(el({ currentTime: 5.001 }), { ...want, running: false }).seek).toBeNull();
  });

  it('speeds beyond the native range step by seeking', () => {
    const a = decideSync(el({ paused: false, currentTime: 0 }), { ...want, speed: 50 });
    expect(a.pause).toBe(true);
    expect(a.seek).toBe(5);
    expect(a.play).toBe(false);
  });
});

describe('speed curves in the preview (varying speed)', () => {
  const playing: ElementState = { currentTime: 1, paused: false, seeking: false, playbackRate: 1, sinceSeekMs: 1000 };
  it('followRate is the curve speed plus a bounded proportional correction', () => {
    expect(followRate(1, 1, 2)).toBe(2);
    expect(followRate(1, 1.05, 2)).toBeCloseTo(2.1, 3); // 50 ms behind → +0.1
    expect(followRate(1, 3, 2)).toBe(2.5); // capped at +25 %
    expect(followRate(1, 0, 2)).toBe(1.6); // and −20 %
    expect(followRate(0, 0, 0.1)).toBe(0.1);
    expect(followRate(0, 0, 20)).toBe(16); // native limit
  });
  it('sets the element rate from the curve every tick without seeking while in sync', () => {
    const a = decideSync(playing, { target: 1.02, running: true, speed: 3, tolerance: 1 / 60, varying: true });
    expect(a.seek).toBeNull();
    expect(a.rate).toBeCloseTo(3.04, 3);
    // tiny rate differences (< 1 %) are not rewritten every frame
    const b = decideSync({ ...playing, playbackRate: 3.01 }, { target: 1, running: true, speed: 3, tolerance: 1 / 60, varying: true });
    expect(b.rate).toBeNull();
  });
  it('still re-seeks when far off', () => {
    const a = decideSync(playing, { target: 2, running: true, speed: 0.5, tolerance: 1 / 60, varying: true });
    expect(a.seek).toBe(2);
  });
});
