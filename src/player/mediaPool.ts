/**
 * Preview media pool: hidden <video> elements keyed by CLIP id (two clips of one asset can be
 * on screen together during a transition) and <img> elements keyed by asset id.
 * Implements FrameSources for the compositor. Video elements are muted — sound goes through
 * the AudioEngine.
 *
 * Memory rules (each <video> holds a decoder and its frame pool, ~70 MB for 1080×1920 in
 * Chromium's software path and more for 4K):
 * - at most MEMORY_LIMITS.previewVideos elements; the least recently used one is released first;
 * - elements the current frame does not use are released MEMORY_LIMITS.idleReleaseMs after the
 *   preview stops using them, by ONE one-shot timer (no polling), also while paused and idle;
 * - `releaseAll()` (tab hidden, memory watchdog) frees every element; the next render recreates
 *   the ones on screen;
 * - release = pause, drop src, load() (otherwise the element keeps the resource), detach.
 */
import { frameLookupSec, type MediaDrawOp } from '../engine/frameState';
import type { FrameSources, SourceImage } from '../engine/render';
import { getAssetUrl } from '../media/registry';
import { findClip } from '../model/project';
import { clipContains } from '../model/time';
import { MEMORY_LIMITS } from '../media/memory';
import type { Id, Project, Us } from '../model/types';
import { decideSync } from './sync';

interface VideoEntry {
  kind: 'video';
  el: HTMLVideoElement;
  url: string;
  lastUsed: number;
  lastSeekAt: number;
  /** Seek requested while another seek was in flight (coalesced scrubbing). */
  pendingSeek: number | null;
  /**
   * True once a frame was decoded. Chrome drops readyState to HAVE_METADATA while seeking but
   * keeps the previous frame on the element, so we keep drawing it (no black flash on scrub).
   */
  hasFrame: boolean;
}

interface ImageEntry {
  kind: 'image';
  el: HTMLImageElement;
  url: string;
  lastUsed: number;
}

const EVICT_AFTER_MS = MEMORY_LIMITS.idleReleaseMs;
const MAX_VIDEOS = MEMORY_LIMITS.previewVideos;
const MAX_IMAGES = 12;
/** Paused frame tolerance: 1 ms is below any frame duration and above currentTime rounding. */
const PAUSED_TOLERANCE_SEC = 0.001;

let hiddenHost: HTMLDivElement | null = null;
function host(): HTMLDivElement {
  if (hiddenHost && hiddenHost.isConnected) return hiddenHost;
  hiddenHost = document.createElement('div');
  hiddenHost.setAttribute('aria-hidden', 'true');
  hiddenHost.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
  document.body.appendChild(hiddenHost);
  return hiddenHost;
}

export class MediaPool implements FrameSources {
  private videos = new Map<Id, VideoEntry>();
  private images = new Map<Id, ImageEntry>();
  private project: Project | null = null;
  /** Clips the last rendered frame (plus preloads) uses; everything else is releasable. */
  private keep: ReadonlySet<Id> = new Set();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  /** Image assets the last rendered frame (plus preloads) uses. */
  private frameImages = new Set<Id>();

  /** `onReady` is called whenever a new frame becomes drawable (load, seek done). */
  constructor(private onReady: () => void) {}

  setProject(p: Project): void {
    this.project = p;
  }

  // ---------------------------------------------------------------- FrameSources

  get(op: MediaDrawOp): SourceImage | 'missing' | null {
    const asset = this.project?.assets[op.assetId];
    if (!asset || asset.missing) return 'missing';
    if (op.mediaType === 'image') {
      const e = this.image(op.assetId);
      if (!e || !e.el.complete || e.el.naturalWidth === 0) return null;
      return { image: e.el, width: e.el.naturalWidth, height: e.el.naturalHeight };
    }
    const e = this.videos.get(op.clipId);
    if (!e || e.el.videoWidth === 0 || (e.el.readyState < 2 && !e.hasFrame)) return null;
    return { image: e.el, width: e.el.videoWidth, height: e.el.videoHeight };
  }

  // ---------------------------------------------------------------- sync

