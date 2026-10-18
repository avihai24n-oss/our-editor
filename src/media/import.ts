/**
 * File → MediaAsset. Probes metadata, stores the blob in IndexedDB, registers an object URL.
 * Browser-only (uses DOM media elements / Mediabunny).
 */
import { createAsset } from '../model/defaults';
import { secToUs } from '../model/time';
import type { Id, MediaAsset, MediaKind, Project } from '../model/types';
import { getBlob, hasBlob, putBlob } from '../store/persistence';
import { registerAssetUrl } from './registry';

export function kindOfFile(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return 'image';
  return null;
}

interface Probe {
  duration: number; // seconds
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

function probeImage(url: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ duration: 0, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Cannot read image'));
    img.src = url;
  });
}

function probeElement(url: string, kind: 'video' | 'audio'): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind);
    el.preload = 'metadata';
    el.muted = true;
    const timer = setTimeout(() => reject(new Error('Timed out reading media')), 15000);
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      const v = el as HTMLVideoElement;
      resolve({
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        width: kind === 'video' ? v.videoWidth : undefined,
        height: kind === 'video' ? v.videoHeight : undefined,
        hasAudio: kind === 'audio' ? true : undefined,
      });
      el.removeAttribute('src');
      el.load();
    };
    el.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Cannot read media'));
    };
    el.src = url;
  });
}

/** Mediabunny gives exact duration + audio-track presence; the element is the fallback. */
async function probeWithMediabunny(file: File): Promise<Probe | null> {
  try {
    const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny');
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const duration = await input.computeDuration();
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    return { duration, width: v?.displayWidth, height: v?.displayHeight, hasAudio: !!a };
  } catch {
    return null;
  }
}

export async function importFile(file: File): Promise<MediaAsset> {
  const kind = kindOfFile(file);
  if (!kind) throw new Error(`Unsupported file: ${file.name}`);
  const tmpUrl = URL.createObjectURL(file);
  let probe: Probe;
  try {
    if (kind === 'image') probe = await probeImage(tmpUrl);
    else {
      const mb = await probeWithMediabunny(file);
      const el = await probeElement(tmpUrl, kind).catch(() => null);
      if (!mb && !el) throw new Error(`Cannot read ${file.name}`);
      probe = {
        duration: mb?.duration || el?.duration || 0,
        width: mb?.width ?? el?.width,
        height: mb?.height ?? el?.height,
        hasAudio: mb ? mb.hasAudio : true,
      };
    }
  } finally {
    URL.revokeObjectURL(tmpUrl);
  }
  const asset = createAsset({
    kind,
    name: file.name,
    mime: file.type,
    size: file.size,
    duration: kind === 'image' ? 0 : secToUs(probe.duration),
    width: probe.width,
    height: probe.height,
    hasAudio: kind === 'image' ? false : probe.hasAudio,
  });
  // The blob is written ONCE: re-importing the same file this session reuses the stored copy
  // instead of writing the whole file to IndexedDB again.
  const sig = fileSignature(file);
  const known = storedBySignature.get(sig);
  let reused = false;
  if (known) {
    try {
      reused = await hasBlob(known);
    } catch {
      reused = false;
    }
  }
  if (reused && known) {
    asset.blobKey = known;
  } else {
    try {
      await putBlob(asset.blobKey, file);
      storedBySignature.set(sig, asset.blobKey);
    } catch (e) {
      console.warn('Could not persist media blob; it will be lost on reload', e);
    }
  }
  registerAssetUrl(asset.id, file);
  return asset;
}

/** name|size|lastModified → blobKey of a copy already written this session. */
const storedBySignature = new Map<string, Id>();
const fileSignature = (f: File): string => `${f.name}|${f.size}|${f.lastModified}`;

/** The stored copy is being deleted: the next import of that file writes it again. */
export function forgetStoredBlob(key: Id): void {
  for (const [sig, k] of storedBySignature) if (k === key) storedBySignature.delete(sig);
}

/** Imports several files; failures are reported, successes returned. */
export async function importFiles(files: Iterable<File>): Promise<{ assets: MediaAsset[]; errors: string[] }> {
  const assets: MediaAsset[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      assets.push(await importFile(f));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { assets, errors };
}

/** After loading a project: re-create object URLs from stored blobs. Returns ids of lost media. */
export async function restoreAssetUrls(project: Project): Promise<Id[]> {
  const missing: Id[] = [];
  for (const asset of Object.values(project.assets)) {
    try {
      const blob = await getBlob(asset.blobKey);
      if (blob) registerAssetUrl(asset.id, blob);
      else missing.push(asset.id);
    } catch {
      missing.push(asset.id);
    }
  }
  return missing;
}
