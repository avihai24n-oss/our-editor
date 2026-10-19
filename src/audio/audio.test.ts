import { describe, expect, it } from 'vitest';
import { mixFx, gainPoints } from '../export/offlineMix';
import { dbToGain, gainToDb, migrateAudioProps, migrateProject } from '../model/project';
import { createProject, defaultAudio } from '../model/defaults';
import type { AudioProps, Project } from '../model/types';
import { crushCurve, driveCurve, fxFromAudio, fxSignature, hallImpulse, pitchRatio, VOICE_FILTERS } from './dsp';
import { energyToLufs, gatedLoudness, kWeighting, LoudnessMeter, measureLoudness, NORMALIZE_MAX_GAIN_DB, NORMALIZE_TARGET_LUFS, normalizeGainDb } from './loudness';

const sine = (freq: number, ampDbfs: number, seconds: number, fs = 48_000): Float32Array => {
  const n = Math.round(seconds * fs);
  const a = Math.pow(10, ampDbfs / 20);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin((2 * Math.PI * freq * i) / fs);
  return x;
};

describe('gain maths', () => {
  it('−6 dB is half amplitude, +6 dB double, −60 dB silence', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 4);
    expect(20 * Math.log10(dbToGain(-6))).toBeCloseTo(-6, 9);
    expect(dbToGain(6)).toBeCloseTo(1.9953, 4);
    expect(dbToGain(20)).toBeCloseTo(10, 9);
    expect(dbToGain(-60)).toBe(0);
    expect(gainToDb(dbToGain(-12.5))).toBeCloseTo(-12.5, 9);
  });

  it('fade envelope points ramp 0 → volume → 0 and normalize scales the plateau', () => {
    const c = { startSec: 1, durationSec: 4, volume: 0.5, fadeInSec: 1, fadeOutSec: 1 };
    expect(gainPoints(c)).toEqual([
      [1, 0],
      [2, 0.5],
      [4, 0.5],
      [5, 0],
    ]);
    const k = Math.pow(10, 6 / 20);
    expect(gainPoints({ ...c, volume: c.volume * k })[1]![1]).toBeCloseTo(0.5 * k, 9);
  });
});

describe('BS.1770 loudness', () => {
  it('K-weighting at 48 kHz matches the published coefficients', () => {
    const [shelf, hp] = kWeighting(48_000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 9);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 9);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 9);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 9);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 9);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 9);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 9);
  });

  it('EBU Tech 3341 case 1: stereo 1 kHz sine at −23 dBFS reads −23.0 LUFS', () => {
    const x = sine(1000, -23, 20);
    expect(measureLoudness([x, x], 48_000)).toBeCloseTo(-23, 1);
  });

  it('EBU Tech 3341 case 2: −33 dBFS reads −33.0 LUFS; works at 44.1 kHz too', () => {
    const x = sine(1000, -33, 20);
    expect(measureLoudness([x, x], 48_000)).toBeCloseTo(-33, 1);
    const y = sine(1000, -23, 20, 44_100);
    expect(measureLoudness([y, y], 44_100)).toBeCloseTo(-23, 1);
  });

  it('mono counts as dual-mono (what stereo playback of a mono file measures)', () => {
    const x = sine(1000, -23, 10);
    expect(measureLoudness([x], 48_000)).toBeCloseTo(measureLoudness([x, x], 48_000), 6);
  });

  it('silence is gated out (absolute −70 and relative −10 LU gates)', () => {
    const fs = 48_000;
    const tone = sine(1000, -23, 10);
    const both = new Float32Array(tone.length * 2);
    both.set(tone, 0); // 10 s tone then 10 s silence (blocks straddling the edge count, as in libebur128)
    expect(Math.abs(measureLoudness([both, both], fs) + 23)).toBeLessThan(0.1);
    expect(measureLoudness([new Float32Array(fs * 5)], fs)).toBe(-Infinity);
    // a −45 dB tail is below the relative gate and does not drag the result down
    const quiet = sine(1000, -45, 10);
    const mix = new Float32Array(tone.length * 2);
    mix.set(tone, 0);
    mix.set(quiet, tone.length);
    expect(Math.abs(measureLoudness([mix, mix], fs) + 23)).toBeLessThan(0.1);
  });

  it('streaming in odd chunk sizes gives the same answer as one push', () => {
    const x = sine(440, -18, 6);
    const m = new LoudnessMeter();
    for (let i = 0; i < x.length; i += 1237) m.push([x.subarray(i, i + 1237), x.subarray(i, i + 1237)], 48_000);
    expect(m.integrated()).toBeCloseTo(measureLoudness([x, x], 48_000), 6);
  });

  it('gating helpers', () => {
    expect(energyToLufs(0)).toBe(-Infinity);
    expect(gatedLoudness([])).toBe(-Infinity);
    const z = Math.pow(10, (-20 + 0.691) / 10);
    expect(gatedLoudness([z, z, z])).toBeCloseTo(-20, 9);
  });

  it('normalize gain brings the clip to the CapCut target and is clamped', () => {
    expect(NORMALIZE_TARGET_LUFS).toBe(-23);
    expect(normalizeGainDb(-30)).toBeCloseTo(7, 9);
    expect(normalizeGainDb(-14)).toBeCloseTo(-9, 9);
    expect(normalizeGainDb(-120)).toBe(NORMALIZE_MAX_GAIN_DB);
    expect(normalizeGainDb(-Infinity)).toBe(0);
    expect(normalizeGainDb(null)).toBe(0);
    // applying the gain to the signal lands exactly on the target
    const x = sine(1000, -31, 10);
    const lufs = measureLoudness([x, x], 48_000);
    const g = Math.pow(10, normalizeGainDb(lufs) / 20);
    const y = x.map((v) => v * g);
    expect(measureLoudness([y, y], 48_000)).toBeCloseTo(-23, 2);
  });
});

