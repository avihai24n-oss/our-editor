/**
 * Voice isolation (DSP): the STFT core (the code the AudioWorklet runs in preview and export),
 * noise profiles, the FX-chain config, and the clip-menu item.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { isolateVoiceMenuItem } from '../actions/isolateVoice';
import { mixFx, planMix } from '../export/offlineMix';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import type { AudioClip, VideoClip } from '../model/types';
import { useEditor } from '../store';
import { slots } from '../timeline/contextMenu/registry';
import type { MenuCtx } from '../timeline/contextMenu/types';
import { fxFromAudio, fxSignature, isolationStage } from './dsp';
import { getIsolateCore } from './isolateCore';
import { clearNoiseProfiles, noiseProfileReady, profileForBuffer, profileFromBuffer } from './noiseProfile';
import { spanKey } from './measure';

const SR = 48_000;
const { Core, profile } = getIsolateCore();

/** Deterministic pink-ish noise (Paul Kellet's filter on xorshift white). */
function pink(n: number, seed = 7): Float32Array {
  let x = seed;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 0xffffffff) * 2 - 1;
  };
  let b0 = 0, b1 = 0, b2 = 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = rnd();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.05;
  }
  return out;
}

/** "Speech-like": 0.3 s of a 600 Hz + 1.2 kHz + 2.4 kHz harmonic stack every second, then silence. */
function beeps(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t % 1 < 0.3) out[i] = 0.2 * Math.sin(2 * Math.PI * 600 * t) + 0.1 * Math.sin(2 * Math.PI * 1200 * t) + 0.05 * Math.sin(2 * Math.PI * 2400 * t);
  }
  return out;
}

const db = (a: Float32Array, s: number, e: number) => {
  let q = 0;
  for (let i = s; i < e; i++) q += a[i]! * a[i]!;
  return 10 * Math.log10(q / (e - s) + 1e-20);
};

/** Speech at 0 dB SNR: noise RMS = beep RMS (measured inside the beeps). */
function testSignal(seconds = 4) {
  const n = SR * seconds;
  const sig = beeps(n);
  const noise = pink(n);
  const g = Math.pow(10, (db(sig, SR * 0.05, SR * 0.25) - db(noise, 0, n)) / 20);
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = sig[i]! + noise[i]! * g;
  return { n, sig, mix };
}

function run(input: Float32Array[], opt: { mode: 'isolate' | 'remove'; strength: number; profile?: Float32Array | null }, block = 128) {
  const core = new Core({ sampleRate: SR, ...opt });
  const n = input[0]!.length;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let p = 0; p < n; p += block) {
    const m = Math.min(block, n - p);
    core.process(input.map((c) => c.subarray(p, p + m)), [L.subarray(p, p + m), R.subarray(p, p + m)], m);
  }
  return { L, R, latency: core.latency };
}

