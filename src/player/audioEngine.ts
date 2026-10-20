/**
 * Preview audio: one hidden media element per audible clip → MediaElementAudioSourceNode →
 * per-clip FX chain (src/audio/dsp.ts — the SAME graph the export builds: fill channel, reduce
 * noise, voice-filter pitch, voice filter) → its output GainNode (volume dB × fades from
 * AudioOp.gain × normalize gain) → master → speakers.
 * Speed = element.playbackRate; "Change audio pitch" = !preservesPitch.
 * The chain is rebuilt when its signature changes (a filter, its strength, a checkbox).
 * The AudioContext clock drives the playback clock (see PreviewEngine).
 *
 * Memory rules: at most MEMORY_LIMITS.previewVoices elements (LRU). After a pause every voice is
 * released MEMORY_LIMITS.idleReleaseMs later by one one-shot timer (an <audio> on a video file
 * holds a demuxer and an audio decoder); `releaseAll()` frees them at once (tab hidden, watchdog).
 */
import { buildFxChain, fxFromAudio, fxSignature, type FxChain } from '../audio/dsp';
import { normalizeGainDb } from '../audio/loudness';
import { loudnessReady, measureSpan, spanKey } from '../audio/measure';
import { ensureWorklets } from '../audio/worklets';
import type { AudioOp } from '../engine/frameState';
import { getAssetBlob, getAssetUrl } from '../media/registry';
import { MEMORY_LIMITS } from '../media/memory';
import type { Id } from '../model/types';
import { decideSync, MAX_RATE } from './sync';
import { reverseBuffer } from '../audio/reverse';

interface Voice {
  el: HTMLAudioElement;
  url: string;
  node: MediaElementAudioSourceNode | null;
  chain: FxChain | null;
  sig: string;
  /** Last gain target (op.gain × normalize). */
  target: number;
  /** Normalize gain applied (linear), 1 when off or not measured yet. */
  norm: number;
  lastSeekAt: number;
  lastUsed: number;
}

