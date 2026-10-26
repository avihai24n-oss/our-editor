/**
 * Export frame (player ⋯ menu): the frame at the playhead as a still image, at the project's full
 * size, drawn by the export renderer (decoded frame-exact, colour grade, LUTs, text — the same
 * pixels the video export would have at that time).
 *
 * Saved into a folder on this Mac through the editor's server (default ~/Downloads; Finder picks
 * another, remembered); without that server the image is downloaded instead.
 */
import { createColorGrader, ensureLuts, getLoadedLut } from '../engine/color';
import { getFrameState } from '../engine/frameState';
import { createLayerProvider, renderFrame } from '../engine/render';
import { allClipsDeep } from '../model/compound';
import { formatTimecode } from '../model/time';
import type { Id, Project, Us } from '../model/types';
import { getBlob } from '../store/persistence';
import { downloadBlob } from './exportMp4';
import { ExportFrameSource } from './frameSource';

export type FrameFormat = 'png' | 'jpeg' | 'webp';

export const FRAME_FORMATS: { id: FrameFormat; label: string; ext: string; mime: string; lossy: boolean }[] = [
  { id: 'png', label: 'PNG (lossless)', ext: 'png', mime: 'image/png', lossy: false },
  { id: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', lossy: true },
  { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', lossy: true },
];
export const formatInfo = (f: FrameFormat) => FRAME_FORMATS.find((x) => x.id === f)!;

/** "<project> 00-00-04-12.png" — the timecode with dashes (":" is not allowed in file names). */
export function frameFileName(projectName: string, t: Us, fps: number, format: FrameFormat): string {
  const base = (projectName.trim() || 'Frame').replace(/[\\/:*?"<>|]+/g, '-');
  return `${base} ${formatTimecode(t, fps).replace(/[:;.]/g, '-')}.${formatInfo(format).ext}`;
}

/** Renders the frame at `t` at the project's size. */
export async function renderStill(project: Project, t: Us): Promise<OffscreenCanvas> {
  await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  const { width, height } = project.settings;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cannot create a drawing surface');
  await ensureLuts(allClipsDeep(project).flatMap((c) => (c.type !== 'audio' && c.grade?.lut.enabled && c.grade.lut.lutId ? [c.grade.lut.lutId] : [])));
  const loadBlob = async (assetId: Id): Promise<Blob | null> => {
    const a = project.assets[assetId];
    return a && !a.missing ? getBlob(a.blobKey).catch(() => null) : null;
  };
  const source = new ExportFrameSource(project, loadBlob);
  const grader = createColorGrader();
  try {
    const fs = getFrameState(project, t);
    await source.prepare(fs);
    renderFrame(ctx, fs, {
      scale: 1,
      sources: source,
      layers: createLayerProvider(),
      grader,
      lutReady: (id: string) => !!getLoadedLut(id),
    });
  } finally {
    grader?.dispose();
    await source.dispose();
  }
  return canvas;
}

export async function encodeStill(canvas: OffscreenCanvas, format: FrameFormat, quality: number): Promise<Blob> {
  const info = formatInfo(format);
  return canvas.convertToBlob({ type: info.mime, quality: info.lossy ? quality : undefined });
}

// ---------------------------------------------------------------- folder

/*
 * Saving goes through the editor's own server (vite-plugins/saveFiles.js): Chrome's folder picker
 * refuses ~/Downloads, ~/Desktop and the like as "system folders", so the server writes the file and
 * macOS's Finder dialog picks the folder. Without that server (a static build) the image downloads.
 */

/** { home, downloads } of this Mac, or null when the server cannot save files. */
export async function saveDefaults(): Promise<{ home: string; downloads: string } | null> {
  try {
    const r = await fetch('/__save/defaults');
    return r.ok ? ((await r.json()) as { home: string; downloads: string }) : null;
  } catch {
    return null;
  }
}

/** Finder's "choose folder", starting at `start`. The chosen path, or null when cancelled. */
export async function chooseFolder(start: string): Promise<string | null> {
  const r = await fetch(`/__save/choose-folder?start=${encodeURIComponent(start)}`, { method: 'POST' });
  const j = (await r.json()) as { path?: string };
  return j.path ?? null;
}

/** Writes the file into `dir` (never overwrites: "x (2).png"). Returns the full path written. */
export async function saveToFolder(dir: string, name: string, blob: Blob): Promise<string> {
  const r = await fetch(`/__save/file?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: 'PUT', body: blob });
  const j = (await r.json()) as { path?: string; error?: string };
  if (!r.ok || !j.path) throw new Error(j.error ?? `Could not save (${r.status})`);
  return j.path;
}

/** "~/Downloads/Frames" for display. */
export const tildePath = (p: string, home: string): string => (home && (p === home || p.startsWith(home + '/')) ? `~${p.slice(home.length)}` : p);

export { downloadBlob };
