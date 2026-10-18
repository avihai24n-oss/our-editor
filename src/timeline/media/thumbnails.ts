/**
 * Video frame thumbnails for the timeline filmstrip: one hidden <video> per asset, frames grabbed
 * by seeking and drawing to a canvas, stored as small JPEG object URLs in an LRU cache.
 * Requests are served newest-first (LIFO), so tiles that just scrolled into view load first.
 * Browser only.
 */
import type { Id } from '../../model/types';

const MAX_ENTRIES = 1500;

/** key → object URL (insertion order = LRU order). */
const cache = new Map<string, string>();
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
}

const grabbers = new Map<Id, Grabber>();

export const thumbKey = (assetId: Id, timeSec: number, height: number): string => `${assetId}@${timeSec.toFixed(3)}@${height}`;

/** Cached thumbnail URL, or undefined. */
export function peekThumb(assetId: Id, timeSec: number, height: number): string | undefined {
  const key = thumbKey(assetId, timeSec, height);
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
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
  if (old && old.url === url) return old;
  if (old) old.video.removeAttribute('src');
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
  const g: Grabber = { url, video, ready, queue: [], busy: false };
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
      if (cache.has(job.key)) {
        settle(job.key, cache.get(job.key)!);
        continue;
      }
      const out = ok ? await grab(g.video, job.time, job.height).catch(() => null) : null;
      if (out) put(job.key, out);
      settle(job.key, out);
    }
  } finally {
    g.busy = false;
  }
}

function settle(key: string, url: string | null): void {
  const list = waiters.get(key);
  waiters.delete(key);
  list?.forEach((r) => r(url));
}

function put(key: string, url: string): void {
  cache.set(key, url);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    URL.revokeObjectURL(cache.get(oldest)!);
    cache.delete(oldest);
  }
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

async function grab(video: HTMLVideoElement, t: number, height: number): Promise<string | null> {
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
  return blob ? URL.createObjectURL(blob) : null;
}

/** Drops the grabber and cached frames of one asset. */
export function forgetThumbs(assetId: Id): void {
  const g = grabbers.get(assetId);
  if (g) g.video.removeAttribute('src');
  grabbers.delete(assetId);
  for (const [k, url] of cache) {
    if (k.startsWith(`${assetId}@`)) {
      URL.revokeObjectURL(url);
      cache.delete(k);
    }
  }
}
