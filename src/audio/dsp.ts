/**
 * The per-clip audio FX chain, built the same way in the preview AudioContext (audioEngine) and in
 * the export OfflineAudioContext (offlineMix), so what you hear is what you export:
 *
 *   source → input (forced stereo, mono is upmixed L=R)
 *          → Fill channel (splitter → merger, chosen side to both)
 *          → Reduce noise (80 Hz high-pass → oe-gate worklet)
 *          → pitch (oe-pitch worklet: voice-filter pitch × export speed compensation)
 *          → voice filter (native nodes: delay/feedback, ring-mod, wave-shaper, convolver…)
 *          → output GainNode (volume dB × normalize × fades — automated by the caller)
 *
 * Nodes that need a worklet are skipped when worklets are unavailable (`worklets: false`).
 */
import type { AudioProps, FillChannel, VoiceFilter, VoiceFilterId } from '../model/types';

export interface FxConfig {
  fillChannel: FillChannel | null;
  reduceNoise: boolean;
  voiceFilter: VoiceFilter | null;
  /**
   * Extra pitch ratio applied on top of the voice filter. Export: 1/speed when the clip keeps its
   * pitch ("Change audio pitch" off), because an AudioBufferSourceNode's playbackRate shifts pitch.
   * Preview: 1 (the media element preserves pitch itself).
   */
  extraPitch: number;
}

export const fxFromAudio = (a: Pick<AudioProps, 'fillChannel' | 'reduceNoise' | 'voiceFilter'>, extraPitch = 1): FxConfig => ({
  fillChannel: a.fillChannel ?? null,
  reduceNoise: !!a.reduceNoise,
  voiceFilter: a.voiceFilter ?? null,
  extraPitch,
});

// ---------------------------------------------------------------- voice filter catalogue

export interface VoiceFilterDef {
  id: VoiceFilterId;
  label: string;
  /** What the DSP does, shown as the tile's tooltip. */
  hint: string;
  /** Pitch shift in semitones for strength s (0..1); undefined = no pitch change. */
  semitones?: (s: number) => number;
}

/** Non-AI voice filters, named after CapCut's Voice changer › Voice filters where one matches. */
export const VOICE_FILTERS: readonly VoiceFilterDef[] = [
  { id: 'chipmunk', label: 'Chipmunk', hint: 'Pitch up 5–12 semitones', semitones: (s) => 5 + 7 * s },
  { id: 'high', label: 'High', hint: 'Pitch up 2–6 semitones', semitones: (s) => 2 + 4 * s },
  { id: 'low', label: 'Low', hint: 'Pitch down 2–5 semitones', semitones: (s) => -(2 + 3 * s) },
  { id: 'deep', label: 'Deep', hint: 'Pitch down 4–9 semitones + low-shelf boost', semitones: (s) => -(4 + 5 * s) },
  { id: 'robot', label: 'Robot', hint: 'Ring modulation + metallic comb' },
  { id: 'electronic', label: 'Electronic', hint: 'Short resonant comb filter' },
  { id: 'echo', label: 'Echo', hint: '250 ms delay with feedback' },
  { id: 'megaphone', label: 'Megaphone', hint: 'Band-pass 700 Hz–3.2 kHz + overdrive' },
  { id: 'distorted', label: 'Distorted', hint: 'Hard wave-shaper distortion' },
  { id: 'vinyl', label: 'Vinyl', hint: 'Band-limited, bit-crushed lo-fi' },
  { id: 'hall', label: 'Big hall', hint: 'Convolution reverb' },
];

export const DEFAULT_VOICE_STRENGTH = 50;

export const voiceFilterDef = (id: VoiceFilterId): VoiceFilterDef | undefined => VOICE_FILTERS.find((f) => f.id === id);

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
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
  return [cfg.fillChannel ?? '-', cfg.reduceNoise ? 'nr' : '-', cfg.voiceFilter ? `${cfg.voiceFilter.id}:${Math.round(cfg.voiceFilter.strength)}` : '-', Math.abs(r - 1) < 1e-4 ? '1' : r.toFixed(4), worklets ? 'w' : 'nw'].join('|');
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
