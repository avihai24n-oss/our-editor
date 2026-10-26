import { describe, expect, it } from 'vitest';
import { gainPoints } from '../export/offlineMix';
import { dbToGain } from './project';
import { clipVolumeDbAt, keyIndexAt, keyTimes, keysDbAt, shiftKeys, srcAt, timeAtSrc, withKeyAt, withoutKeyAt } from './volumeKeys';

// 4 s clip at 2 s on the timeline, reading the source from 10 s, speed 1
const clip = (keys?: { src: number; db: number }[], speed = 1) => ({
  start: 2e6,
  duration: 4e6,
  inPoint: 10e6,
  speed,
  speedCurve: null,
  audio: { volumeDb: -3, volumeKeys: keys },
});
const TOL = 1e6 / 60;

describe('volume keyframes', () => {
  it('no keys: the flat volume', () => {
    expect(clipVolumeDbAt(clip(), 3e6)).toBe(-3);
  });

  it('interpolates linearly in dB and holds flat outside the keys', () => {
    const c = clip([
      { src: 11e6, db: 0 },
      { src: 13e6, db: -20 },
    ]);
    expect(clipVolumeDbAt(c, 2e6)).toBe(0); // before the first key
    expect(clipVolumeDbAt(c, 4e6)).toBe(-10); // halfway
    expect(clipVolumeDbAt(c, 5.5e6)).toBe(-20); // after the last
  });

  it('keys sit on the source: a speed change moves them on the timeline', () => {
    const c = clip([{ src: 12e6, db: -6 }], 2);
    expect(srcAt(c, 3e6)).toBe(12e6);
    expect(timeAtSrc(c, 12e6)).toBe(3e6);
    expect(keyTimes(c)).toEqual([3e6]);
  });

  it('adds, replaces and removes the key at the playhead', () => {
    let keys = withKeyAt(clip(), 3e6, -6, TOL);
    expect(keys).toEqual([{ src: 11e6, db: -6 }]);
    keys = withKeyAt(clip(keys), 5e6, 3, TOL);
    keys = withKeyAt(clip(keys), 3e6 + 1000, -12, TOL); // within half a frame: same key
    expect(keys).toEqual([
      { src: 11e6, db: -12 },
      { src: 13e6, db: 3 },
    ]);
    expect(keyIndexAt(clip(keys), 5e6, TOL)).toBe(1);
    expect(withoutKeyAt(clip(keys), 5e6, TOL)).toEqual([{ src: 11e6, db: -12 }]);
    expect(withoutKeyAt(clip([{ src: 11e6, db: 0 }]), 3e6, TOL)).toBeUndefined();
  });

  it('shifts every key and clamps to the volume range', () => {
    expect(shiftKeys([{ src: 0, db: 15 }, { src: 1, db: -10 }], 10)).toEqual([
      { src: 0, db: 20 },
      { src: 1, db: 0 },
    ]);
  });

  it('export envelope follows the keys, times the fades', () => {
    const keys = [
      { src: 10e6, db: 0 },
      { src: 14e6, db: -60 },
    ];
    const pts = gainPoints({ startSec: 2, durationSec: 4, volume: 1, fadeInSec: 0, fadeOutSec: 0, volumeKeys: keys, inPointUs: 10e6, durationUs: 4e6, speed: 1, speedCurve: null });
    const at = (t: number) => pts.find(([x]) => Math.abs(x - t) < 1e-6)![1];
    expect(at(2)).toBeCloseTo(1);
    expect(at(4)).toBeCloseTo(dbToGain(keysDbAt(keys, 12e6)));
    expect(at(6)).toBe(0);
    const faded = gainPoints({ startSec: 2, durationSec: 4, volume: 1, fadeInSec: 1, fadeOutSec: 0, volumeKeys: [{ src: 10e6, db: 0 }], inPointUs: 10e6, durationUs: 4e6, speed: 1, speedCurve: null });
    expect(faded[0]).toEqual([2, 0]);
    expect(faded.find(([x]) => Math.abs(x - 2.5) < 1e-9)![1]).toBeCloseTo(0.5);
  });
});
