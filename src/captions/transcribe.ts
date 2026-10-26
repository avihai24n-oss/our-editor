/**
 * Auto captions from the timeline: renders what you hear in a range with the export's offline
 * mix (src/export/offlineMix.ts renderMix), sends it as 16 kHz mono WAV to the editor's server
 * (vite-plugins/transcribe.js → whisper.cpp), polls the job, and turns the result into words
 * on the timeline (range start + whisper time, µs). Browser only.
 */
import { createDecoder, renderMix } from '../export/offlineMix';
import { clipEnd, projectDuration } from '../model/time';
import type { Id, Project, Us } from '../model/types';
import { getBlob } from '../store/persistence';
import { encodeWav, downmix, resample } from './wav';
import { parseWhisperJson, whisperLanguage, type WhisperJson } from './whisper';
import type { CaptionWord } from './types';

export type CaptionLanguage = 'he' | 'en' | 'auto';

export const LANGUAGE_OPTIONS: { id: CaptionLanguage; label: string }[] = [
  { id: 'he', label: 'Hebrew' },
  { id: 'en', label: 'English' },
  { id: 'auto', label: 'Auto-detect' },
];

export interface TranscribeProgress {
  phase: 'mixing' | 'uploading' | 'transcribing' | 'done';
  /** 0..1 over the whole job. */
  fraction: number;
}

export interface TranscribeResult {
  words: CaptionWord[];
  language?: string;
  range: { start: Us; end: Us };
}

export class TranscribeCanceled extends Error {
  constructor() {
    super('Canceled');
  }
}

export interface ServerInfo {
  available: boolean;
  model: string | null;
  models: { id: string; dtw: string }[];
  cli?: string;
}

export async function transcribeInfo(): Promise<ServerInfo | null> {
  try {
    const r = await fetch('/__transcribe/info');
    if (!r.ok) return null;
    return (await r.json()) as ServerInfo;
  } catch {
    return null;
  }
}

/** [start, end) the selected clips cover (null when nothing is selected). */
export function selectionRange(project: Project, ids: readonly Id[]): { start: Us; end: Us } | null {
  const clips = project.tracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id));
  if (!clips.length) return null;
  return { start: Math.min(...clips.map((c) => c.start)), end: Math.max(...clips.map(clipEnd)) };
}

/** The whole timeline. */
export const wholeRange = (project: Project): { start: Us; end: Us } => ({ start: 0, end: projectDuration(project) });

/** A copy of the project in which only `ids` are heard (every other clip disabled). */
export function onlyClips(project: Project, ids: readonly Id[]): Project {
  const keep = new Set(ids);
  return { ...project, tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (keep.has(c.id) ? c : { ...c, disabled: true })) })) };
}

export const WHISPER_RATE = 16_000;

/** Renders the range's mix as 16 kHz mono samples (null when nothing is audible). */
export async function mixRange(project: Project, range: { start: Us; end: Us }, signal?: AbortSignal): Promise<Float32Array | null> {
  const loadBlob = async (assetId: Id): Promise<Blob | null> => {
    const a = project.assets[assetId];
    if (!a || a.missing) return null;
    return getBlob(a.blobKey).catch(() => null);
  };
  const mix = await renderMix(project, range.end, createDecoder(loadBlob), signal);
  if (signal?.aborted) throw new TranscribeCanceled();
  if (!mix) return null;
  const a = Math.floor((range.start / 1e6) * mix.sampleRate);
  const b = Math.min(mix.length, Math.ceil((range.end / 1e6) * mix.sampleRate));
  const chans = Array.from({ length: mix.numberOfChannels }, (_, i) => mix.getChannelData(i).subarray(a, b));
  return resample(downmix(chans), mix.sampleRate, WHISPER_RATE);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new TranscribeCanceled());
    });
  });

/** Sends 16 kHz mono samples to whisper and waits for the words (µs from the start of the samples). */
export async function transcribeSamples(samples: Float32Array, lang: CaptionLanguage, onProgress?: (p: TranscribeProgress) => void, signal?: AbortSignal): Promise<{ words: CaptionWord[]; language?: string }> {
  onProgress?.({ phase: 'uploading', fraction: 0.15 });
  const r = await fetch(`/__transcribe/start?lang=${encodeURIComponent(lang)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encodeWav(samples, WHISPER_RATE), signal });
  const started = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!r.ok || !started.id) throw new Error(started.error ?? `Transcription server error ${r.status}`);
  const id = started.id;
  const cancel = () => void fetch(`/__transcribe/cancel?id=${id}`, { method: 'POST' }).catch(() => undefined);
  signal?.addEventListener('abort', cancel);
  try {
    for (;;) {
      await sleep(400, signal);
      const s = await fetch(`/__transcribe/status?id=${id}`, { signal });
      const st = (await s.json()) as { state: string; progress: number; language?: string; error?: string; result?: WhisperJson };
      if (st.state === 'running') {
        onProgress?.({ phase: 'transcribing', fraction: 0.2 + 0.78 * Math.min(1, st.progress || 0) });
        continue;
      }
      if (st.state === 'done' && st.result) {
        const words = parseWhisperJson(st.result).map((w) => ({ text: w.text, start: w.start, end: w.end }));
        return { words, language: whisperLanguage(st.result) ?? st.language };
      }
      if (st.state === 'cancelled') throw new TranscribeCanceled();
      throw new Error(st.error ?? 'Transcription failed');
    }
  } catch (e) {
    if (signal?.aborted) throw new TranscribeCanceled();
    throw e;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export interface TranscribeOptions {
  project: Project;
  range: { start: Us; end: Us };
  lang: CaptionLanguage;
  /** Only these clips are heard (absent = everything you hear in the range). */
  onlyClipIds?: readonly Id[];
  onProgress?: (p: TranscribeProgress) => void;
  signal?: AbortSignal;
}

/** Transcribes what plays in `range` → words in timeline µs. */
export async function transcribeTimeline(o: TranscribeOptions): Promise<TranscribeResult> {
  if (o.range.end <= o.range.start) throw new Error('Nothing to transcribe: the range is empty.');
  o.onProgress?.({ phase: 'mixing', fraction: 0.02 });
  const project = o.onlyClipIds?.length ? onlyClips(o.project, o.onlyClipIds) : o.project;
  const samples = await mixRange(project, o.range, o.signal);
  if (!samples || !samples.some((v) => Math.abs(v) > 1e-4)) throw new Error('Nothing to hear in that range.');
  const { words, language } = await transcribeSamples(samples, o.lang, o.onProgress, o.signal);
  o.onProgress?.({ phase: 'done', fraction: 1 });
  return { words: words.map((w) => ({ ...w, start: w.start + o.range.start, end: w.end + o.range.start })), language, range: o.range };
}
