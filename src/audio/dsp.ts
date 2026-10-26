/**
 * The per-clip audio FX chain, built the same way in the preview AudioContext (audioEngine) and in
 * the export OfflineAudioContext (offlineMix), so what you hear is what you export:
 *
 *   source → input (forced stereo, mono is upmixed L=R)
 *          → Fill channel (splitter → merger, chosen side to both)
 *          → Reduce noise (80 Hz high-pass → oe-gate worklet)
 *          → Voice isolation (DSP, oe-isolate worklet — see ./isolateCore.ts)
 *          → pitch (oe-pitch worklet: voice-filter pitch × export speed compensation)
 *          → voice filter (native nodes: delay/feedback, ring-mod, wave-shaper, convolver…)
 *          → mixer (channel strip: cuts → EQ → compressor → warmth → delay → reverb → output)
 *          → output GainNode (volume dB × normalize × fades — automated by the caller)
 *
 * Nodes that need a worklet are skipped when worklets are unavailable (`worklets: false`).
 */
import type { AudioProps, FillChannel, VoiceFilter, VoiceFilterId, VoiceIsolationMode, VoiceMixer } from '../model/types';
import { PROFILE_RATE } from './noiseProfile';

export interface FxConfig {
  fillChannel: FillChannel | null;
  reduceNoise: boolean;
  voiceFilter: VoiceFilter | null;
  /** Voice isolation; `profile` = the clip's noise profile (null while not measured). */
  isolation: { mode: VoiceIsolationMode; strength: number; profile: Float32Array | null } | null;
  /**
   * Extra pitch ratio applied on top of the voice filter. Export: 1/speed when the clip keeps its
   * pitch ("Change audio pitch" off), because an AudioBufferSourceNode's playbackRate shifts pitch.
   * Preview: 1 (the media element preserves pitch itself).
   */
  extraPitch: number;
  /** Voice changer › Mixer; null = off. */
  mixer: VoiceMixer | null;
}

export const fxFromAudio = (
  a: Pick<AudioProps, 'fillChannel' | 'reduceNoise' | 'voiceFilter'> & Partial<Pick<AudioProps, 'voiceIsolation' | 'mixer'>>,
  extraPitch = 1,
  noiseProfile: Float32Array | null = null,
): FxConfig => ({
  fillChannel: a.fillChannel ?? null,
  reduceNoise: !!a.reduceNoise,
  voiceFilter: a.voiceFilter ?? null,
  isolation: a.voiceIsolation ? { mode: a.voiceIsolation.mode, strength: clamp(a.voiceIsolation.strength, 0, 100), profile: a.voiceIsolation.mode === 'isolate' ? noiseProfile : null } : null,
  extraPitch,
  mixer: a.mixer ?? null,
});

/** Default Strength of Voice isolation (the menu applies it; the inspector slider edits it). */
export const DEFAULT_ISOLATION_STRENGTH = 100;

/** Stage name of the isolation node ("isolate:100:profile", "remove:80"). */
export function isolationStage(iso: NonNullable<FxConfig['isolation']>): string {
  const s = Math.round(iso.strength);
  return iso.mode === 'remove' ? `remove:${s}` : `isolate:${s}:${iso.profile ? 'profile' : 'noprofile'}`;
}

// ---------------------------------------------------------------- voice filter catalogue

export type VoiceFilterGroup = 'space' | 'device' | 'character' | 'fx';

export const VOICE_FILTER_GROUPS: { id: VoiceFilterGroup; label: string }[] = [
  { id: 'space', label: 'Spaces' },
  { id: 'device', label: 'Eras & devices' },
  { id: 'character', label: 'Character' },
  { id: 'fx', label: 'Pitch & effects' },
];

export interface VoiceFilterDef {
  id: VoiceFilterId;
  label: string;
  group: VoiceFilterGroup;
  /** What the DSP does, shown as the tile's tooltip. */
  hint: string;
  /** Pitch shift in semitones for strength s (0..1); undefined = no pitch change. */
  semitones?: (s: number) => number;
}

/**
 * Non-AI voice filters. Spaces / eras / characters are for placing a voice in a scene (the film's
 * room, period, point of view); Strength = how much of the effect (mostly the wet level).
 */
