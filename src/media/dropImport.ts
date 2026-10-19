/**
 * Importing files dropped from the OS. Both entry points go through the store's `importFiles` —
 * the same path as the Import button — so thumbnails, durations and persistence are identical.
 *
 * - `importDroppedFiles`: filter + import + toast for what was skipped. Used by the timeline
 *   (which then places the clips at the drop point).
 * - `importToMediaPool`: a drop anywhere else. Also switches the library to the Media tab and
 *   briefly highlights the new tiles.
 */
import type { Id } from '../model/types';
import { useEditor } from '../store';
import { emitAppEvent, requestAssetHighlight, showToast } from '../ui/appEvents';
import { importSummary, partitionFiles, skippedMessage } from './dropFiles';

export async function importDroppedFiles(files: readonly File[]): Promise<Id[]> {
  const { accepted, skipped } = partitionFiles(files);
  let assetIds: Id[] = [];
  let errors: string[] = [];
  let reused: Id[] = [];
  let relinked: Id[] = [];
  if (accepted.length) {
    try {
      ({ assetIds, errors, reused, relinked } = await useEditor.getState().importFiles(accepted));
    } catch (e) {
      errors = [e instanceof Error ? e.message : 'Import failed'];
    }
  }
  const msg = skippedMessage(
    skipped.map((f) => f.name),
    errors,
  );
  if (msg) showToast(msg);
  else {
    const info = importSummary({ assetIds, reused, relinked }, (id) => useEditor.getState().project.assets[id]?.name);
    if (info) showToast(info);
  }
  return assetIds;
}

export async function importToMediaPool(files: readonly File[]): Promise<Id[]> {
  emitAppEvent('libraryShow', { tab: 'media' });
  const ids = await importDroppedFiles(files);
  if (ids.length) requestAssetHighlight(ids);
  return ids;
}
