import { describe, expect, it } from 'vitest';
import { DEFAULT_MIXER, fxFromAudio, fxSignature, MIXER_PRESETS, roomImpulse, VOICE_FILTER_GROUPS, VOICE_FILTERS } from './dsp';

const energy = (a: Float32Array, from: number, to: number) => {
  let e = 0;
  for (let i = from; i < to; i++) e += a[i]! * a[i]!;
  return e;
};

describe('voice filter catalogue', () => {
  it('every filter is in a known group, every group has filters', () => {
    const groups = new Set(VOICE_FILTER_GROUPS.map((g) => g.id));
    for (const f of VOICE_FILTERS) expect(groups.has(f.group), f.id).toBe(true);
    for (const g of VOICE_FILTER_GROUPS) expect(VOICE_FILTERS.some((f) => f.group === g.id), g.id).toBe(true);
  });
});

describe('roomImpulse', () => {
  const sr = 48000;
  it('is deterministic (preview and export build the same reverb)', () => {
    const a = roomImpulse(sr, { decay: 1.5, predelay: 0.02, damping: 0.4 });
    const b = roomImpulse(sr, { decay: 1.5, predelay: 0.02, damping: 0.4 });
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).toEqual(b[1]);
  });
  it('is silent during the pre-delay, then decays about 60 dB by the decay time', () => {
    const [l] = roomImpulse(sr, { decay: 1, predelay: 0.05, damping: 0, early: { count: 0, spread: 0 } });
    expect(energy(l!, 0, 0.049 * sr)).toBe(0);
    const head = energy(l!, 0.05 * sr, 0.15 * sr);
    const tail = energy(l!, 0.95 * sr, 1.05 * sr);
    expect(10 * Math.log10(tail / head)).toBeLessThan(-45);
  });
  it('a longer decay keeps more tail; damping darkens it', () => {
    const short = roomImpulse(sr, { decay: 0.5, predelay: 0, damping: 0.4 })[0]!;
    const long = roomImpulse(sr, { decay: 3, predelay: 0, damping: 0.4 })[0]!;
    expect(long.length).toBeGreaterThan(short.length);
    // high-frequency content late in the tail: sample-to-sample differences
    const hf = (a: Float32Array, from: number, to: number) => {
      let d = 0;
      let e = 0;
      for (let i = from + 1; i < to; i++) {
        d += (a[i]! - a[i - 1]!) ** 2;
        e += a[i]! ** 2;
      }
      return d / e;
    };
    const bright = roomImpulse(sr, { decay: 2, predelay: 0, damping: 0 })[0]!;
    const dark = roomImpulse(sr, { decay: 2, predelay: 0, damping: 1 })[0]!;
    // a one-pole roll-off (6 dB/oct) ending near 1.6 kHz: the late tail is clearly darker
    expect(hf(dark, sr, 1.5 * sr)).toBeLessThan(hf(bright, sr, 1.5 * sr) / 2);
  });
});

describe('mixer config', () => {
  const base = { fillChannel: null, reduceNoise: false, voiceFilter: null } as const;
  it('reaches the FX config and changes the graph signature', () => {
    const off = fxFromAudio(base);
    const on = fxFromAudio({ ...base, mixer: MIXER_PRESETS[0]!.mixer });
    expect(off.mixer).toBeNull();
    expect(on.mixer).toEqual(MIXER_PRESETS[0]!.mixer);
    expect(fxSignature(on, true)).not.toBe(fxSignature(off, true));
    const louder = fxFromAudio({ ...base, mixer: { ...DEFAULT_MIXER, output: 3 } });
    expect(fxSignature(louder, true)).not.toBe(fxSignature(fxFromAudio({ ...base, mixer: DEFAULT_MIXER }), true));
  });
  it('presets have unique ids and stay in range', () => {
    expect(new Set(MIXER_PRESETS.map((p) => p.id)).size).toBe(MIXER_PRESETS.length);
    for (const p of MIXER_PRESETS) {
      expect(p.mixer.comp.ratio).toBeGreaterThanOrEqual(1);
      expect(Math.abs(p.mixer.eq.lowGain)).toBeLessThanOrEqual(12);
    }
  });
});