export const VOICE_FILTERS: readonly VoiceFilterDef[] = [
  // spaces
  { id: 'room', label: 'Small room', group: 'space', hint: 'Short room ambience (0.35–0.75 s), close walls' },
  { id: 'studio', label: 'Studio booth', group: 'space', hint: 'Treated booth: a touch of air + presence polish' },
  { id: 'tiled', label: 'Tiled room', group: 'space', hint: 'Bright, dense reflections (bathroom / kitchen / stairwell)' },
  { id: 'stone', label: 'Stone hall', group: 'space', hint: 'Stone hall / synagogue: 1.6–3.2 s tail, 25 ms pre-delay' },
  { id: 'hall', label: 'Big hall', group: 'space', hint: 'Convolution reverb' },
  { id: 'cathedral', label: 'Cathedral', group: 'space', hint: 'Huge space: 3.5–6.5 s tail, 45 ms pre-delay' },
  { id: 'outdoor', label: 'Outdoors', group: 'space', hint: 'Open air: no room, thin lows, a far wall slap-back' },
  { id: 'distant', label: 'Far away', group: 'space', hint: 'Voice from across the space: duller, quieter, mostly reverb' },
  { id: 'next-room', label: 'Behind a door', group: 'space', hint: 'Muffled through a wall / door, small room on it' },
  // eras & devices
  { id: 'phone', label: 'Telephone', group: 'device', hint: '300–3400 Hz band + light drive' },
  { id: 'walkie', label: 'Walkie-talkie', group: 'device', hint: 'Narrow band, hard clipped' },
  { id: 'radio-old', label: 'Old radio', group: 'device', hint: '1940s–60s broadcast: mid-heavy band + saturation' },
  { id: 'gramophone', label: 'Gramophone', group: 'device', hint: '1920s–30s recording: very narrow band, grainy' },
  { id: 'megaphone', label: 'Megaphone', group: 'device', hint: 'Band-pass 700 Hz–3.2 kHz + overdrive' },
  { id: 'vinyl', label: 'Vinyl', group: 'device', hint: 'Band-limited, bit-crushed lo-fi' },
  // character
  { id: 'broadcast', label: 'Announcer', group: 'character', hint: 'Radio announcer: low-end weight, presence, tight compression' },
  { id: 'intimate', label: 'Close & intimate', group: 'character', hint: 'Close-mic proximity warmth, gentle compression' },
  { id: 'inner-voice', label: 'Inner voice', group: 'character', hint: 'Thoughts / voice in the head: soft doubling + short space' },
  { id: 'memory', label: 'Memory', group: 'character', hint: 'Flashback: faded top, long tail, distant echo' },
  { id: 'underwater', label: 'Underwater', group: 'character', hint: 'Low-passed, wobbling' },
  // pitch & effects
  { id: 'chipmunk', label: 'Chipmunk', group: 'fx', hint: 'Pitch up 5–12 semitones', semitones: (s) => 5 + 7 * s },
  { id: 'high', label: 'High', group: 'fx', hint: 'Pitch up 2–6 semitones', semitones: (s) => 2 + 4 * s },
  { id: 'low', label: 'Low', group: 'fx', hint: 'Pitch down 2–5 semitones', semitones: (s) => -(2 + 3 * s) },
  { id: 'deep', label: 'Deep', group: 'fx', hint: 'Pitch down 4–9 semitones + low-shelf boost', semitones: (s) => -(4 + 5 * s) },
  { id: 'robot', label: 'Robot', group: 'fx', hint: 'Ring modulation + metallic comb' },
  { id: 'electronic', label: 'Electronic', group: 'fx', hint: 'Short resonant comb filter' },
  { id: 'echo', label: 'Echo', group: 'fx', hint: '250 ms delay with feedback' },
  { id: 'distorted', label: 'Distorted', group: 'fx', hint: 'Hard wave-shaper distortion' },
];

export const DEFAULT_VOICE_STRENGTH = 50;

export const voiceFilterDef = (id: VoiceFilterId): VoiceFilterDef | undefined => VOICE_FILTERS.find((f) => f.id === id);

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, Number.isFinite(v) ? v : a));
}
export const PITCH_RATIO_MIN = 0.25;
export const PITCH_RATIO_MAX = 4;

/** Total pitch ratio of a chain (1 = unchanged), clamped to what the shifter handles. */
export function pitchRatio(cfg: FxConfig): number {
  const def = cfg.voiceFilter ? voiceFilterDef(cfg.voiceFilter.id) : undefined;
  const st = def?.semitones ? def.semitones(clamp(cfg.voiceFilter!.strength, 0, 100) / 100) : 0;
  const r = Math.pow(2, st / 12) * (cfg.extraPitch > 0 && Number.isFinite(cfg.extraPitch) ? cfg.extraPitch : 1);
  return clamp(r, PITCH_RATIO_MIN, PITCH_RATIO_MAX);
}

/** Stable signature: equal signatures build identical graphs (the preview rebuilds on change). */
export function fxSignature(cfg: FxConfig, worklets: boolean): string {
  const r = pitchRatio(cfg);
  return [
    cfg.fillChannel ?? '-',
    cfg.reduceNoise ? 'nr' : '-',
    cfg.isolation ? isolationStage(cfg.isolation) : '-',
    cfg.voiceFilter ? `${cfg.voiceFilter.id}:${Math.round(cfg.voiceFilter.strength)}` : '-',
    Math.abs(r - 1) < 1e-4 ? '1' : r.toFixed(4),
    worklets ? 'w' : 'nw',
    cfg.mixer ? JSON.stringify(cfg.mixer) : '-',
  ].join('|');
}

