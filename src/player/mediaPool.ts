/**
 * Preview media pool: hidden <video> elements keyed by CLIP id (two clips of one asset can be
 * on screen together during a transition) and <img> elements keyed by asset id.
 * Implements FrameSources for the compositor. Video elements are muted — sound goes through
 * the AudioEngine.
 */
import type { MediaDrawOp } from '../engine/frameState';
import type { FrameSources, SourceImage } from '../engine/render';
import { getAssetUrl } from '../media/registry';
import { findClip } from '../model/project';
import { clipContains } from '../model/time';
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

const EVICT_AFTER_MS = 8000;
const MAX_VIDEOS = 12;

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
    for (const op of ops) {
      if (op.mediaType === 'image') {
        this.image(op.assetId);
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
      this.apply(e, op.sourceTime / 1e6, running, speed, 0.5 / fps, now);
    }
  }

  /** Warm up clips that are about to appear: create elements and park them on their frame. */
  preload(ops: readonly MediaDrawOp[]): void {
    const now = performance.now();
    for (const op of ops) {
      if (op.mediaType === 'image') {
        this.image(op.assetId);
        continue;
      }
      if (this.videos.has(op.clipId)) continue;
      const e = this.video(op.clipId, op.assetId);
      if (!e) continue;
      e.lastUsed = now;
      this.apply(e, op.sourceTime / 1e6, false, 1, 0.02, now);
    }
  }

  /** Pause every video not in `keep`; free the ones unused for a while. */
  idle(keep: ReadonlySet<Id>): void {
    const now = performance.now();
    for (const [id, e] of this.videos) {
      if (keep.has(id)) continue;
      if (!e.el.paused) e.el.pause();
      if (now - e.lastUsed > EVICT_AFTER_MS) this.release(id, e);
    }
    if (this.videos.size > MAX_VIDEOS) {
      const old = [...this.videos.entries()].filter(([id]) => !keep.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [id, e] of old.slice(0, this.videos.size - MAX_VIDEOS)) this.release(id, e);
    }
  }

  pauseAll(): void {
    for (const e of this.videos.values()) if (!e.el.paused) e.el.pause();
  }

  dispose(): void {
    for (const [id, e] of this.videos) this.release(id, e);
    for (const e of this.images.values()) e.el.removeAttribute('src');
    this.images.clear();
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
      { target, running, speed, tolerance },
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
