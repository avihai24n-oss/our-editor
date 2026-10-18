/**
 * Media-bin thumbnails. Images use their object URL directly; videos get one poster frame
 * (grabbed at ~10 % of the clip, max 1 s) drawn to a small canvas, cached per asset id.
 * Decoding runs one video at a time so a big import does not open dozens of decoders.
 *
 * Lives in src/panels because this builder may only write there; the timeline can import
 * `getVideoThumb` too (read-only use).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { ByteLRU } from '../media/lru';
import { MEMORY_LIMITS, registerCache } from '../media/memory';
import { getAssetUrl, onAssetUrlsChange } from '../media/registry';
import type { Id, MediaAsset } from '../model/types';

/** assetId → data URL ('' = failed), byte-budgeted (MEMORY_LIMITS.posterBytes). */
const thumbs = new ByteLRU<string>({ maxBytes: MEMORY_LIMITS.posterBytes });
registerCache('posters', () => thumbs.clear(), () => ({ entries: thumbs.size, bytes: thumbs.bytes }));

/** Drops one asset's poster (asset removed). */
export function forgetPoster(assetId: Id): void {
  thumbs.delete(assetId);
}
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let queue: Promise<void> = Promise.resolve();

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const off = onAssetUrlsChange(() => {
    version++;
    fn();
  });
  return () => {
    listeners.delete(fn);
    off();
  };
}

const getVersion = () => version;

function grabFrame(url: string, durationSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    const timer = setTimeout(() => done(new Error('thumbnail timeout')), 10000);
    const done = (err: Error | null, data?: string) => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      if (err) reject(err);
      else resolve(data ?? '');
    };
    v.onloadeddata = () => {
      const t = Math.min(1, Math.max(0, durationSec * 0.1));
      if (t <= 0.01) draw();
      else v.currentTime = t;
    };
    v.onseeked = () => draw();
    v.onerror = () => done(new Error('cannot decode'));
    function draw() {
      try {
        const w = 240;
        const h = Math.max(1, Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16)));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')?.drawImage(v, 0, 0, w, h);
        const data = c.toDataURL('image/jpeg', 0.75);
        c.width = 0;
        c.height = 0;
        done(null, data);
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    }
    v.src = url;
  });
}

/** Cached poster for a video asset, or undefined (requests one in the background). */
export function getVideoThumb(asset: Pick<MediaAsset, 'id' | 'duration'>): string | undefined {
  const hit = thumbs.get(asset.id);
  if (hit !== undefined) return hit || undefined;
  const url = getAssetUrl(asset.id);
  if (!url || pending.has(asset.id) || typeof document === 'undefined') return undefined;
  pending.add(asset.id);
  queue = queue
    .then(() => grabFrame(url, asset.duration / 1e6))
    .then(
      (data) => void thumbs.set(asset.id, data, data.length * 2),
      () => void thumbs.set(asset.id, '', 0),
    )
    .finally(() => {
      pending.delete(asset.id);
      notify();
    });
  return undefined;
}

/** Thumbnail URL for any asset kind (audio → undefined; the tile draws a waveform). */
export function useAssetThumb(asset: Pick<MediaAsset, 'id' | 'kind' | 'duration' | 'missing'> | undefined): string | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const id = asset?.id;
  useEffect(() => {
    // drop a failed cache entry when the URL comes back (e.g. after restore)
    if (id && thumbs.get(id) === '' && getAssetUrl(id)) thumbs.delete(id);
  }, [id]);
  if (!asset || asset.missing) return undefined;
  if (asset.kind === 'image') return getAssetUrl(asset.id);
  if (asset.kind === 'video') return getVideoThumb(asset);
  return undefined;
}
