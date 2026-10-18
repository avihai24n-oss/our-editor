/**
 * Preview audio: one hidden media element per audible clip → MediaElementAudioSourceNode →
 * per-clip GainNode (volume dB × fades, from AudioOp.gain) → master → speakers.
 * Speed = element.playbackRate; "Change audio pitch" = !preservesPitch.
 * The AudioContext clock drives the playback clock (see PreviewEngine).
 */
import type { AudioOp } from '../engine/frameState';
import { getAssetUrl } from '../media/registry';
import type { Id } from '../model/types';
import { decideSync, MAX_RATE } from './sync';

interface Voice {
  el: HTMLAudioElement;
  url: string;
  node: MediaElementAudioSourceNode | null;
  gain: GainNode | null;
  lastSeekAt: number;
  lastUsed: number;
}

const EVICT_AFTER_MS = 8000;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<Id, Voice>();

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
    const ctx = this.ctx;
    const now = performance.now();
    const live = new Set<Id>();
    for (const op of ops) {
      const v = this.voice(op.clipId, op.assetId);
      if (!v) continue;
      live.add(op.clipId);
      v.lastUsed = now;
      if (v.gain && ctx) v.gain.gain.setTargetAtTime(op.gain, ctx.currentTime, 0.015);
      else v.el.volume = Math.min(1, Math.max(0, op.gain));
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
      if (now - v.lastUsed > EVICT_AFTER_MS) this.release(id, v);
    }
  }

  stopAll(): void {
    for (const v of this.voices.values()) if (!v.el.paused) v.el.pause();
  }

  dispose(): void {
    for (const [id, v] of this.voices) this.release(id, v);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
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
    const v: Voice = { el, url, node: null, gain: null, lastSeekAt: -Infinity, lastUsed: performance.now() };
    const ctx = this.context();
    if (ctx && this.master) {
      try {
        v.node = ctx.createMediaElementSource(el);
        v.gain = ctx.createGain();
        v.gain.gain.value = 0;
        v.node.connect(v.gain).connect(this.master);
      } catch {
        v.node = null;
        v.gain = null;
      }
    }
    this.voices.set(clipId, v);
    return v;
  }

  private release(clipId: Id, v: Voice): void {
    v.el.pause();
    v.node?.disconnect();
    v.gain?.disconnect();
    v.el.removeAttribute('src');
    v.el.load();
    this.voices.delete(clipId);
  }
}