/** tanh soft-clip curve (drive k ≥ 1), normalised so ±1 maps to ±1. */
export function driveCurve(k: number, n = 2048): Float32Array {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

/** Bit-crusher staircase curve with `levels` steps per polarity. */
export function crushCurve(levels: number, n = 4096): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * levels) / levels;
  }
  return c;
}

/** Deterministic decaying-noise impulse response (seeded, so preview and export match). */
export function hallImpulse(sampleRate: number, seconds: number): Float32Array[] {
  const n = Math.max(1, Math.round(sampleRate * seconds));
  let seed = 0x2545f491;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const env = Math.pow(1 - i / n, 3);
    out[0]![i] = rnd() * env;
    out[1]![i] = rnd() * env;
  }
  return out;
}

export interface RoomShape {
  /** RT60-ish decay, seconds. */
  decay: number;
  /** Silence before the first reflection, seconds. */
  predelay: number;
  /** 0 = bright stone, 1 = dark / absorbent: highs die faster than lows. */
  damping: number;
  /** Early reflections: count and spread (seconds). */
  early?: { count: number; spread: number };
}

/**
 * Deterministic room impulse (seeded, so preview and export match): pre-delay, a few early
 * reflections, then a decaying noise tail whose top end is low-passed more and more over time
 * (air and walls absorb highs first), exponential decay reaching -60 dB at `decay`.
 */
export function roomImpulse(sampleRate: number, shape: RoomShape): Float32Array[] {
  const decay = clamp(shape.decay, 0.05, 12);
  const pre = Math.round(clamp(shape.predelay, 0, 0.3) * sampleRate);
  const n = Math.max(1, pre + Math.round(sampleRate * decay * 1.1));
  let seed = 0x1f2e3d4c;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  const out = [new Float32Array(n), new Float32Array(n)];
  const k = Math.log(1000) / (decay * sampleRate); // -60 dB at `decay`
  const damp = clamp(shape.damping, 0, 1);
  for (let ch = 0; ch < 2; ch++) {
    const o = out[ch]!;
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sampleRate;
      // one-pole low-pass whose cutoff falls with time: from ~16 kHz down to 16k × (1 - 0.9·damping)
      const fc = 16000 * (1 - damp * 0.9 * Math.min(1, t / Math.max(0.05, decay * 0.6)));
      const a = Math.exp((-2 * Math.PI * fc) / sampleRate);
      lp = (1 - a) * rnd() + a * lp;
      o[i] = lp * Math.exp(-k * (i - pre)) * (1 + damp); // damping loses level: give a little back
    }
    // early reflections: discrete taps after the pre-delay
    const er = shape.early ?? { count: 6, spread: Math.min(0.06, decay * 0.1) };
    for (let j = 0; j < er.count; j++) {
      const at = pre + Math.round(((j + 1) / (er.count + 1)) * er.spread * sampleRate * (ch ? 1.07 : 0.93));
      if (at < n) o[at] = (o[at] ?? 0) + (rnd() > 0 ? 1 : -1) * 0.6 * Math.pow(0.8, j);
    }
  }
  return out;
}

/** The default Mixer: every section off, neutral values ready to switch on. */
export const DEFAULT_MIXER: VoiceMixer = {
  lowCut: 0,
  highCut: 0,
  eq: { on: false, lowFreq: 150, lowGain: 0, midFreq: 1500, midGain: 0, midQ: 1, highFreq: 8000, highGain: 0 },
  comp: { on: false, threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 0 },
  warmth: { on: false, drive: 30, mix: 50 },
  delay: { on: false, time: 280, feedback: 25, mix: 20 },
  reverb: { on: false, decay: 1.4, predelay: 20, damping: 40, mix: 20 },
  output: 0,
};

