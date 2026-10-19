import { describe, expect, it } from 'vitest';
import { presetCurve } from '../model/speedCurve';
import { mixSourceMap, speedMappedChannels } from './offlineMix';
import { resampleMapped, sampledMap, stretchMapped } from './timeStretch';

const SR = 48_000;

function sine(freq: number, sec: number): Float32Array {
  const n = Math.round(sec * SR);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}

/** Dominant frequency by counting rising zero crossings over [from, to) samples. */
function zcFreq(x: Float32Array, from = 0, to = x.length): number {
  let n = 0;
  let first = -1;
  let last = -1;
  for (let i = Math.max(1, from); i < to; i++) {
    if (x[i - 1]! < 0 && x[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      n++;
    }
  }
  return n > 1 ? ((n - 1) * SR) / (last - first) : 0;
}

const rms = (x: Float32Array, a: number, b: number) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (b - a));
};

describe('resampleMapped (Change audio pitch on)', () => {
  it('2x reads twice as fast: 440 Hz → 880 Hz', () => {
    const src = sine(440, 2);
    const [out] = resampleMapped([src], SR, SR / 2, (n) => (2 * n) / SR);
    expect(zcFreq(out!)).toBeCloseTo(880, -1);
  });
  it('0.5x: 440 Hz → 220 Hz', () => {
    const src = sine(440, 1);
    const [out] = resampleMapped([src], SR, SR * 2, (n) => (0.5 * n) / SR);
    expect(zcFreq(out!)).toBeCloseTo(220, -1);
  });
});

describe('stretchMapped (Change audio pitch off — WSOLA)', () => {
  for (const speed of [2, 0.5, 3.7, 0.25]) {
    it(`${speed}x keeps 440 Hz, the output length and the level`, () => {
      const src = sine(440, 4);
      const frames = Math.round((4 / speed) * SR * 0.9);
      const [out] = stretchMapped([src], SR, frames, (n) => (speed * n) / SR);
      expect(out!.length).toBe(frames);
      const f = zcFreq(out!, 4096, frames - 4096);
      expect(Math.abs(f - 440)).toBeLessThan(3);
      expect(rms(out!, 4096, frames - 4096)).toBeGreaterThan(0.3); // 0.5/√2 ≈ 0.354, no cancellation
    });
  }
  it('stereo channels stay aligned', () => {
    const l = sine(440, 2);
    const r = sine(440, 2);
    const [a, b] = stretchMapped([l, r], SR, SR, (n) => (2 * n) / SR);
    let d = 0;
    for (let i = 0; i < a!.length; i++) d = Math.max(d, Math.abs(a![i]! - b![i]!));
    expect(d).toBe(0);
  });
});

describe('mix mapping uses the clip time mapping', () => {
  it('standard speed: n → inPoint + n/sr · speed', () => {
    const map = mixSourceMap({ inPointUs: 1_000_000, durationUs: 2_000_000, speed: 2, speedCurve: null }, SR);
    expect(map(SR)).toBeCloseTo(3, 9);
  });
  it('curve: the last sample reads the end of the span; sampledMap is within a µs', () => {
    const curve = presetCurve('bullet');
    const D = 2_000_000;
    const c = { inPointUs: 0, durationUs: D, speed: 1, speedCurve: curve };
    const exact = mixSourceMap(c, SR);
    const frames = (D / 1e6) * SR;
    const approx = sampledMap(exact, frames);
    for (let n = 0; n < frames; n += 997) expect(Math.abs(approx(n) - exact(n))).toBeLessThan(1e-6);
  });
  it('curve with pitch preserved: 440 Hz everywhere; with pitch changed: follows the curve', () => {
    const curve = presetCurve('jump-cut'); // 0.35x … 3x … 0.35x
    const src = sine(440, 6);
    const D = 4_000_000;
    const frames = (D / 1e6) * SR;
    const base = { inPointUs: 0, durationUs: D, speed: 1, speedCurve: curve };
    const [kept] = speedMappedChannels([src], SR, { ...base, preservePitch: true }, frames);
    const [shifted] = speedMappedChannels([src], SR, { ...base, preservePitch: false }, frames);
    // slow part (x ≈ 0.1) and fast part (x ≈ 0.5)
    const win = (x: number) => [Math.round(x * frames) - 4800, Math.round(x * frames) + 4800] as const;
    expect(Math.abs(zcFreq(kept!, ...win(0.15)) - 440)).toBeLessThan(5);
    expect(Math.abs(zcFreq(kept!, ...win(0.5)) - 440)).toBeLessThan(8);
    expect(zcFreq(shifted!, ...win(0.15))).toBeCloseTo(440 * 0.35, -1);
    expect(zcFreq(shifted!, ...win(0.5))).toBeGreaterThan(440 * 2.5);
  });
});
