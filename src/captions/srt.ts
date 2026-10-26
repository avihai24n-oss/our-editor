/**
 * Caption files: SRT and WebVTT import / export, and a word-level JSON export. Pure.
 * All times are timeline µs.
 */
import type { Us } from '../model/types';
import type { CaptionWord } from './types';

export interface CueIn {
  start: Us;
  end: Us;
  text: string;
  /** Word timings, when known (exported JSON / transcription). */
  words?: CaptionWord[];
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** µs → "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT). */
export function formatTimestamp(us: Us, sep: ',' | '.' = ','): string {
  const ms = Math.max(0, Math.round(us / 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** "00:01:02,345" / "01:02.345" / "1:02:03.4" → µs (NaN when not a timestamp). */
export function parseTimestamp(s: string): Us {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (!m) return NaN;
  const [, h, mi, se, frac] = m;
  const ms = (Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(se)) * 1000 + (frac ? Number(frac.padEnd(3, '0')) : 0);
  return ms * 1000;
}

const ARROW = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;

/** Parses SRT or WebVTT text. Tags (<i>, <c.x>, {\an8}) are stripped; cue lines are kept. */
export function parseSubtitles(text: string): CueIn[] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: CueIn[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i]!.match(ARROW);
    if (!m) {
      i++;
      continue;
    }
    const start = parseTimestamp(m[1]!);
    const end = parseTimestamp(m[2]!);
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      if (ARROW.test(lines[i]!)) break;
      body.push(lines[i]!);
      i++;
    }
    const clean = body
      .map((l) => l.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').trim())
      .filter(Boolean)
      .join('\n');
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && clean) cues.push({ start, end, text: clean });
  }
  return cues;
}

export function toSrt(cues: readonly CueIn[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}\n`).join('\n');
}

export function toVtt(cues: readonly CueIn[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}\n`).join('\n');
}

export interface WordJson {
  format: 'our-editor-captions';
  version: 1;
  language?: string;
  /** Seconds (3 decimals) on the timeline. */
  captions: { start: number; end: number; text: string; words: { text: string; start: number; end: number }[] }[];
}

const sec = (us: Us) => Math.round(us / 1000) / 1000;

export function toWordJson(cues: readonly CueIn[], language?: string): WordJson {
  return {
    format: 'our-editor-captions',
    version: 1,
    ...(language ? { language } : {}),
    captions: cues.map((c) => ({ start: sec(c.start), end: sec(c.end), text: c.text, words: (c.words ?? []).map((w) => ({ text: w.text, start: sec(w.start), end: sec(w.end) })) })),
  };
}

/** Reads our word JSON back (import). Returns null when the text is not that format. */
export function parseWordJson(text: string): CueIn[] | null {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  const j = d as Partial<WordJson>;
  if (!j || j.format !== 'our-editor-captions' || !Array.isArray(j.captions)) return null;
  const us = (s: number) => Math.round(s * 1e6);
  return j.captions.map((c) => ({ start: us(c.start), end: us(c.end), text: c.text, words: c.words.map((w) => ({ text: w.text, start: us(w.start), end: us(w.end) })) }));
}

/** Words for a cue without timings: spread over the cue by character count. */
export function spreadWords(text: string, start: Us, end: Us): CaptionWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const weights = parts.map((p) => Math.max(1, [...p].length));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return parts.map((p, i) => {
    const e = i === parts.length - 1 ? end : Math.round(t + ((end - start) * weights[i]!) / total);
    const w = { text: p, start: Math.round(t), end: e };
    t = e;
    return w;
  });
}