describe('FX chain config', () => {
  const base = { fillChannel: null, reduceNoise: false, voiceFilter: null };
  it('pitch: voice filters in semitones, export speed compensation, clamped', () => {
    expect(pitchRatio(fxFromAudio(base))).toBe(1);
    expect(pitchRatio(fxFromAudio({ ...base, voiceFilter: { id: 'chipmunk', strength: 100 } }))).toBeCloseTo(2, 9); // +12 st
    expect(pitchRatio(fxFromAudio({ ...base, voiceFilter: { id: 'deep', strength: 0 } }))).toBeCloseTo(Math.pow(2, -4 / 12), 9);
    expect(pitchRatio(fxFromAudio({ ...base, voiceFilter: { id: 'echo', strength: 50 } }))).toBe(1);
    expect(pitchRatio(fxFromAudio(base, 0.5))).toBe(0.5);
    expect(pitchRatio(fxFromAudio(base, 1 / 100))).toBe(0.25);
  });

  it('export compensates pitch only when the clip keeps its pitch', () => {
    const fx = { ...base, normalize: false };
    expect(pitchRatio(mixFx({ speed: 2, preservePitch: true, fx }))).toBe(0.5);
    expect(pitchRatio(mixFx({ speed: 2, preservePitch: false, fx }))).toBe(1);
    expect(pitchRatio(mixFx({ speed: 1, preservePitch: true, fx }))).toBe(1);
  });

  it('signature changes with every audible setting', () => {
    const sigs = new Set([
      fxSignature(fxFromAudio(base), true),
      fxSignature(fxFromAudio(base), false),
      fxSignature(fxFromAudio({ ...base, fillChannel: 'left' }), true),
      fxSignature(fxFromAudio({ ...base, fillChannel: 'right' }), true),
      fxSignature(fxFromAudio({ ...base, reduceNoise: true }), true),
      fxSignature(fxFromAudio({ ...base, voiceFilter: { id: 'robot', strength: 50 } }), true),
      fxSignature(fxFromAudio({ ...base, voiceFilter: { id: 'robot', strength: 51 } }), true),
    ]);
    expect(sigs.size).toBe(7);
  });

  it('every voice filter has a unique id and label', () => {
    expect(new Set(VOICE_FILTERS.map((f) => f.id)).size).toBe(VOICE_FILTERS.length);
    expect(new Set(VOICE_FILTERS.map((f) => f.label)).size).toBe(VOICE_FILTERS.length);
  });

  it('shaper curves and the reverb impulse are deterministic and bounded', () => {
    const d = driveCurve(10);
    expect(d[0]).toBeCloseTo(-1, 6);
    expect(d[d.length - 1]).toBeCloseTo(1, 6);
    const c = crushCurve(4);
    expect(new Set(Array.from(c)).size).toBe(9); // -4..4 steps
    expect(hallImpulse(48_000, 0.5)[0]).toEqual(hallImpulse(48_000, 0.5)[0]);
  });
});

describe('migration of the new audio fields', () => {
  it('fills defaults on old clips and leaves current ones untouched', () => {
    const old = { volumeDb: -3, fadeIn: 0, fadeOut: 0, muted: false } as unknown as AudioProps;
    expect(migrateAudioProps(old)).toEqual({ ...old, normalize: false, reduceNoise: false, fillChannel: null, voiceFilter: null });
    const cur = defaultAudio();
    expect(migrateAudioProps(cur)).toBe(cur);
    const bad = { ...cur, fillChannel: 'middle', voiceFilter: 'robot' } as unknown as AudioProps;
    expect(migrateAudioProps(bad)).toMatchObject({ fillChannel: null, voiceFilter: null });
    const kept = { ...cur, fillChannel: 'right' as const, voiceFilter: { id: 'echo' as const, strength: 30 } };
    expect(migrateAudioProps(kept)).toBe(kept);
  });

  it('migrateProject upgrades video and audio clips of an old saved project', () => {
    const p = createProject();
    const oldAudio = { volumeDb: -6, fadeIn: 0, fadeOut: 0, muted: false };
    const saved = JSON.parse(JSON.stringify(p)) as Project;
    saved.tracks.push({ id: 't2', kind: 'audio', name: 'Audio', locked: false, hidden: false, muted: false, transitions: [], clips: [
      { id: 'c1', type: 'audio', trackId: 't2', name: 'a', start: 0, duration: 1e6, disabled: false, assetId: 'x', inPoint: 0, speed: 1, preservePitch: true, audio: oldAudio as AudioProps },
    ] });
    const m = migrateProject(saved);
    expect(m).not.toBe(saved);
    const c = m.tracks[1]!.clips[0]!;
    expect(c.type === 'audio' && c.audio).toEqual({ ...oldAudio, normalize: false, reduceNoise: false, fillChannel: null, voiceFilter: null });
    expect(migrateProject(m)).toBe(m);
  });
});