  /**
   * Bring every video in `ops` to its source time. `playing` = the timeline clock is running.
   * `t` is the timeline time the ops were computed for.
   */
  sync(ops: readonly MediaDrawOp[], t: Us, playing: boolean, fps: number): void {
    const now = performance.now();
    this.frameImages = new Set();
    for (const op of ops) {
      if (op.mediaType === 'image') {
        this.image(op.assetId);
        this.frameImages.add(op.assetId);
        continue;
      }
      const e = this.video(op.clipId, op.assetId);
      if (!e) continue;
      e.lastUsed = now;
      const clip = this.project ? findClip(this.project, op.clipId)?.clip : undefined;
      const asset = this.project?.assets[op.assetId];
      const speed = clip && (clip.type === 'video' || clip.type === 'audio') ? clip.speed : 1;
      // running = the source actually advances at t (not a held edge frame of a transition)
      const atEnd = asset ? op.sourceTime >= asset.duration - 1e6 / fps : false;
      const running = playing && !!clip && clipContains(clip, t) && !atEnd;
      // Paused (or a held / stepped frame): the element must sit exactly on the target, not within
      // half a frame of it — "half a frame" in time still straddles a frame boundary half the time
      // (measured: paused on frame 74, element left on 75). After one seek currentTime == target.
      this.apply(e, frameLookupSec(op.sourceTime), running, speed, running ? 0.5 / fps : PAUSED_TOLERANCE_SEC, now);
    }
  }

  /**
   * Warm up clips that are about to appear: create elements and park them on the frame they
   * will ENTER with. `ops` come from a look-ahead frame (t + preload window), so their
   * sourceTime is up to that window past the clip's first frame; parking there made the first
   * frame after a cut show a frame from later in the clip (measured: 5 frames ahead at a cut).
   * `t` is the timeline time now.
   */
  preload(ops: readonly MediaDrawOp[], t: Us): void {
    const now = performance.now();
    for (const op of ops) {
      if (op.mediaType === 'image') {
        this.image(op.assetId);
        this.frameImages.add(op.assetId);
        continue;
      }
      if (this.videos.has(op.clipId)) continue;
      const e = this.video(op.clipId, op.assetId);
      if (!e) continue;
      e.lastUsed = now;
      this.apply(e, frameLookupSec(this.entrySourceTime(op, t)), false, 1, 0.02, now);
    }
  }

  /** Source time of `op`'s clip at the moment it comes on screen (its start, or now if it has started). */
  private entrySourceTime(op: MediaDrawOp, t: Us): Us {
    const clip = this.project ? findClip(this.project, op.clipId)?.clip : undefined;
    if (!clip || clip.type !== 'video' || clip.start <= t) return op.sourceTime;
    const asset = this.project?.assets[op.assetId];
    const max = asset ? Math.max(0, asset.duration - 1) : Number.MAX_SAFE_INTEGER;
    return Math.min(max, Math.max(0, clip.inPoint));
  }

  /** Pause every video not in `keep`; free the ones unused for a while (now, or by the sweep timer). */
  idle(keep: ReadonlySet<Id>): void {
    this.keep = keep;
    const now = performance.now();
    for (const [id, e] of this.videos) {
      if (keep.has(id)) continue;
      if (!e.el.paused) e.el.pause();
      if (now - e.lastUsed > EVICT_AFTER_MS) this.release(id, e);
    }
    this.enforceCap(keep);
    this.scheduleSweep();
  }

  pauseAll(): void {
    for (const e of this.videos.values()) if (!e.el.paused) e.el.pause();
  }

  /** Frees every element (tab hidden, memory pressure). The next render recreates what it needs. */
  releaseAll(): void {
    this.clearSweep();
    for (const [id, e] of [...this.videos]) this.release(id, e);
    for (const e of this.images.values()) e.el.removeAttribute('src');
    this.images.clear();
    this.frameImages = new Set();
  }

  /** Live element counts (tests, debug readout). */
  stats(): { videos: number; images: number } {
    return { videos: this.videos.size, images: this.images.size };
  }

  dispose(): void {
    this.releaseAll();
  }

