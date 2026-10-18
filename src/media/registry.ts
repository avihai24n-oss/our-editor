/**
 * Runtime registry: assetId → object URL. Lives outside the document (URLs are not JSON-stable).
 * The player, media bin and exporter read URLs through `getAssetUrl`.
 */
import type { Id } from '../model/types';

const urls = new Map<Id, string>();
const listeners = new Set<() => void>();

export function registerAssetUrl(assetId: Id, blob: Blob): string {
  const old = urls.get(assetId);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  urls.set(assetId, url);
  listeners.forEach((l) => l());
  return url;
}

export const getAssetUrl = (assetId: Id): string | undefined => urls.get(assetId);

export function revokeAssetUrl(assetId: Id): void {
  const u = urls.get(assetId);
  if (u) URL.revokeObjectURL(u);
  urls.delete(assetId);
  listeners.forEach((l) => l());
}

export function revokeAllAssetUrls(): void {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  listeners.forEach((l) => l());
}

/** Subscribe to URL changes (for components that render <video>/<img> from assets). */
export function onAssetUrlsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
