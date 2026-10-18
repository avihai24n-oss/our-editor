/**
 * Export options and the pure maths behind them (output size, bitrate, size estimate, file name).
 */

export type ResolutionId = '720p' | '1080p' | '2k' | '4k';
export type QualityId = 'lower' | 'recommended' | 'higher';
export type ExportFps = 24 | 25 | 30 | 50 | 60;

/** Resolution = the SHORT side of the output, like CapCut (9:16 1080p = 1080×1920). */
export const RESOLUTIONS: { id: ResolutionId; label: string; short: number }[] = [
  { id: '720p', label: '720p', short: 720 },
  { id: '1080p', label: '1080p', short: 1080 },
  { id: '2k', label: '2K', short: 1440 },
  { id: '4k', label: '4K', short: 2160 },
];

export const FRAME_RATES: ExportFps[] = [24, 25, 30, 50, 60];

/** Bits per pixel per frame. */
export const QUALITIES: { id: QualityId; label: string; bpp: number }[] = [
  { id: 'lower', label: 'Lower', bpp: 0.05 },
  { id: 'recommended', label: 'Recommended', bpp: 0.1 },
  { id: 'higher', label: 'Higher', bpp: 0.17 },
];

export const AUDIO_BITRATE = 192_000;

export interface ExportSettings {
  fileName: string;
  resolution: ResolutionId;
  fps: ExportFps;
  quality: QualityId;
}

export const defaultExportSettings = (projectName: string, projectFps: number): ExportSettings => ({
  fileName: projectName,
  resolution: '1080p',
  fps: (FRAME_RATES as number[]).includes(projectFps) ? (projectFps as ExportFps) : 30,
  quality: 'recommended',
});

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output pixel size for a project canvas W×H at a resolution (short side), even numbers (H.264). */
export function outputSize(projectW: number, projectH: number, resolution: ResolutionId): { width: number; height: number } {
  const short = RESOLUTIONS.find((r) => r.id === resolution)?.short ?? 1080;
  const k = short / Math.min(projectW, projectH);
  return { width: even(projectW * k), height: even(projectH * k) };
}

export function videoBitrate(width: number, height: number, fps: number, quality: QualityId): number {
  const bpp = QUALITIES.find((q) => q.id === quality)?.bpp ?? 0.1;
  return Math.round(Math.min(80e6, Math.max(1e6, width * height * fps * bpp)));
}

/** Rough size estimate in bytes (VBR target, so real files are usually smaller). */
export function estimateBytes(durationUs: number, vBitrate: number, withAudio: boolean): number {
  const sec = durationUs / 1e6;
  return Math.round(((vBitrate + (withAudio ? AUDIO_BITRATE : 0)) * sec) / 8);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Safe file name with the right extension. */
export function exportFileName(name: string, ext: 'mp4' | 'webm'): string {
  const base = name
    .replace(/\.(mp4|webm|mov)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${base || 'Untitled'}.${ext}`;
}

/** Number of frames for a duration (the last partial frame counts). */
export const frameCount = (durationUs: number, fps: number): number => Math.max(0, Math.ceil((durationUs * fps) / 1e6 - 1e-6));