const EVICT_AFTER_MS = MEMORY_LIMITS.idleReleaseMs;
const MAX_VOICES = MEMORY_LIMITS.previewVoices;
/** Decoded, reversed assets kept for reversed clips (each ~23 MB per stereo minute at 48 kHz). */
const MAX_REVERSED_BUFFERS = 2;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<Id, Voice>();
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private worklets = false;

  /** Lazily creates the AudioContext. Call from a user gesture path (play) when possible. */
  context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      void ensureWorklets(this.ctx).then((ok) => {
        this.worklets = ok;
      });
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  async resume(): Promise<boolean> {
    const ctx = this.context();
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* blocked until a gesture */
      }
    }
    return ctx.state === 'running';
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Seconds on the audio clock (only meaningful while running). */
  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Call every tick while playing. Ops come from getFrameState(project, t).audio. */
  sync(ops: readonly AudioOp[], fps: number): void {
    this.cancelRelease();
    const ctx = this.ctx;
    const now = performance.now();
    const live = new Set<Id>();
    this.syncReversed(ops.filter((o) => o.reversed));
    for (const op of ops) {
      if (op.reversed) continue; // Edit › Reverse: played from a reversed buffer (syncReversed)
      const v = this.voice(op.clipId, op.assetId);
      if (!v) continue;
      live.add(op.clipId);
      v.lastUsed = now;
      if (v.node && ctx && this.master) {
        const sig = fxSignature(fxFromAudio(op.fx), this.worklets);
        if (sig !== v.sig || !v.chain) this.rebuild(v, op, sig);
      }
      v.norm = op.fx.normalize ? this.normalizeGain(op) : 1;
      v.target = op.gain * v.norm;
      if (v.chain && ctx) v.chain.output.gain.setTargetAtTime(v.target, ctx.currentTime, 0.015);
      else v.el.volume = Math.min(1, Math.max(0, v.target));
      const el = v.el as HTMLAudioElement & { preservesPitch?: boolean };
      if (el.preservesPitch !== op.preservePitch) el.preservesPitch = op.preservePitch;
      // beyond the native rate we cannot stay in sync — stay silent rather than stutter
      const audible = op.speed <= MAX_RATE && op.gain > 0;
      if (!audible) {
        if (!el.paused) el.pause();
        continue;
      }
      if (el.readyState < 1) continue;
      const a = decideSync(
        { currentTime: el.currentTime, paused: el.paused, seeking: el.seeking, playbackRate: el.playbackRate, sinceSeekMs: now - v.lastSeekAt },
        { target: op.sourceTime / 1e6, running: true, speed: op.speed, tolerance: 0.5 / fps, varying: !!op.varying },
      );
      if (a.rate !== null) el.playbackRate = a.rate;
      if (a.seek !== null) {
        v.lastSeekAt = now;
        el.currentTime = a.seek;
      }
      if (a.play) el.play().catch(() => undefined);
    }
    for (const [id, v] of this.voices) {
      if (live.has(id)) continue;
      if (!v.el.paused) v.el.pause();
      // the clip is over: cut effect tails (echo, reverb) — the export does the same
      if (v.chain && ctx && v.target !== 0) {
        v.target = 0;
        v.chain.output.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
      }
      if (now - v.lastUsed > EVICT_AFTER_MS) this.release(id, v);
    }
    if (this.voices.size > MAX_VOICES) {
      const old = [...this.voices.entries()].filter(([id]) => !live.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [id, v] of old.slice(0, this.voices.size - MAX_VOICES)) this.release(id, v);
    }
  }

  // ---------------------------------------------------------------- Edit › Reverse
  //
  // A media element cannot play backwards, so a reversed clip is heard from the asset's audio,
  // decoded once and time-reversed (src/audio/reverse.ts — the same buffer the export mix uses),
  // through an AudioBufferSourceNode → gain (volume × fades) → master. At most
  // MAX_REVERSED_BUFFERS decoded assets are kept (LRU); releaseAll() frees them.
  // Not carried here (yet): the FX chain (voice filter, reduce noise) and pitch-kept speed.

  private reversedBuffers = new Map<string, { p: Promise<AudioBuffer | null>; buf?: AudioBuffer | null; lastUsed: number }>();
  private reversedNodes = new Map<Id, { src: AudioBufferSourceNode; gain: GainNode; startCtx: number; startPos: number; rate: number }>();

  private reversedBuffer(assetId: Id, mediaSec: number): Promise<AudioBuffer | null> {
    const key = `${assetId}@${mediaSec}`;
    const hit = this.reversedBuffers.get(key);
    if (hit) {
      hit.lastUsed = performance.now();
      return hit.p;
    }
    const ctx = this.ctx;
    const p = (async () => {
      if (!ctx) return null;
      const blob = getAssetBlob(assetId) ?? (getAssetUrl(assetId) ? await (await fetch(getAssetUrl(assetId)!)).blob() : null);
      if (!blob) return null;
      try {
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        return reverseBuffer(ctx, buf, mediaSec);
      } catch {
        return null;
      }
    })();
    const entry: { p: Promise<AudioBuffer | null>; buf?: AudioBuffer | null; lastUsed: number } = { p, lastUsed: performance.now() };
    void p.then((b) => (entry.buf = b));
    this.reversedBuffers.set(key, entry);
    if (this.reversedBuffers.size > MAX_REVERSED_BUFFERS) {
      const oldest = [...this.reversedBuffers.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) this.reversedBuffers.delete(oldest[0]);
    }
    return p;
  }

  private syncReversed(ops: readonly AudioOp[]): void {
    const ctx = this.ctx;
    const live = new Set<Id>();
    if (ctx && this.master) {
      for (const op of ops) {
        live.add(op.clipId);
        const mediaSec = (op.mediaDuration ?? 0) / 1e6;
        const speed = Math.abs(op.speed);
        // reversed-media position now: D − real media time (sourceTime is already mirrored)
        const pos = Math.max(0, mediaSec - op.sourceTime / 1e6);
        let n = this.reversedNodes.get(op.clipId);
        if (n) {
          const at = n.startPos + (ctx.currentTime - n.startCtx) * n.rate;
          if (Math.abs(at - pos) > 0.12 || Math.abs(n.rate - speed) > 0.01) {
            this.stopReversed(op.clipId);
            n = undefined;
          }
        }
        if (!n) {
          void this.reversedBuffer(op.assetId, mediaSec);
          const ready = this.reversedBuffers.get(`${op.assetId}@${mediaSec}`)?.buf;
          if (!ready || speed <= 0 || speed > MAX_RATE) continue;
          const src = ctx.createBufferSource();
          src.buffer = ready;
          src.playbackRate.value = speed;
          const gain = ctx.createGain();
          gain.gain.value = op.gain;
          src.connect(gain);
          gain.connect(this.master);
          src.start(0, Math.min(pos, Math.max(0, ready.duration - 1e-3)));
          n = { src, gain, startCtx: ctx.currentTime, startPos: pos, rate: speed };
          this.reversedNodes.set(op.clipId, n);
        }
        n.gain.gain.setTargetAtTime(op.gain, ctx.currentTime, 0.015);
      }
    }
    for (const id of [...this.reversedNodes.keys()]) if (!live.has(id)) this.stopReversed(id);
  }

  private stopReversed(clipId: Id): void {
    const n = this.reversedNodes.get(clipId);
    if (!n) return;
    try {
      n.src.stop();
    } catch {
      /* not started */
    }
    n.src.disconnect();
    n.gain.disconnect();
    this.reversedNodes.delete(clipId);
  }

  /** Reversed clips currently sounding (e2e / debug). */
  get reversedVoiceCount(): number {
    return this.reversedNodes.size;
  }

  /** Pause everything; the voices are freed a moment later unless playback resumes. */
  stopAll(): void {
    for (const id of [...this.reversedNodes.keys()]) this.stopReversed(id);
    for (const v of this.voices.values()) if (!v.el.paused) v.el.pause();
    this.cancelRelease();
    if (!this.voices.size) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.releaseAll();
    }, EVICT_AFTER_MS);
  }

  /** Frees every voice now (tab hidden, memory pressure). The AudioContext is suspended. */
  releaseAll(): void {
    this.cancelRelease();
    for (const id of [...this.reversedNodes.keys()]) this.stopReversed(id);
    this.reversedBuffers.clear();
    for (const [id, v] of [...this.voices]) this.release(id, v);
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }

  get voiceCount(): number {
    return this.voices.size;
  }

  private cancelRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  dispose(): void {
    this.cancelRelease();
    for (const id of [...this.reversedNodes.keys()]) this.stopReversed(id);
    this.reversedBuffers.clear();
    for (const [id, v] of [...this.voices]) this.release(id, v);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }

  /** Linear normalize gain for the op's source span; measures it (once, async) when unknown. */
  private normalizeGain(op: AudioOp): number {
    const inSec = op.spanIn / 1e6;
    const lenSec = op.spanLength / 1e6;
    const key = spanKey(op.assetId, inSec, lenSec);
    const lufs = loudnessReady(key);
    if (lufs === undefined) {
      void measureSpan(op.assetId, inSec, lenSec, async (id) => {
        const b = getAssetBlob(id);
        if (b) return b;
        const url = getAssetUrl(id);
        return url ? (await fetch(url)).blob() : null;
      });
      return 1;
    }
    return Math.pow(10, normalizeGainDb(lufs) / 20);
  }

  private rebuild(v: Voice, op: AudioOp, sig: string): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !v.node) return;
    const old = v.chain;
    try {
      v.node.disconnect();
    } catch {
      /* not connected */
    }
    const chain = buildFxChain(ctx, fxFromAudio(op.fx), { worklets: this.worklets });
    chain.output.gain.value = old ? old.output.gain.value : 0;
    v.node.connect(chain.input);
    chain.output.connect(this.master);
    old?.dispose();
    v.chain = chain;
    v.sig = sig;
  }

  /** Dev / e2e: what each live voice is doing (gain values, FX stages). */
  debug(): { clipId: Id; gain: number; target: number; normalizeGain: number; stages: string[]; paused: boolean }[] {
    return [...this.voices.entries()].map(([clipId, v]) => ({
      clipId,
      gain: v.chain ? v.chain.output.gain.value : v.el.volume,
      target: v.target,
      normalizeGain: v.norm,
      stages: v.chain ? [...v.chain.stages] : [],
      paused: v.el.paused,
    }));
  }

  private voice(clipId: Id, assetId: Id): Voice | null {
    const url = getAssetUrl(assetId);
    const existing = this.voices.get(clipId);
    if (existing && existing.url === url) return existing;
    if (existing) this.release(clipId, existing);
    if (!url) return null;
    const el = new Audio();
    el.preload = 'auto';
    el.src = url;
    const v: Voice = { el, url, node: null, chain: null, sig: '', target: 0, norm: 1, lastSeekAt: -Infinity, lastUsed: performance.now() };
    const ctx = this.context();
    if (ctx && this.master) {
      try {
        v.node = ctx.createMediaElementSource(el);
      } catch {
        v.node = null;
      }
    }
    this.voices.set(clipId, v);
    return v;
  }

  private release(clipId: Id, v: Voice): void {
    v.el.pause();
    v.node?.disconnect();
    v.chain?.dispose();
    v.chain = null;
    v.el.removeAttribute('src');
    v.el.load();
    this.voices.delete(clipId);
  }
}
