import { describe, expect, it } from 'vitest';
import { secToUs } from '../model/time';
import { hasArea, moveAreaEdge, NO_AREA, rangeFileTag, resolveArea, sanitizeArea } from './range';

const S = secToUs;

describe('resolveArea', () => {
  it('no area → null', () => {
    expect(resolveArea(NO_AREA, S(10))).toBeNull();
    expect(hasArea(NO_AREA)).toBe(false);
  });
  it('both ends: [in, out)', () => {
    expect(resolveArea({ in: S(2), out: S(5) }, S(10))).toEqual({ from: S(2), to: S(5) });
  });
  it('open ends reach the start / the end of the timeline', () => {
    expect(resolveArea({ in: S(2), out: null }, S(10))).toEqual({ from: S(2), to: S(10) });
    expect(resolveArea({ in: null, out: S(4) }, S(10))).toEqual({ from: 0, to: S(4) });
  });
  it('clamps to the timeline; an area past the end covers nothing', () => {
    expect(resolveArea({ in: S(8), out: S(20) }, S(10))).toEqual({ from: S(8), to: S(10) });
    expect(resolveArea({ in: S(12), out: null }, S(10))).toBeNull();
  });
});

describe('moveAreaEdge (handle drag)', () => {
  const fps = 30;
  const f = Math.round(1e6 / fps);
  it('frame-snaps', () => {
    expect(moveAreaEdge({ in: S(1), out: S(5) }, 'in', S(2) + 10_000, fps).in).toBe(S(2));
    expect(moveAreaEdge({ in: S(1), out: S(5) }, 'out', S(3) + 20_000, fps).out).toBe(S(3) + f);
  });
  it('never crosses the other edge (one frame stays marked) or goes below 0', () => {
    expect(moveAreaEdge({ in: S(1), out: S(5) }, 'in', S(9), fps)).toEqual({ in: S(5) - f, out: S(5) });
    expect(moveAreaEdge({ in: S(1), out: S(5) }, 'out', 0, fps)).toEqual({ in: S(1), out: S(1) + f });
    expect(moveAreaEdge({ in: S(1), out: S(5) }, 'in', -S(3), fps).in).toBe(0);
  });
  it('dragging an open end sets it', () => {
    expect(moveAreaEdge({ in: S(1), out: null }, 'out', S(4), fps)).toEqual({ in: S(1), out: S(4) });
    expect(moveAreaEdge({ in: null, out: S(4) }, 'in', S(1), fps)).toEqual({ in: S(1), out: S(4) });
  });
});

describe('sanitizeArea (stored view state)', () => {
  it('keeps valid areas, drops garbage and inverted ones', () => {
    expect(sanitizeArea({ in: S(1), out: S(2) })).toEqual({ in: S(1), out: S(2) });
    expect(sanitizeArea({ in: S(1) })).toEqual({ in: S(1), out: null });
    expect(sanitizeArea(undefined)).toEqual(NO_AREA);
    expect(sanitizeArea({ in: 'x', out: -1 })).toEqual(NO_AREA);
    expect(sanitizeArea({ in: S(3), out: S(2) })).toEqual(NO_AREA);
  });
});

it('rangeFileTag', () => {
  expect(rangeFileTag({ from: S(12.4), to: S(31) })).toBe('00-12 – 00-31');
  expect(rangeFileTag({ from: S(3700), to: S(3720) })).toBe('1-01-40 – 1-02-00');
});