/** Starting points for the Mixer (each replaces the whole strip). */
export const MIXER_PRESETS: { id: string; label: string; hint: string; mixer: VoiceMixer }[] = [
  {
    id: 'clean-vo',
    label: 'Clean voice-over',
    hint: 'Low cut, a little presence, steady level',
    mixer: { ...DEFAULT_MIXER, lowCut: 80, eq: { ...DEFAULT_MIXER.eq, on: true, lowGain: 1, midFreq: 350, midGain: -2, midQ: 1, highFreq: 6000, highGain: 2 }, comp: { ...DEFAULT_MIXER.comp, on: true, threshold: -22, ratio: 3, makeup: 3 } },
  },
  {
    id: 'warm-narrator',
    label: 'Warm narrator',
    hint: 'Full low end, smooth top, tape warmth',
    mixer: { ...DEFAULT_MIXER, lowCut: 60, eq: { ...DEFAULT_MIXER.eq, on: true, lowFreq: 140, lowGain: 3, midFreq: 2500, midGain: 1, highFreq: 9000, highGain: -1.5 }, comp: { ...DEFAULT_MIXER.comp, on: true, threshold: -24, ratio: 3.5, attack: 15, release: 200, makeup: 4 }, warmth: { on: true, drive: 25, mix: 40 } },
  },
  {
    id: 'documentary',
    label: 'Documentary',
    hint: 'Neutral, controlled, a hint of room',
    mixer: { ...DEFAULT_MIXER, lowCut: 90, eq: { ...DEFAULT_MIXER.eq, on: true, midFreq: 3000, midGain: 1.5 }, comp: { ...DEFAULT_MIXER.comp, on: true, threshold: -20, ratio: 2.5, makeup: 2 }, reverb: { on: true, decay: 0.5, predelay: 5, damping: 60, mix: 8 } },
  },
  {
    id: 'epic',
    label: 'Epic trailer',
    hint: 'Big, compressed, long hall',
    mixer: { ...DEFAULT_MIXER, lowCut: 50, eq: { ...DEFAULT_MIXER.eq, on: true, lowFreq: 110, lowGain: 4, highGain: 2.5 }, comp: { ...DEFAULT_MIXER.comp, on: true, threshold: -28, ratio: 6, attack: 5, makeup: 6 }, warmth: { on: true, drive: 35, mix: 35 }, reverb: { on: true, decay: 3.2, predelay: 40, damping: 35, mix: 22 } },
  },
];

// ---------------------------------------------------------------- graph

export interface FxChain {
  input: GainNode;
  /** Final gain stage; the caller drives `.gain` (volume × normalize × fades). */
  output: GainNode;
  /** Node stages in order, for the dev hook and tests ("fill:left", "gate", "pitch:1.5000"…). */
  stages: string[];
  dispose(): void;
}

