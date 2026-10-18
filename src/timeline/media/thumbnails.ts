/**
 * Video frame thumbnails for the timeline filmstrip: a hidden <video> per asset grabs frames by
 * seeking and drawing to a canvas; they are stored as small JPEG object URLs in a byte-budgeted
 * LRU (MEMORY_LIMITS.thumbBytes). Requests are served newest-first (LIFO), so tiles that just
 * scrolled into view load first.
 *
 * Memory rules: the grabber <video> (a decoder) only lives while it has work — it is released
 * MEMORY_LIMITS.grabberIdleMs after its queue drains, and recreated on the next request. Evicted
 * thumbnails have their object URL revoked. Browser only.
 */
import { ByteLRU } from '../../media/lru';
import { MEMORY_LIMITS, registerCache } from '../../media/memory';
import type { Id } from '../../model/types';

/** key → object URL. */
const cache = new ByteLRU<string>({
  maxBytes: MEMORY_LIMITS.thumbBytes,
  maxEntries: MEMORY_LIMITS.thumbEntries,
  onEvict: (_k, url) => URL.revokeObjectURL(url),
});
const waiters = new Map<string, ((url: string | null) => void)[]>();

interface Job {
  key: string;
  time: number;
  height: number;
}

interface Grabber {
  url: string;
  video: HTMLVideoElement;
  ready: Promise<boolean>;
  queue: Job[];
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const grabbers = new Map<Id, Grabber>();

export const thumbKey = (assetId: Id, timeSec: number, height: number): string => `${assetId}@${timeSec.toFixed(3)}@${height}`;

/** Cached thumbnail URL, or undefined. */
export function peekThumb(assetId: Id, timeSec: number, height: number): string | undefined {
  return cache.get(thumbKey(assetId, timeSec, height));
}

/** Resolves an object URL of the frame at `timeSec` (already quantised by the caller), or null. */
export function getThumb(assetId: Id, url: string, timeSec: number, height: number): Promise<string | null> {
  const key = thumbKey(assetId, timeSec, height);
  const hit = peekThumb(assetId, timeSec, height);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const list = waiters.get(key);
    if (list) {
      list.push(resolve);
      return;
    }
    waiters.set(key, [resolve]);
    const g = grabberFor(assetId, url);
    g.queue.push({ key, time: timeSec, height });
    void pump(g);
  });
}

function grabberFor(assetId: Id, url: string): Grabber {
  const old = grabbers.get(assetId);
  if (old && old.url === url) {
    if (old.idleTimer) clearTimeout(old.idleTimer);
    old.idleTimer = null;
    return old;
  }
  if (old) releaseGrabber(assetId, old);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  const ready = new Promise<boolean>((resolve) => {
    video.addEventListener('loadeddata', () => resolve(true), { once: true });
    video.addEventListener('error', () => resolve(false), { once: true });
  });
  video.src = url;
  const g: Grabber = { url, video, ready, queue: [], busy: false, idleTimer: null };
  grabbers.set(assetId, g);
  return g;
}

async function pump(g: Grabber): Promise<void> {
  if (g.busy) return;
  g.busy = true;
  try {
    const ok = await g.ready;
    while (g.queue.length) {
      const job = g.queue.pop()!; // LIFO: newest request first
      const hit = cache.get(job.key);
      if (hit) {
        settle(job.key, hit);
        continue;
      }
      const out = ok ? await grab(g.video, job.time, job.height).catch(() => null) : null;
      const stored = out && cache.set(job.key, out.url, out.bytes) ? out.url : null;
      settle(job.key, stored);
    }
  } finally {
    g.busy = false;
    scheduleRelease(g);
  }
}

/** Frees the grabber's decoder once it has had no work for a moment. */
function scheduleRelease(g: Grabber): void {
  if (g.idleTimer) clearTimeout(g.idleTimer);
  g.idleTimer = setTimeout(() => {
    g.idleTimer = null;
    if (g.busy || g.queue.length) return;
    for (const [id, x] of grabbers) if (x === g) releaseGrabber(id, g);
  }, MEMORY_LIMITS.grabberIdleMs);
}

function releaseGrabber(assetId: Id, g: Grabber): void {
  if (g.idleTimer) clearTimeout(g.idleTimer);
  g.idleTimer = null;
  g.video.removeAttribute('src');
  g.video.load(); // without load() the element keeps the old resource (and its decoder)
  if (grabbers.get(assetId) === g) grabbers.delete(assetId);
}

/** Live grabber elements (for tests and the debug readout). */
export const liveGrabbers = (): number => grabbers.size;

function settle(key: string, url: string | null): void {
  const list = waiters.get(key);
  waiters.delete(key);
  list?.forEach((r) => r(url));
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = Math.min(Math.max(0, t), Math.max(0, (video.duration || 0) - 0.04));
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('seek timeout'));
    }, 5000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('video error'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = target;
  });
}

async function grab(video: HTMLVideoElement, t: number, height: number): Promise<{ url: string; bytes: number } | null> {
  await seek(video, t);
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const h = Math.max(8, Math.round(height * dpr));
  const w = Math.max(8, Math.round((h * vw) / vh));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.7));
  // free the canvas backing store now rather than at the next GC
  canvas.width = 0;
  canvas.height = 0;
  // the JPEG blob plus the decoded bitmap the browser keeps for a visible tile
  return blob ? { url: URL.createObjectURL(blob), bytes: blob.size + w * h * 4 } : null;
}

/** Drops the grabber and cached frames of one asset. */
export function forgetThumbs(assetId: Id): void {
  const g = grabbers.get(assetId);
  if (g) releaseGrabber(assetId, g);
  cache.deleteWhere((k) => k.startsWith(`${assetId}@`));
}

/** Drops every cached thumbnail and idle grabber (memory watchdog). Visible tiles re-request. */
export function flushThumbs(): void {
  cache.clear();
  for (const [id, g] of [...grabbers]) if (!g.busy && !g.queue.length) releaseGrabber(id, g);
}

registerCache('filmstrip', flushThumbs, () => ({ entries: cache.size, bytes: cache.bytes }));
