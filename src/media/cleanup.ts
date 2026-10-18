/**
 * Frees everything cached for an asset once it leaves the media bin: timeline thumbnails,
 * waveform peaks, its object URL and its stored blob. Installed once from main.tsx.
 */
import { onAssetRemoved, useEditor } from '../store';
import { deleteBlob } from '../store/persistence';
import { forgetThumbs } from '../timeline/media/thumbnails';
import { forgetPeaks } from '../timeline/media/waveform';
import { revokeAssetUrl } from './registry';

let installed = false;

export function installAssetCleanup(): void {
  if (installed) return;
  installed = true;
  onAssetRemoved((assetId, asset) => {
    forgetThumbs(assetId);
    forgetPeaks(assetId);
    revokeAssetUrl(assetId);
    // Only delete the blob when no other asset still points at the same key.
    const key = asset?.blobKey;
    if (!key) return;
    const stillUsed = Object.values(useEditor.getState().project.assets).some((a) => a.blobKey === key);
    if (!stillUsed) void deleteBlob(key).catch(() => undefined);
  });
}
