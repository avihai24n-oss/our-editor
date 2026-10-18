import { useSyncExternalStore } from 'react';
import { getAssetUrl, onAssetUrlsChange } from '../../media/registry';
import type { Id } from '../../model/types';

const subscribe = (fn: () => void) => {
  const off = onAssetUrlsChange(fn);
  return () => void off();
};

/** The asset's object URL, re-rendering when the registry changes. */
export function useAssetUrl(assetId: Id | undefined): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (assetId ? getAssetUrl(assetId) : undefined),
    () => undefined,
  );
}
