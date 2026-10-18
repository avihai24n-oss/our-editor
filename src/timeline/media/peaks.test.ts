import { describe, expect, it } from 'vitest';
import { computePeaks, normGain, peakAt, quantizeTime, thumbStep, tileRange } from './peaks';

describe('computePeaks', () => {
  it('takes the max |sample| per bucket across channels', () => {
    const sr = 1000;
    const a = new Float32Array(2000); // 2 s
    const b = new Float32Array(2000);
    a[10] = 0.5;
    b[20] = -0.8; // same first bucket (pps 10 → 100 samples per bucket)
    a[1500] = 0.3;
    const p = computePeaks([a, b], sr, 10);
    expect(p.data.length).toBe(20);
    expect(p.duration).toBe(2);
    expect(p.data[0]).toBeCloseTo(0.8);
    expect(p.data[15]).toBeCloseTo(0.3);
    expect(p.data[5]).toBe(0);
  });
  it('clamps to 1 and handles empty input', () => {
    const p = computePeaks([new Float32Array([2, -3])], 2, 2);
    expect(Math.max(...p.data)).toBe(1);
    expect(computePeaks([], 44100).data.length).toBe(0);
  });
});

describe('peakAt / normGain', () => {
  const p = { data: new Float32Array([0.1, 0.5, 0.2, 0.9]), pps: 2, duration: 2 };
  it('reads the max over a range and at least one bucket', () => {
    expect(peakAt(p, 0, 1)).toBeCloseTo(0.5);
    expect(peakAt(p, 1, 2)).toBeCloseTo(0.9);
    expect(peakAt(p, 0.6, 0.61)).toBeCloseTo(0.5);
    expect(peakAt(p, 5, 6)).toBe(0);
    expect(peakAt(p, -2, -1)).toBe(0);
  });
  it('normalises quiet files, caps gain', () => {
    expect(normGain(p)).toBeCloseTo(0.95 / 0.9);
    expect(normGain({ data: new Float32Array([0.05]), pps: 1, duration: 1 })).toBe(4);
    expect(normGain({ data: new Float32Array([0]), pps: 1, duration: 1 })).toBe(1);
  });
});

describe('filmstrip maths', () => {
  it('thumbStep grows with the tile span', () => {
    expect(thumbStep(0.05)).toBe(0.1);
    expect(thumbStep(1)).toBe(1);
    expect(thumbStep(1.6)).toBe(2);
    expect(thumbStep(10000)).toBe(300);
  });
  it('quantizeTime floors to the step and stays inside the source', () => {
    expect(quantizeTime(3.7, 1, 10)).toBe(3);
    expect(quantizeTime(9.99, 0.5, 10)).toBe(9.5);
    expect(quantizeTime(12, 1, 10)).toBe(9.96);
    expect(quantizeTime(-1, 1, 10)).toBe(0);
  });
  it('tileRange covers only the visible window', () => {
    expect(tileRange(0, 100, 50, 1000)).toEqual([0, 1]);
    expect(tileRange(120, 260, 50, 1000)).toEqual([2, 5]);
    expect(tileRange(900, 2000, 50, 1000)).toEqual([18, 19]);
    expect(tileRange(-500, -10, 50, 1000)).toEqual([0, -1]);
    expect(tileRange(1200, 1300, 50, 1000)).toEqual([0, -1]);
  });
});
