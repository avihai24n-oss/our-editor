/**
 * Runtime registry: assetId → object URL. Lives outside the document (URLs are not JSON-stable).
 * The player, media bin and exporter read URLs through `getAssetUrl`.
 */
import type { Id } from '../model/types';

const urls = new Map<Id, string>();
/** The Blob behind each URL, so readers (waveform peaks) can stream it instead of fetching a copy. */
const blobs = new Map<Id, Blob>();
const listeners = new Set<() => void>();

export function registerAssetUrl(assetId: Id, blob: Blob): string {
  const old = urls.get(assetId);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  urls.set(assetId, url);
  blobs.set(assetId, blob);
  listeners.forEach((l) => l());
  return url;
}

export const getAssetUrl = (assetId: Id): string | undefined => urls.get(assetId);
export const getAssetBlob = (assetId: Id): Blob | undefined => blobs.get(assetId);
/** Number of live object URLs (debug readout). */
export const liveAssetUrls = (): number => urls.size;

export function revokeAssetUrl(assetId: Id): void {
  const u = urls.get(assetId);
  if (u) URL.revokeObjectURL(u);
  urls.delete(assetId);
  blobs.delete(assetId);
  listeners.forEach((l) => l());
}

export function revokeAllAssetUrls(): void {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  blobs.clear();
  listeners.forEach((l) => l());
}

/** Subscribe to URL changes (for components that render <video>/<img> from assets). */
export function onAssetUrlsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
