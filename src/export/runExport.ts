/**
 * The export pipeline: offline audio mix → frame-by-frame render from getFrameState (the same
 * compositor as the player) → MP4 via WebCodecs (or WebM via MediaRecorder as a fallback).
 * Loaded lazily by the dialog so Mediabunny stays out of the main bundle.
 */
import { createColorGrader, ensureLuts, getLoadedLut } from '../engine/color';
import { getFrameState } from '../engine/frameState';
import { createLayerProvider, renderFrame } from '../engine/render';
import { projectDuration } from '../model/time';
import type { Id, Project } from '../model/types';
import { getBlob } from '../store/persistence';
import { ExportCanceled, exportMp4, probeCodecs, type EncodeResult } from './exportMp4';
import { ElementFrameSource, exportWebm, pickRecorderMime } from './exportWebm';
import { ExportFrameSource } from './frameSource';
import { createDecoder, renderMix } from './offlineMix';
import { AUDIO_BITRATE, outputSize, videoBitrate, type ExportSettings } from './settings';

export type ExportPhase = 'preparing' | 'audio' | 'video' | 'finishing';

export interface ExportProgress {
  phase: ExportPhase;
  /** 0..1 over the whole job. */
  fraction: number;
  frame: number;
  frames: number;
}

export interface RunExportOptions {
  project: Project;
  settings: ExportSettings;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
  /** Testing / compatibility: skip WebCodecs and record WebM. */
  forceWebm?: boolean;
}

export interface RunExportResult extends EncodeResult {
  width: number;
  height: number;
  /** True when the MediaRecorder fallback was used. */
  fallback: boolean;
}

export async function runExport(o: RunExportOptions): Promise<RunExportResult> {
  const { project, settings } = o;
  const durationUs = projectDuration(project);
  if (durationUs <= 0) throw new Error('The timeline is empty — add media before exporting.');
  const { width, height } = outputSize(project.settings.width, project.settings.height, settings.resolution);
  const vBitrate = videoBitrate(width, height, settings.fps, settings.quality);
  const report = (p: ExportProgress) => o.onProgress?.(p);
  report({ phase: 'preparing', fraction: 0, frame: 0, frames: 0 });

  // fonts must be ready before frame 0 or text renders in a fallback face
  await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;

  const loadBlob = async (assetId: Id): Promise<Blob | null> => {
    const a = project.assets[assetId];
    if (!a || a.missing) return null;
    return getBlob(a.blobKey).catch(() => null);
  };

  // ---- audio
  report({ phase: 'audio', fraction: 0.01, frame: 0, frames: 0 });
  const audio = await renderMix(project, durationUs, createDecoder(loadBlob), o.signal);
  if (o.signal?.aborted) throw new ExportCanceled();

  // ---- video
  const codecs = o.forceWebm ? { video: null, audio: null } : await probeCodecs({ width, height, fps: settings.fps, videoBitrate: vBitrate, audioBitrate: AUDIO_BITRATE });
  const useMp4 = !!codecs.video;
  if (!useMp4 && !pickRecorderMime()) {
    throw new Error('This browser cannot export video. Use a recent Chrome or Edge.');
  }
  const scale = width / project.settings.width;
  const layers = createLayerProvider();
  // the colour pass needs every LUT the timeline uses in memory before frame 0
  await ensureLuts(
    project.tracks.flatMap((t) => t.clips).flatMap((c) => (c.type !== 'audio' && c.grade?.lut.enabled && c.grade.lut.lutId ? [c.grade.lut.lutId] : [])),
  );
  const grader = createColorGrader();
  const lutReady = (id: string) => !!getLoadedLut(id);
  const source = useMp4 ? new ExportFrameSource(project, loadBlob) : new ElementFrameSource(project);
  const AUDIO_SHARE = 0.03;
  try {
    const enc = {
      width,
      height,
      fps: settings.fps,
      durationUs,
      videoBitrate: vBitrate,
      audioBitrate: AUDIO_BITRATE,
      audio,
      signal: o.signal,
      render: async (ctx: Parameters<typeof renderFrame>[0], t: number) => {
        const fs = getFrameState(project, t);
        await source.prepare(fs);
        renderFrame(ctx, fs, { scale, sources: source, layers, grader, lutReady });
      },
      onProgress: (p: { frame: number; frames: number; fraction: number }) =>
        report({ phase: p.frame >= p.frames ? 'finishing' : 'video', fraction: AUDIO_SHARE + p.fraction * (1 - AUDIO_SHARE) * 0.99, frame: p.frame, frames: p.frames }),
    };
    const result = useMp4 ? await exportMp4(enc, codecs) : await exportWebm(enc);
    report({ phase: 'finishing', fraction: 1, frame: 0, frames: 0 });
    return { ...result, width, height, fallback: !useMp4 };
  } finally {
    grader?.dispose();
    await source.dispose();
  }
}