export function buildFxChain(ctx: BaseAudioContext, cfg: FxConfig, opts: { worklets: boolean }): FxChain {
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  const stages: string[] = ['input'];
  const add = <T extends AudioNode>(n: T): T => {
    nodes.push(n);
    return n;
  };

  const biquad = (type: BiquadFilterType, freq: number, q = 0.707, gain = 0): BiquadFilterNode => {
    const f = add(ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  };
  const gainNode = (g: number): GainNode => {
    const n = add(ctx.createGain());
    n.gain.value = g;
    return n;
  };
  const shaper = (k: number): WaveShaperNode => {
    const sh = add(ctx.createWaveShaper());
    sh.curve = driveCurve(k) as Float32Array<ArrayBuffer>;
    sh.oversample = '2x';
    return sh;
  };
  const reverb = (shape: RoomShape): ConvolverNode => {
    const conv = add(ctx.createConvolver());
    const ir = roomImpulse(ctx.sampleRate, shape);
    const buf = ctx.createBuffer(2, ir[0]!.length, ctx.sampleRate);
    buf.copyToChannel(ir[0]! as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(ir[1]! as Float32Array<ArrayBuffer>, 1);
    conv.buffer = buf;
    conv.normalize = true;
    return conv;
  };
  /** A delay line whose time wobbles (chorus / doubling): base ± depth seconds at `rate` Hz. */
  const wobble = (base: number, depth: number, rate: number): DelayNode => {
    const d = add(ctx.createDelay(0.1));
    d.delayTime.value = base;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    sources.push(lfo);
    nodes.push(lfo);
    const amt = gainNode(depth);
    lfo.connect(amt).connect(d.delayTime);
    return d;
  };
  /** Feedback delay line (echo): time s, feedback 0..1, its repeats low-passed at `tone` Hz. */
  const echoLine = (time: number, feedback: number, tone = 6000): DelayNode => {
    const d = add(ctx.createDelay(2));
    d.delayTime.value = time;
    const fb = gainNode(feedback);
    const lp = biquad('lowpass', tone);
    d.connect(lp).connect(fb).connect(d);
    return d;
  };

  const input = add(ctx.createGain());
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';
  let tail: AudioNode = input;

  if (cfg.fillChannel) {
    const split = add(ctx.createChannelSplitter(2));
    const merge = add(ctx.createChannelMerger(2));
    const from = cfg.fillChannel === 'left' ? 0 : 1;
    tail.connect(split);
    split.connect(merge, from, 0);
    split.connect(merge, from, 1);
    tail = merge;
    stages.push(`fill:${cfg.fillChannel}`);
  }

  if (cfg.reduceNoise) {
    const hp = add(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 80;
    hp.Q.value = 0.707;
    tail.connect(hp);
    tail = hp;
    stages.push('highpass:80');
    if (opts.worklets) {
      const gate = add(new AudioWorkletNode(ctx, 'oe-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }));
      tail.connect(gate);
      tail = gate;
      stages.push('gate');
    }
  }

  if (cfg.isolation && cfg.isolation.strength > 0) {
    const iso = cfg.isolation;
    if (opts.worklets) {
      const node = add(
        new AudioWorkletNode(ctx, 'oe-isolate', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { mode: iso.mode, strength: iso.strength, profile: iso.profile, profileRate: PROFILE_RATE },
        }),
      );
      tail.connect(node);
      tail = node;
      stages.push(isolationStage(iso));
    } else if (iso.mode === 'isolate') {
      // no worklets: the speech-band emphasis alone
      const hp = add(ctx.createBiquadFilter());
      hp.type = 'highpass';
      hp.frequency.value = 100;
      const lp = add(ctx.createBiquadFilter());
      lp.type = 'lowpass';
      lp.frequency.value = 8000;
      tail.connect(hp).connect(lp);
      tail = lp;
      stages.push('band:100-8000');
    }
  }

  const ratio = pitchRatio(cfg);
  if (opts.worklets && Math.abs(ratio - 1) > 1e-4) {
    const ps = add(
      new AudioWorkletNode(ctx, 'oe-pitch', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { ratio, window: 2048 },
      }),
    );
    tail.connect(ps);
    tail = ps;
    stages.push(`pitch:${ratio.toFixed(4)}`);
  }

  if (cfg.voiceFilter) {
    const s = clamp(cfg.voiceFilter.strength, 0, 100) / 100;
    const fxOut = add(ctx.createGain());
    const t = tail;
    const mix = (wet: AudioNode, wetGain: number, dryGain: number) => {
      const w = add(ctx.createGain());
      w.gain.value = wetGain;
      wet.connect(w).connect(fxOut);
      if (dryGain > 0) {
        const d = add(ctx.createGain());
        d.gain.value = dryGain;
        t.connect(d).connect(fxOut);
      }
    };
    switch (cfg.voiceFilter.id) {
      case 'chipmunk':
      case 'high':
      case 'low':
        t.connect(fxOut);
        break;
      case 'deep': {
        const shelf = add(ctx.createBiquadFilter());
        shelf.type = 'lowshelf';
        shelf.frequency.value = 250;
        shelf.gain.value = 2 + 4 * s;
        t.connect(shelf).connect(fxOut);
        break;
      }
      case 'robot': {
        const carrier = ctx.createOscillator();
        carrier.type = 'sine';
        carrier.frequency.value = 50;
        sources.push(carrier);
        const ring = add(ctx.createGain());
        ring.gain.value = 0;
        carrier.connect(ring.gain);
        nodes.push(carrier);
        t.connect(ring);
        const comb = add(ctx.createDelay(0.05));
        comb.delayTime.value = 0.006;
        const fb = add(ctx.createGain());
        fb.gain.value = 0.55;
        ring.connect(comb);
        comb.connect(fb).connect(comb);
        const sum = add(ctx.createGain());
        ring.connect(sum);
        comb.connect(sum);
        mix(sum, 0.4 + 0.8 * s, 1 - s);
        break;
      }
      case 'electronic': {
        const comb = add(ctx.createDelay(0.05));
        comb.delayTime.value = 0.0025;
        const fb = add(ctx.createGain());
        fb.gain.value = 0.4 + 0.45 * s;
        const pre = add(ctx.createGain());
        t.connect(pre).connect(comb);
        comb.connect(fb).connect(comb);
        const hp = add(ctx.createBiquadFilter());
        hp.type = 'highpass';
        hp.frequency.value = 200;
        comb.connect(hp);
        mix(hp, 0.6, 1 - 0.6 * s);
        break;
      }
      case 'echo': {
        const d = add(ctx.createDelay(1));
        d.delayTime.value = 0.25;
        const fb = add(ctx.createGain());
        fb.gain.value = 0.2 + 0.5 * s;
        t.connect(d);
        d.connect(fb).connect(d);
        mix(d, 0.35 + 0.4 * s, 1);
        break;
      }
      case 'megaphone': {
        const hp = add(ctx.createBiquadFilter());
        hp.type = 'highpass';
        hp.frequency.value = 700;
        const lp = add(ctx.createBiquadFilter());
        lp.type = 'lowpass';
        lp.frequency.value = 3200;
        const sh = add(ctx.createWaveShaper());
        sh.curve = driveCurve(2 + 18 * s) as Float32Array<ArrayBuffer>;
        t.connect(hp).connect(lp).connect(sh);
        mix(sh, 0.8, 0);
        break;
      }
      case 'distorted': {
        const pre = add(ctx.createGain());
        pre.gain.value = 1;
        const sh = add(ctx.createWaveShaper());
        sh.curve = driveCurve(5 + 45 * s) as Float32Array<ArrayBuffer>;
        sh.oversample = '2x';
        const lp = add(ctx.createBiquadFilter());
        lp.type = 'lowpass';
        lp.frequency.value = 7000;
        t.connect(pre).connect(sh).connect(lp);
        mix(lp, 0.5, 0);
        break;
      }
      case 'vinyl': {
        const hp = add(ctx.createBiquadFilter());
        hp.type = 'highpass';
        hp.frequency.value = 250;
        const lp = add(ctx.createBiquadFilter());
        lp.type = 'lowpass';
        lp.frequency.value = 4000 - 1500 * s;
        const sh = add(ctx.createWaveShaper());
        sh.curve = crushCurve(Math.round(Math.pow(2, 7 - 4 * s))) as Float32Array<ArrayBuffer>;
        t.connect(hp).connect(lp).connect(sh);
        mix(sh, 1, 0);
        break;
      }
      // ---- spaces
      case 'room': {
        const conv = reverb({ decay: 0.35 + 0.4 * s, predelay: 0.004, damping: 0.55 });
        t.connect(conv);
        mix(conv, 0.3 + 0.5 * s, 1);
        break;
      }
      case 'studio': {
        const polish = biquad('peaking', 3200, 0.9, 1 + 1.5 * s);
        const warm = biquad('lowshelf', 180, 0.707, 1 + s);
        t.connect(warm).connect(polish);
        const amb = reverb({ decay: 0.22, predelay: 0.002, damping: 0.75, early: { count: 4, spread: 0.012 } });
        polish.connect(amb);
        mix(amb, 0.06 + 0.12 * s, 0);
        polish.connect(fxOut);
        break;
      }
      case 'tiled': {
        const conv = reverb({ decay: 0.6 + 0.6 * s, predelay: 0.003, damping: 0.12, early: { count: 12, spread: 0.025 } });
        t.connect(conv);
        mix(conv, 0.25 + 0.4 * s, 1);
        break;
      }
      case 'stone': {
        const conv = reverb({ decay: 1.6 + 1.6 * s, predelay: 0.025, damping: 0.35, early: { count: 8, spread: 0.07 } });
        t.connect(conv);
        mix(conv, 0.2 + 0.4 * s, 0.9);
        break;
      }
      case 'cathedral': {
        const conv = reverb({ decay: 3.5 + 3 * s, predelay: 0.045, damping: 0.45, early: { count: 8, spread: 0.12 } });
        t.connect(conv);
        mix(conv, 0.3 + 0.45 * s, 0.8);
        break;
      }
      case 'outdoor': {
        const thin = biquad('highpass', 110 + 60 * s);
        const shelf = biquad('lowshelf', 250, 0.707, -2 - 2 * s);
        t.connect(thin).connect(shelf);
        shelf.connect(fxOut);
        const slap = echoLine(0.14 + 0.06 * s, 0.12, 3500);
        shelf.connect(slap);
        const w = gainNode(0.1 + 0.15 * s);
        slap.connect(w).connect(fxOut);
        break;
      }
      case 'distant': {
        // air absorbs the top first: a steep, falling high cut
        const far = biquad('lowpass', 3400 - 1600 * s, 0.6);
        const far2 = biquad('lowpass', 3400 - 1600 * s, 0.6);
        const hp = biquad('highpass', 180 + 120 * s);
        t.connect(hp).connect(far2).connect(far);
        const direct = gainNode(0.55 - 0.3 * s);
        far.connect(direct).connect(fxOut);
        const conv = reverb({ decay: 1.2 + 0.8 * s, predelay: 0.03, damping: 0.5 });
        far.connect(conv);
        const w = gainNode(0.35 + 0.3 * s);
        conv.connect(w).connect(fxOut);
        break;
      }
      case 'next-room': {
        const muffle = biquad('lowpass', 950 - 450 * s, 0.9);
        const body = biquad('peaking', 220, 1, 3);
        t.connect(muffle).connect(body);
        const conv = reverb({ decay: 0.45, predelay: 0.003, damping: 0.6 });
        body.connect(conv);
        const w = gainNode(0.3 + 0.2 * s);
        conv.connect(w).connect(fxOut);
        const d = gainNode(0.8);
        body.connect(d).connect(fxOut);
        break;
      }
      // ---- eras & devices
      // devices: steep (24 dB/oct) band edges on both sides of the drive — a real device's mic AND
      // speaker band-limit, so the distortion's own lows / highs are cut again
      case 'phone': {
        const chain = [biquad('highpass', 300, 0.9), biquad('highpass', 300, 0.9), biquad('peaking', 1500, 1.2, 4 + 2 * s), shaper(2 + 6 * s), biquad('highpass', 300, 0.7), biquad('lowpass', 3400, 0.9), biquad('lowpass', 3400, 0.9)];
        chain.reduce<AudioNode>((a, b) => a.connect(b), t);
        mix(chain[chain.length - 1]!, 0.75, 0);
        break;
      }
      case 'walkie': {
        const chain = [biquad('highpass', 500, 1), biquad('highpass', 500, 1), biquad('peaking', 1800, 1.5, 8), shaper(8 + 20 * s), biquad('highpass', 450, 0.7), biquad('lowpass', 2600, 1), biquad('lowpass', 2800, 0.8)];
        chain.reduce<AudioNode>((a, b) => a.connect(b), t);
        mix(chain[chain.length - 1]!, 0.55, 0);
        break;
      }
      case 'radio-old': {
        const chain = [biquad('highpass', 150, 0.8), biquad('highpass', 150, 0.8), biquad('peaking', 1200, 0.8, 3 + 2 * s), shaper(2 + 4 * s), biquad('lowpass', 5000 - 1500 * s, 0.8), biquad('lowpass', 5000 - 1500 * s, 0.8)];
        chain.reduce<AudioNode>((a, b) => a.connect(b), t);
        mix(chain[chain.length - 1]!, 0.8, 0);
        break;
      }
      case 'gramophone': {
        const crush = add(ctx.createWaveShaper());
        crush.curve = crushCurve(Math.round(Math.pow(2, 8 - 2.5 * s))) as Float32Array<ArrayBuffer>;
        const lo = 300 + 100 * s;
        const hi = 3000 - 900 * s;
        const chain = [biquad('highpass', lo, 1), biquad('highpass', lo, 1), biquad('peaking', 1000, 1, 5), shaper(2), crush, biquad('highpass', lo, 0.7), biquad('lowpass', hi, 1), biquad('lowpass', hi, 1)];
        chain.reduce<AudioNode>((a, b) => a.connect(b), t);
        mix(chain[chain.length - 1]!, 0.8, 0);
        break;
      }
      // ---- character
      case 'broadcast': {
        const comp = add(ctx.createDynamicsCompressor());
        comp.threshold.value = -24 - 6 * s;
        comp.ratio.value = 3 + 2 * s;
        comp.attack.value = 0.005;
        comp.release.value = 0.15;
        comp.knee.value = 6;
        const chain: AudioNode[] = [biquad('highpass', 80), biquad('lowshelf', 120, 0.707, 3 + 2 * s), biquad('peaking', 3000, 0.9, 2 + 2 * s), biquad('highshelf', 10000, 0.707, 1.5), comp, gainNode(Math.pow(10, (4 + 2 * s) / 20))];
        chain.reduce<AudioNode>((a, b) => a.connect(b), t);
        chain[chain.length - 1]!.connect(fxOut);
        break;
      }
      case 'intimate': {
        const comp = add(ctx.createDynamicsCompressor());
        comp.threshold.value = -20;
        comp.ratio.value = 2.5;
        comp.attack.value = 0.01;
        comp.release.value = 0.2;
        const chain: AudioNode[] = [biquad('lowshelf', 180, 0.707, 3 + 3 * s), biquad('highshelf', 8000, 0.707, -1 - s), comp, gainNode(Math.pow(10, 3 / 20))];
        chain.reduce<AudioNode>((a, b) => a.connect(b), t);
        const last = chain[chain.length - 1]!;
        last.connect(fxOut);
        const amb = reverb({ decay: 0.2, predelay: 0.001, damping: 0.8, early: { count: 3, spread: 0.008 } });
        last.connect(amb);
        const w = gainNode(0.05);
        amb.connect(w).connect(fxOut);
        break;
      }
      case 'inner-voice': {
        const soft = biquad('lowpass', 7000);
        const hp = biquad('highpass', 120);
        t.connect(hp).connect(soft);
        soft.connect(fxOut);
        // two slightly detuned doubles, one per side
        const dl = wobble(0.012, 0.0015, 0.35);
        const dr = wobble(0.019, 0.0015, 0.27);
        const merge = add(ctx.createChannelMerger(2));
        const split = add(ctx.createChannelSplitter(2));
        soft.connect(dl);
        soft.connect(dr);
        dl.connect(split);
        split.connect(merge, 0, 0);
        const split2 = add(ctx.createChannelSplitter(2));
        dr.connect(split2);
        split2.connect(merge, 1, 1);
        const dbl = gainNode(0.25 + 0.25 * s);
        merge.connect(dbl).connect(fxOut);
        const amb = reverb({ decay: 0.8, predelay: 0.01, damping: 0.5 });
        soft.connect(amb);
        const w = gainNode(0.12 + 0.2 * s);
        amb.connect(w).connect(fxOut);
        break;
      }
      case 'memory': {
        const fade = biquad('lowpass', 4500 - 2000 * s);
        const hp = biquad('highpass', 200);
        t.connect(hp).connect(fade);
        const d = gainNode(0.75);
        fade.connect(d).connect(fxOut);
        const conv = reverb({ decay: 2.5, predelay: 0.03, damping: 0.55 });
        fade.connect(conv);
        const w = gainNode(0.3 + 0.3 * s);
        conv.connect(w).connect(fxOut);
        const echo = echoLine(0.35, 0.25, 2500);
        fade.connect(echo);
        const we = gainNode(0.12 + 0.15 * s);
        echo.connect(we).connect(fxOut);
        break;
      }
      case 'underwater': {
        const lp = biquad('lowpass', 450 - 200 * s, 4);
        const wob = wobble(0.008, 0.003, 0.6);
        t.connect(lp).connect(wob);
        const w = gainNode(1.4);
        wob.connect(w).connect(fxOut);
        break;
      }
      case 'hall': {
        const conv = add(ctx.createConvolver());
        const ir = hallImpulse(ctx.sampleRate, 1 + 2.5 * s);
        const buf = ctx.createBuffer(2, ir[0]!.length, ctx.sampleRate);
        buf.copyToChannel(ir[0]! as Float32Array<ArrayBuffer>, 0);
        buf.copyToChannel(ir[1]! as Float32Array<ArrayBuffer>, 1);
        conv.buffer = buf;
        t.connect(conv);
        mix(conv, 0.25 + 0.5 * s, 1);
        break;
      }
    }
    tail = fxOut;
    stages.push(`voice:${cfg.voiceFilter.id}:${Math.round(cfg.voiceFilter.strength)}`);
  }

  if (cfg.mixer) {
    const m = cfg.mixer;
    const used: string[] = [];
    if (m.lowCut > 0) {
      tail = tail.connect(biquad('highpass', clamp(m.lowCut, 20, 1000)));
      used.push(`lc${Math.round(m.lowCut)}`);
    }
    if (m.highCut > 0) {
      tail = tail.connect(biquad('lowpass', clamp(m.highCut, 1000, 20000)));
      used.push(`hc${Math.round(m.highCut)}`);
    }
    if (m.eq.on) {
      tail = tail
        .connect(biquad('lowshelf', clamp(m.eq.lowFreq, 30, 1000), 0.707, clamp(m.eq.lowGain, -18, 18)))
        .connect(biquad('peaking', clamp(m.eq.midFreq, 100, 10000), clamp(m.eq.midQ, 0.1, 10), clamp(m.eq.midGain, -18, 18)))
        .connect(biquad('highshelf', clamp(m.eq.highFreq, 1000, 18000), 0.707, clamp(m.eq.highGain, -18, 18)));
      used.push('eq');
    }
    if (m.comp.on) {
      const comp = add(ctx.createDynamicsCompressor());
      comp.threshold.value = clamp(m.comp.threshold, -60, 0);
      comp.ratio.value = clamp(m.comp.ratio, 1, 20);
      comp.attack.value = clamp(m.comp.attack, 0, 1000) / 1000;
      comp.release.value = clamp(m.comp.release, 10, 1000) / 1000;
      comp.knee.value = 6;
      tail = tail.connect(comp).connect(gainNode(Math.pow(10, clamp(m.comp.makeup, 0, 24) / 20)));
      used.push('comp');
    }
    if (m.warmth.on && m.warmth.mix > 0) {
      const sum = gainNode(1);
      const sat = shaper(1 + (clamp(m.warmth.drive, 0, 100) / 100) * 9);
      const w = clamp(m.warmth.mix, 0, 100) / 100;
      tail.connect(sat).connect(gainNode(w)).connect(sum);
      tail.connect(gainNode(1 - w)).connect(sum);
      tail = sum;
      used.push('warmth');
    }
    if (m.delay.on && m.delay.mix > 0) {
      const sum = gainNode(1);
      const line = echoLine(clamp(m.delay.time, 10, 2000) / 1000, clamp(m.delay.feedback, 0, 90) / 100, 6000);
      tail.connect(sum);
      tail.connect(line);
      line.connect(gainNode(clamp(m.delay.mix, 0, 100) / 100)).connect(sum);
      tail = sum;
      used.push('delay');
    }
    if (m.reverb.on && m.reverb.mix > 0) {
      const sum = gainNode(1);
      const conv = reverb({ decay: clamp(m.reverb.decay, 0.1, 10), predelay: clamp(m.reverb.predelay, 0, 200) / 1000, damping: clamp(m.reverb.damping, 0, 100) / 100 });
      const w = clamp(m.reverb.mix, 0, 100) / 100;
      tail.connect(gainNode(1 - w * 0.5)).connect(sum);
      tail.connect(conv).connect(gainNode(w)).connect(sum);
      tail = sum;
      used.push('reverb');
    }
    if (m.output) tail = tail.connect(gainNode(Math.pow(10, clamp(m.output, -24, 24) / 20)));
    if (used.length || m.output) stages.push(`mixer:${used.join('+') || 'gain'}`);
  }

  const output = add(ctx.createGain());
  tail.connect(output);
  stages.push('gain');
  for (const src of sources) src.start(0);

  return {
    input,
    output,
    stages,
    dispose() {
      for (const src of sources) {
        try {
          src.stop();
        } catch {
          /* not started */
        }
      }
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already */
        }
      }
    },
  };
}
