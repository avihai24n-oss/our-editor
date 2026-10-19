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
    for (const op of ops) {
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
        { target: op.sourceTime / 1e6, running: true, speed: op.speed, tolerance: 0.5 / fps },
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

  /** Pause everything; the voices are freed a moment later unless playback resumes. */
  stopAll(): void {
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
