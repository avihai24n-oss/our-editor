/**
 * Frees what is cached for an asset.
 * - When it leaves the current document (deleted from the bin): its timeline thumbnails, library
 *   poster and waveform peaks. They are rebuilt on demand if ⌘Z brings the asset back.
 * - When no undo / redo step can bring it back any more (`onAssetRemoved`): also its object URL
 *   and its stored blob (unless another live asset shares the blob).
 * Installed once from main.tsx.
 */
import { forgetPoster } from '../panels/thumbnails';
import { liveAssets, onAssetRemoved, useEditor } from '../store';
import { deleteBlob } from '../store/persistence';
import { forgetThumbs } from '../timeline/media/thumbnails';
import { forgetPeaks } from '../timeline/media/waveform';
import { forgetStoredBlob } from './import';
import { revokeAssetUrl } from './registry';

let installed = false;

function forgetCaches(assetId: string): void {
  forgetThumbs(assetId);
  forgetPoster(assetId);
  forgetPeaks(assetId);
}

export function installAssetCleanup(): void {
  if (installed) return;
  installed = true;
  useEditor.subscribe((s, prev) => {
    if (s.project.assets === prev.project.assets) return;
    for (const id of Object.keys(prev.project.assets)) if (!s.project.assets[id]) forgetCaches(id);
  });
  onAssetRemoved((assetId, asset) => {
    forgetCaches(assetId);
    revokeAssetUrl(assetId);
    const key = asset?.blobKey;
    if (!key) return;
    const stillUsed = [...liveAssets().values()].some((a) => a.blobKey === key);
    if (!stillUsed) {
      forgetStoredBlob(key);
      void deleteBlob(key).catch(() => undefined);
    }
  });
}
