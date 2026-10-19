/**
 * Pure rules for files dragged in from Finder / the desktop: which drags are OS-file drags, which
 * files the editor can import, and the "skipped" message. No DOM, no store — unit-tested in
 * dropFiles.test.ts.
 */
import type { MediaKind } from '../model/types';
import { DND_ASSET_MIME, DND_MIME } from '../timeline/dnd';

const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'm4v'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];

/** Media kind of a file from its MIME type, or its extension when the type is empty / generic. */
export function kindOfFile(file: Pick<File, 'name' | 'type'>): MediaKind | null {
  const type = file.type ?? '';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('image/')) return 'image';
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return null;
}

/**
 * True for a drag that carries files from the OS. Internal drags (asset tiles, text / transition
 * presets) carry our own MIME types — Chrome also lists 'Files' when an <img> is dragged inside the
 * page, so those are excluded explicitly.
 */
export function isOsFileDrag(types: readonly string[] | null | undefined): boolean {
  if (!types) return false;
  const list = Array.from(types);
  return list.includes('Files') && !list.includes(DND_MIME) && !list.includes(DND_ASSET_MIME);
}

/** Splits dropped files into importable media and the rest (kept in drop order). */
export function partitionFiles<F extends Pick<File, 'name' | 'type'>>(files: readonly F[]): { accepted: F[]; skipped: F[] } {
  const accepted: F[] = [];
  const skipped: F[] = [];
  for (const f of files) (kindOfFile(f) ? accepted : skipped).push(f);
  return { accepted, skipped };
}

/** Toast text for files that were not imported, or null when there are none. */
export function skippedMessage(skippedNames: readonly string[], failed: readonly string[] = []): string | null {
  const parts: string[] = [];
  if (skippedNames.length) {
    const shown = skippedNames.slice(0, 3).join(', ');
    const more = skippedNames.length > 3 ? ` and ${skippedNames.length - 3} more` : '';
    parts.push(`Skipped ${skippedNames.length} unsupported file${skippedNames.length > 1 ? 's' : ''}: ${shown}${more}`);
  }
  if (failed.length) parts.push(failed.length === 1 ? failed[0]! : `${failed.length} files could not be read`);
  return parts.length ? `${parts.join('. ')}. Video, audio and image files can be imported.` : null;
}

/**
 * Info text after an import that went through (errors are reported separately): how many files are
 * new, how many were already in the Media pool (not imported twice) and how many lost media got
 * their file back. Null when nothing happened.
 */
export function importSummary(r: { assetIds: readonly string[]; reused: readonly string[]; relinked: readonly string[] }, nameOf: (id: string) => string | undefined = () => undefined): string | null {
  const fresh = r.assetIds.length - r.reused.length - r.relinked.length;
  const parts: string[] = [];
  if (fresh > 0) parts.push(`Imported ${fresh} file${fresh > 1 ? 's' : ''}`);
  if (r.relinked.length) parts.push(`Relinked ${r.relinked.length} lost file${r.relinked.length > 1 ? 's' : ''}`);
  if (r.reused.length) {
    const one = r.reused.length === 1 ? nameOf(r.reused[0]!) : undefined;
    parts.push(one ? `${one} is already in the Media pool` : `${r.reused.length} files are already in the Media pool`);
  }
  return parts.length ? parts.join('. ') : null;
}
