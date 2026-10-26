/**
 * Caption UI actions: every edit goes through `useEditor.getState().editProject` (one undo step,
 * normalize, locked tracks respected). The transcription job lives in a tiny store of its own so
 * it survives switching tabs.
 */
import { create } from 'zustand';
import { useEditor } from '../../store';
import { downloadBlob, saveDefaults, saveToFolder, tildePath } from '../../export/exportFrame';
import { showToast } from '../../ui/appEvents';
import type { Id, Project, Us } from '../../model/types';
import type { EditCtx } from '../../store/ops';
import { DEFAULT_GROUPING, type GroupOptions } from '../model';
import * as cops from '../ops';
import { parseSubtitles, parseWordJson, toSrt, toVtt, toWordJson } from '../srt';
import { TranscribeCanceled, transcribeTimeline, type CaptionLanguage, type TranscribeProgress } from '../transcribe';
import type { CaptionStyle } from '../types';

export function edit<T>(fn: (d: Project, ctx: EditCtx) => T): T {
  return useEditor.getState().editProject(fn);
}

export interface JobState {
  running: boolean;
  progress: TranscribeProgress | null;
  error: string | null;
  /** Message after the last finished run. */
  done: string | null;
  abort: AbortController | null;
}

export const useCaptionJob = create<JobState>(() => ({ running: false, progress: null, error: null, done: null, abort: null }));

const LANG_NAMES: Record<string, string> = { he: 'Hebrew', en: 'English' };

export interface AutoCaptionRequest {
  lang: CaptionLanguage;
  range: { start: Us; end: Us };
  onlyClipIds?: Id[];
  grouping: Partial<GroupOptions>;
  /** Style for a caption track created by this run. */
  style?: CaptionStyle;
}

/** Runs whisper on the range and places the captions (replacing the captions in that range only). */
export async function runAutoCaptions(req: AutoCaptionRequest): Promise<void> {
  if (useCaptionJob.getState().running) return;
  const abort = new AbortController();
  useCaptionJob.setState({ running: true, progress: { phase: 'mixing', fraction: 0 }, error: null, done: null, abort });
  try {
    const project = useEditor.getState().project;
    const res = await transcribeTimeline({
      project,
      range: req.range,
      lang: req.lang,
      onlyClipIds: req.onlyClipIds,
      signal: abort.signal,
      onProgress: (progress) => useCaptionJob.setState({ progress }),
    });
    if (!res.words.length) throw new Error('No speech was found in that range.');
    const grouping = { ...DEFAULT_GROUPING, ...req.grouping };
    const fps = useEditor.getState().project.settings.fps;
    const ids = edit((d) => cops.placeTranscription(d, res.words, res.range, grouping, { language: res.language ?? req.lang, minUs: Math.ceil(1e6 / fps), style: req.style }));
    const lang = LANG_NAMES[res.language ?? ''] ?? res.language ?? '';
    useCaptionJob.setState({ running: false, progress: null, abort: null, done: `${ids.length} captions · ${res.words.length} words${lang ? ` · ${lang}` : ''}` });
    if (ids[0]) useEditor.getState().select([ids[0]]);
  } catch (e) {
    const canceled = e instanceof TranscribeCanceled || abort.signal.aborted;
    useCaptionJob.setState({ running: false, progress: null, abort: null, error: canceled ? null : e instanceof Error ? e.message : String(e), done: canceled ? 'Canceled' : null });
  }
}

export const cancelAutoCaptions = () => useCaptionJob.getState().abort?.abort();

// ---------------------------------------------------------------- files

export async function importCaptionFile(file: File): Promise<number> {
  const text = await file.text();
  const cues = parseWordJson(text) ?? parseSubtitles(text);
  if (!cues.length) {
    showToast(`No captions found in ${file.name}`);
    return 0;
  }
  const ids = edit((d) => cops.importCues(d, cues));
  showToast(`${ids.length} captions imported from ${file.name}`);
  if (ids[0]) useEditor.getState().select([ids[0]]);
  return ids.length;
}

export type CaptionFileFormat = 'srt' | 'vtt' | 'json';

/** Builds the caption file text for the caption track(s). */
export function captionFileText(format: CaptionFileFormat, trackId?: Id): string {
  const p = useEditor.getState().project;
  const cues = cops.captionCues(p, trackId);
  if (format === 'srt') return toSrt(cues);
  if (format === 'vtt') return toVtt(cues);
  const lang = p.tracks.find((t) => t.id === trackId)?.captions?.language;
  return JSON.stringify(toWordJson(cues, lang), null, 2);
}

/** Saves the captions as a file in ~/Downloads (the editor's server), else downloads it. */
export async function exportCaptionFile(format: CaptionFileFormat, trackId?: Id): Promise<string> {
  const p = useEditor.getState().project;
  const text = captionFileText(format, trackId);
  const name = `${(p.name || 'captions').replace(/[/\\:\0]/g, '-')} captions.${format === 'json' ? 'words.json' : format}`;
  const blob = new Blob([format === 'json' ? text : '﻿' + text], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' });
  const dirs = await saveDefaults();
  if (dirs) {
    try {
      const path = await saveToFolder(dirs.downloads, name, blob);
      showToast(`Saved ${tildePath(path, dirs.home)}`);
      return path;
    } catch {
      /* fall back to a download */
    }
  }
  downloadBlob(blob, name);
  return name;
}

// ---------------------------------------------------------------- style

export const setTrackStyle = (trackId: Id, style: Partial<CaptionStyle>) => edit((d) => cops.setCaptionTrack(d, trackId, { style }));
export const setBurnIn = (trackId: Id, burnIn: boolean) => edit((d) => cops.setCaptionTrack(d, trackId, { burnIn }));
export const applyCaptionPreset = (trackId: Id, presetId: string) => edit((d) => cops.applyPreset(d, trackId, presetId));
/** Makes sure there is a caption track (for applying a style before any caption exists). */
export const ensureCaptionTrack = (style?: CaptionStyle): Id => edit((d) => cops.ensureCaptionTrack(d, style).id);

/** Regroups the track's captions to `maxWords` / `maxChars` (word timings kept). */
export function resplit(trackId: Id, maxWords: number, maxChars: number): number {
  const fps = useEditor.getState().project.settings.fps;
  const ids = edit((d) => cops.resplitCaptions(d, trackId, { ...DEFAULT_GROUPING, maxWords, maxChars }, Math.ceil(1e6 / fps)));
  if (ids[0]) useEditor.getState().select([ids[0]]);
  return ids.length;
}