  /** One-shot: releases whatever is still unused when the oldest unused element expires. */
  private scheduleSweep(): void {
    this.clearSweep();
    let next = Infinity;
    for (const [id, e] of this.videos) if (!this.keep.has(id)) next = Math.min(next, e.lastUsed + EVICT_AFTER_MS);
    const imgIds = new Set<Id>();
    for (const [id, e] of this.images) {
      if (this.imageInUse(id)) continue;
      imgIds.add(id);
      next = Math.min(next, e.lastUsed + EVICT_AFTER_MS);
    }
    if (!Number.isFinite(next)) return;
    const wait = Math.max(50, next - performance.now() + 1);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      const now = performance.now();
      for (const [id, e] of [...this.videos]) if (!this.keep.has(id) && now - e.lastUsed >= EVICT_AFTER_MS) this.release(id, e);
      for (const [id, e] of [...this.images]) {
        if (!this.imageInUse(id) && now - e.lastUsed >= EVICT_AFTER_MS) {
          e.el.removeAttribute('src');
          this.images.delete(id);
        }
      }
      this.scheduleSweep();
    }, wait);
  }

  private clearSweep(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }

  private imageInUse(assetId: Id): boolean {
    return this.frameImages.has(assetId);
  }

  private enforceCap(keep: ReadonlySet<Id>): void {
    if (this.videos.size > MAX_VIDEOS) {
      const old = [...this.videos.entries()].filter(([id]) => !keep.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [id, e] of old.slice(0, this.videos.size - MAX_VIDEOS)) this.release(id, e);
    }
    if (this.images.size > MAX_IMAGES) {
      const old = [...this.images.entries()].filter(([id]) => !this.imageInUse(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [id, e] of old.slice(0, this.images.size - MAX_IMAGES)) {
        e.el.removeAttribute('src');
        this.images.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------- internals

  private apply(e: VideoEntry, target: number, running: boolean, speed: number, tolerance: number, now: number): void {
    const el = e.el;
    if (el.readyState < 1) {
      e.pendingSeek = target; // applied on loadedmetadata
      return;
    }
    const a = decideSync(
      { currentTime: el.currentTime, paused: el.paused, seeking: el.seeking, playbackRate: el.playbackRate, sinceSeekMs: now - e.lastSeekAt },
      { target, running, speed, tolerance, nudge: true },
    );
    if (a.rate !== null) el.playbackRate = a.rate;
    if (a.pause) el.pause();
    if (a.seek !== null) {
      if (el.seeking && !running) e.pendingSeek = a.seek;
      else this.seek(e, a.seek);
    }
    if (a.play) el.play().catch(() => undefined);
  }

  private seek(e: VideoEntry, sec: number): void {
    e.pendingSeek = null;
    e.lastSeekAt = performance.now();
    const max = Number.isFinite(e.el.duration) ? Math.max(0, e.el.duration - 0.001) : sec;
    e.el.currentTime = Math.max(0, Math.min(sec, max));
  }

  private video(clipId: Id, assetId: Id): VideoEntry | null {
    const url = getAssetUrl(assetId);
    const existing = this.videos.get(clipId);
    if (existing && existing.url === url) return existing;
    if (existing) this.release(clipId, existing);
    if (!url) return null;
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    const e: VideoEntry = { kind: 'video', el, url, lastUsed: performance.now(), lastSeekAt: -Infinity, pendingSeek: null, hasFrame: false };
    el.addEventListener('loadedmetadata', () => {
      if (e.pendingSeek !== null) this.seek(e, e.pendingSeek);
    });
    el.addEventListener('seeked', () => {
      if (e.pendingSeek !== null && Math.abs(e.pendingSeek - el.currentTime) > 0.001) this.seek(e, e.pendingSeek);
      else e.pendingSeek = null;
      e.hasFrame = true;
      this.onReady();
    });
    el.addEventListener('loadeddata', () => {
      e.hasFrame = true;
      this.onReady();
    });
    el.src = url;
    host().appendChild(el);
    this.videos.set(clipId, e);
    return e;
  }

  private image(assetId: Id): ImageEntry | null {
    const url = getAssetUrl(assetId);
    const existing = this.images.get(assetId);
    if (existing && existing.url === url) {
      existing.lastUsed = performance.now();
      return existing;
    }
    if (!url) return null;
    const el = new Image();
    el.decoding = 'async';
    el.onload = () => this.onReady();
    el.src = url;
    const e: ImageEntry = { kind: 'image', el, url, lastUsed: performance.now() };
    this.images.set(assetId, e);
    return e;
  }

  private release(clipId: Id, e: VideoEntry): void {
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load();
    e.el.remove();
    this.videos.delete(clipId);
  }
}
