import { describe, expect, it } from 'vitest';
import { dbToPct, dbToPos, pctToDb, posToDb, UNITY, volumeLabel } from './VolumeLine';

describe('volume line mapping', () => {
  it('100 % rests a third of the way up; bottom is silence, top is +20 dB', () => {
    expect(dbToPos(0)).toBeCloseTo(UNITY);
    expect(posToDb(UNITY)).toBe(0);
    expect(posToDb(0)).toBe(-60);
    expect(posToDb(1)).toBe(20);
    expect(dbToPos(-60)).toBe(0);
    expect(dbToPos(20)).toBe(1);
  });
  it('below the rest point: linear gain, 50 % ≈ -6 dB', () => {
    expect(pctToDb(50)).toBe(-6);
    expect(posToDb(UNITY / 2)).toBe(-6);
    for (const p of [1, 10, 25, 50, 73, 99]) expect(Math.round(dbToPct(pctToDb(p)))).toBe(p);
  });
  it('above the rest point: boost in dB, labelled in percent', () => {
    expect(posToDb(UNITY + (1 - UNITY) / 2)).toBe(10);
    expect(posToDb(0.5)).toBe(5);
    expect(volumeLabel(20)).toBe('1000%');
    expect(volumeLabel(6)).toBe('200%');
    expect(volumeLabel(-6)).toBe('50%');
    for (const db of [-20, -6, 0, 3.5, 12, 20]) expect(posToDb(dbToPos(db))).toBeCloseTo(db, 0);
  });
});
