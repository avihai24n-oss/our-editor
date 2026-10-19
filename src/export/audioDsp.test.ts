import { describe, expect, it } from 'vitest';
import { LIMIT_CEILING, limitPeaks, stretchPreservePitch } from './audioDsp';

const SR = 48_000;
const sine = (hz: number, amp: number, sec: number) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / (to - from));
};
const zeroCrossHz = (a: Float32Array, from: number, to: number) => {
  let z = 0;
  for (let i = from + 1; i < to; i++) if ((a[i - 1]! < 0) !== (a[i]! < 0)) z++;
  return z / 2 / ((to - from) / SR);
};
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('stretchPreservePitch (WSOLA)', () => {
  for (const speed of [2, 0.5, 1.5, 3]) {
    it(`speed ${speed}: right length, same pitch, same level`, () => {
      const src = sine(440, 0.25, 8);
      const outLen = Math.round((2 * SR) / Math.min(1, speed));
      const [out] = stretchPreservePitch([src, src], 0.5 * SR, speed, outLen);
      expect(out!.length).toBe(outLen);
      const a = Math.round(0.1 * SR);
      const b = outLen - Math.round(0.1 * SR);
      expect(Math.abs(zeroCrossHz(out!, a, b) - 440)).toBeLessThan(3);
      expect(Math.abs(20 * Math.log10(rms(out!, a, b) / rms(src)))).toBeLessThan(0.5);
      expect(out!.every(Number.isFinite)).toBe(true);
    });
  }

  it('reads the right part of the source (a step from silence to tone stays at its stretched time)', () => {
    // silence for 1 s, then tone; at 2× from 0 the tone must start at output 0.5 s
    const src = new Float32Array(4 * SR);
    src.set(sine(500, 0.5, 3), SR);
    const [out] = stretchPreservePitch([src], 0, 2, 1.5 * SR);
    const before = rms(out!, 0, Math.round(0.45 * SR));
    const after = rms(out!, Math.round(0.55 * SR), Math.round(1.4 * SR));
    expect(before).toBeLessThan(0.01);
    expect(after).toBeGreaterThan(0.3);
  });

  it('past the end of the source is silence, never garbage', () => {
    const src = sine(440, 0.5, 1);
    const [out] = stretchPreservePitch([src], 0, 2, SR);
    expect(rms(out!, Math.round(0.6 * SR), SR)).toBeLessThan(1e-6);
  });
});

describe('limitPeaks', () => {
  it('leaves a mix under the ceiling bit-identical', () => {
    const a = sine(440, 0.8, 1);
    const copy = a.slice();
    expect(limitPeaks([a], SR)).toBe(0);
    expect(a).toEqual(copy);
  });

  it('two in-phase 0.8 sines (peak 1.6) come out at the ceiling with no overs', () => {
    const l = sine(440, 1.6, 2);
    const r = sine(440, 1.6, 2);
    const gr = limitPeaks([l, r], SR);
    expect(gr).toBeLessThan(-4);
    expect(peak(l)).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
    expect(peak(r)).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
    // steady state ≈ ceiling: no pumping in the middle
    const mid = rms(l, SR / 2, SR * 1.5) * Math.SQRT2;
    expect(mid).toBeGreaterThan(LIMIT_CEILING * 0.97);
  });

  it('a single spike is caught by the look-ahead, and quiet audio around it recovers', () => {
    const a = sine(300, 0.3, 2);
    a[SR] = 1.5;
    limitPeaks([a], SR);
    expect(peak(a)).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
    expect(rms(a, 0, Math.round(0.9 * SR))).toBeCloseTo(0.3 / Math.SQRT2, 3); // before the look-ahead: untouched
    expect(rms(a, Math.round(1.8 * SR), 2 * SR)).toBeGreaterThan(0.95 * (0.3 / Math.SQRT2)); // released
  });
});