describe('voice isolation core (DSP)', () => {
  it('strength 0 is a pure N-sample delay (perfect reconstruction)', () => {
    const { mix } = testSignal(1);
    const prof = profile([mix], SR, 0, mix.length);
    const { L, R, latency } = run([mix], { mode: 'isolate', strength: 0, profile: prof });
    expect(latency).toBe(1024);
    let md = 0;
    for (let i = latency; i < mix.length; i++) md = Math.max(md, Math.abs(L[i]! - mix[i - latency]!), Math.abs(R[i]! - mix[i - latency]!));
    expect(md).toBeLessThan(1e-6);
  });

  it('isolate 100 at 0 dB SNR: ≥ 15 dB less noise in the pauses, beeps within 2 dB of the clean beeps', () => {
    const { n, sig, mix } = testSignal(4);
    const prof = profile([mix], SR, 0, n)!;
    expect(prof.length).toBe(513);
    const { L, latency: D } = run([mix], { mode: 'isolate', strength: 100, profile: prof });
    for (const k of [1, 2, 3]) {
      const pauseIn = db(mix, (k + 0.5) * SR, (k + 0.9) * SR);
      const pauseOut = db(L, (k + 0.5) * SR + D, (k + 0.9) * SR + D);
      expect(pauseIn - pauseOut, `pause ${k}`).toBeGreaterThan(15);
      const clean = db(sig, (k + 0.08) * SR, (k + 0.22) * SR);
      const out = db(L, (k + 0.08) * SR + D, (k + 0.22) * SR + D);
      expect(Math.abs(out - clean), `beep ${k}`).toBeLessThan(2);
    }
  });

  it('noise reduction grows with strength', () => {
    const { n, mix } = testSignal(3);
    const prof = profile([mix], SR, 0, n);
    const pause = (s: number) => {
      const { L, latency: D } = run([mix], { mode: 'isolate', strength: s, profile: prof });
      return db(L, 1.5 * SR + D, 1.9 * SR + D);
    };
    const [p0, p50, p100] = [pause(0), pause(50), pause(100)];
    expect(p50).toBeLessThan(p0 - 6);
    expect(p100).toBeLessThan(p50 - 6);
  });

  it('never boosts, never outputs NaN — even fed NaN, Infinity, silence or a full-scale square', () => {
    const n = SR;
    const square = new Float32Array(n).map((_, i) => (i % 100 < 50 ? 1 : -1));
    const junk = new Float32Array(n).map((_, i) => (i % 997 === 0 ? NaN : i % 991 === 0 ? Infinity : Math.sin(i / 10)));
    const prof = profile([pink(n)], SR, 0, n);
    for (const input of [square, junk, new Float32Array(n)]) {
      for (const mode of ['isolate', 'remove'] as const) {
        for (const p of [prof, null]) {
          const { L, R } = run([input, input], { mode, strength: 100, profile: p });
          let peak = 0;
          let finite = true;
          for (let i = 0; i < n; i++) {
            if (!Number.isFinite(L[i]!) || !Number.isFinite(R[i]!)) finite = false;
            peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
          }
          expect(finite).toBe(true);
          // √Hann OLA of gains ≤ 1: bounded by the input peak (+ small window ripple)
          expect(peak).toBeLessThan(1.5);
        }
      }
    }
  });

  it('without a profile only the 100 Hz–8 kHz emphasis runs (50 Hz hum cut, 1 kHz kept)', () => {
    const n = SR;
    const hum = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 50 * i) / SR));
    const tone = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    const h = run([hum], { mode: 'isolate', strength: 100, profile: null });
    const t = run([tone], { mode: 'isolate', strength: 100, profile: null });
    expect(db(hum, SR / 2, n) - db(h.L, SR / 2, n)).toBeGreaterThan(10);
    expect(Math.abs(db(tone, SR / 2, n) - db(t.L, SR / 2, n))).toBeLessThan(0.2);
  });

  it('remove vocals (approx.): centre speech band cut ≥ 25 dB, side content and centre bass kept', () => {
    const n = SR;
    const voice = new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    const side = new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 700 * i) / SR));
    const bass = new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 60 * i) / SR));
    const centre = run([voice, voice], { mode: 'remove', strength: 100 });
    expect(db(voice, SR / 2, n) - db(centre.L, SR / 2, n)).toBeGreaterThan(25);
    const neg = side.map((v) => -v);
    const st = run([side, neg], { mode: 'remove', strength: 100 });
    expect(Math.abs(db(side, SR / 2, n) - db(st.L, SR / 2, n))).toBeLessThan(0.2);
    const b = run([bass, bass], { mode: 'remove', strength: 100 });
    expect(db(bass, SR / 2, n) - db(b.L, SR / 2, n)).toBeLessThan(1.5);
  });
});

describe('noise profiles', () => {
  beforeEach(() => clearNoiseProfiles());

  it('learns from the quietest frames: the profile of noise + beeps ≈ the noise alone', () => {
    const n = SR * 3;
    const noise = pink(n);
    const b0 = beeps(n);
    const mix = noise.map((v, i) => v + b0[i]!);
    const a = profile([mix], SR, 0, n)!;
    const b = profile([noise], SR, 0, n)!;
    let sa = 0, sb = 0;
    for (let k = 3; k < 300; k++) {
      sa += a[k]!;
      sb += b[k]!;
    }
    expect(Math.abs(10 * Math.log10(sa / sb))).toBeLessThan(2);
  });

  it('silence and too-short spans give null; export caches per span', () => {
    expect(profile([new Float32Array(SR)], SR, 0, SR)).toBeNull();
    expect(profile([pink(500)], SR, 0, 500)).toBeNull();
    const buf = { numberOfChannels: 1, sampleRate: SR, getChannelData: () => pink(SR * 2) };
    const p = profileForBuffer('asset', 0.5, 1, buf)!;
    expect(p).toBeInstanceOf(Float32Array);
    expect(noiseProfileReady(spanKey('asset', 0.5, 1))).toBe(p);
    expect(profileFromBuffer(buf, 0.5, 1)).toEqual(p);
  });
});

describe('FX config and signature', () => {
  const base = { fillChannel: null, reduceNoise: false, voiceFilter: null };
  it('carries mode, clamped strength and the profile only for isolate', () => {
    const prof = new Float32Array(513).fill(1);
    expect(fxFromAudio({ ...base, voiceIsolation: { mode: 'isolate', strength: 150 } }, 1, prof).isolation).toEqual({ mode: 'isolate', strength: 100, profile: prof });
    expect(fxFromAudio({ ...base, voiceIsolation: { mode: 'remove', strength: 40 } }, 1, prof).isolation).toEqual({ mode: 'remove', strength: 40, profile: null });
    expect(fxFromAudio({ ...base, voiceIsolation: null }).isolation).toBeNull();
    expect(mixFx({ fx: { ...base, normalize: false, voiceIsolation: { mode: 'isolate', strength: 100 } } }, prof).isolation?.profile).toBe(prof);
  });
  it('the preview rebuilds when the profile arrives or the strength changes', () => {
    const a = fxSignature(fxFromAudio({ ...base, voiceIsolation: { mode: 'isolate', strength: 100 } }), true);
    const b = fxSignature(fxFromAudio({ ...base, voiceIsolation: { mode: 'isolate', strength: 100 } }, 1, new Float32Array(513)), true);
    const c = fxSignature(fxFromAudio({ ...base, voiceIsolation: { mode: 'isolate', strength: 99 } }, 1, new Float32Array(513)), true);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(isolationStage({ mode: 'isolate', strength: 100, profile: null })).toBe('isolate:100:noprofile');
    expect(isolationStage({ mode: 'remove', strength: 80, profile: null })).toBe('remove:80');
  });
});

describe('clip menu: Voice isolation (DSP)', () => {
  const st = () => useEditor.getState();
  const audioOf = (id: string) => (findClip(st().project, id)!.clip as VideoClip | AudioClip).audio;
  beforeEach(() => st().newProject());

  function setup() {
    const v = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: 4e6, width: 2, height: 2, hasAudio: true });
    const a = createAsset({ kind: 'audio', name: 'a.wav', mime: 'audio/wav', size: 1, duration: 4e6, hasAudio: true });
    const mute = createAsset({ kind: 'video', name: 's.mp4', mime: 'video/mp4', size: 1, duration: 4e6, width: 2, height: 2, hasAudio: false });
    st().addAssets([v, a, mute]);
    const ids = [st().addClip(v.id, { at: 0 })!, st().addClip(a.id, { at: 0 })!, st().addClip(mute.id, { at: 5e6 })!];
    return ids;
  }
  const ctx = (ids: string[]): MenuCtx => ({ clipIds: ids, primaryId: ids[0]!, trackId: '', time: 0 });

  it('is registered in the isolateVoice slot, labelled DSP, tagged Free', () => {
    expect(slots.isolateVoice).toBe(isolateVoiceMenuItem);
    expect(isolateVoiceMenuItem.label).toBe('Voice isolation (DSP)');
    expect(isolateVoiceMenuItem.tag).toBe('Free');
  });

  it('applies to every selected clip with sound as one undo step; Off clears; silent clips are skipped', () => {
    const [v, a, mute] = setup();
    expect(isolateVoiceMenuItem.disabled!(ctx([mute!]))).toBe(true);
    expect(isolateVoiceMenuItem.disabled!(ctx([v!, a!]))).toBe(false);
    const items = isolateVoiceMenuItem.submenu!(ctx([v!, a!, mute!]));
    expect(items.map((i) => i.id)).toEqual(['isolateVoice.isolate', 'isolateVoice.remove', 'isolateVoice.off']);
    expect(items[2]!.disabled!(ctx([v!]))).toBe(true);
    const before = st().past.length;
    items[0]!.run!(ctx([v!, a!, mute!]));
    expect(audioOf(v!).voiceIsolation).toEqual({ mode: 'isolate', strength: 100 });
    expect(audioOf(a!).voiceIsolation).toEqual({ mode: 'isolate', strength: 100 });
    expect(audioOf(mute!).voiceIsolation).toBeNull();
    expect(st().past.length).toBe(before + 1);
    expect(isolateVoiceMenuItem.submenu!(ctx([v!]))[0]!.icon).toBe('check');
    // the mix sees it
    expect(planMix(st().project).find((c) => c.clipId === a)!.fx.voiceIsolation).toEqual({ mode: 'isolate', strength: 100 });
    // a custom strength survives re-picking the same mode
    st().updateClip(v!, { audio: { voiceIsolation: { mode: 'isolate', strength: 40 } } });
    items[0]!.run!(ctx([v!, a!]));
    expect(audioOf(v!).voiceIsolation).toEqual({ mode: 'isolate', strength: 40 });
    items[1]!.run!(ctx([v!, a!]));
    expect(audioOf(v!).voiceIsolation).toEqual({ mode: 'remove', strength: 100 });
    const n = st().past.length;
    items[2]!.run!(ctx([v!, a!]));
    expect(audioOf(v!).voiceIsolation).toBeNull();
    expect(audioOf(a!).voiceIsolation).toBeNull();
    expect(st().past.length).toBe(n + 1);
    st().undo();
    expect(audioOf(a!).voiceIsolation).toEqual({ mode: 'remove', strength: 100 });
  });
});
