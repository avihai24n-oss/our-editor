/**
 * whisper.cpp output → words with timings.
 *
 * The server runs (vite-plugins/transcribe.js):
 *   whisper-cli -m ggml-large-v3-turbo.bin -l <he|en|auto> -nfa -dtw large.v3.turbo -ojf -pp
 * i.e. full JSON with token timestamps plus DTW token alignment (flash attention must be off for
 * DTW). Measured against ElevenLabs Scribe word timings on real Hebrew narration (Tiferet takes)
 * and English (Radu): whisper's own token / segment times drift by 0.2–0.5 s (they stretch over
 * pauses), while the DTW time of a token lands on its end within ~40 ms. So:
 *  - words = tokens merged until the next token that starts with a space (BPE splits Hebrew words
 *    into several tokens: "ש"+"לום"); punctuation-only tokens join the word but do not move its end;
 *  - end   = DTW time of the word's last non-punctuation token;
 *  - start = DTW time of its first token − 60 ms when the word has several tokens, else
 *    end − (65 ms × letters, 120..600 ms); never before the previous word's end.
 * Without DTW data (t_dtw = −1) the token offsets are used as they are.
 */
import type { Us } from '../model/types';

export interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  t_dtw?: number;
  p?: number;
}

export interface WhisperSegment {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WhisperToken[];
}

export interface WhisperJson {
  result?: { language?: string };
  transcription: WhisperSegment[];
}

export interface TimedWord {
  text: string;
  /** µs from the start of the transcribed audio. */
  start: Us;
  end: Us;
  /** Mean token probability 0..1 (absent when whisper gave none). */
  p?: number;
}

const PUNCT = /^[\s.,!?;:…"'״׳\-–—()[\]«»“”‘’]+$/u;
const isSpecial = (t: string) => /^\[_[A-Z]+_?\d*\]$/.test(t) || t.startsWith('[_');
const letters = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** Tuning constants (see the file header for where they come from). */
export const DTW_FIRST_TOKEN_LEAD_US = 60_000;
export const US_PER_LETTER = 65_000;
export const SINGLE_TOKEN_MIN_US = 120_000;
export const SINGLE_TOKEN_MAX_US = 600_000;
export const MIN_WORD_US = 60_000;

interface RawWord {
  text: string;
  /** token offsets, ms */
  from: number;
  to: number;
  /** DTW times (centiseconds) of the non-punctuation tokens */
  dtw: number[];
  p: number[];
}

/** Merges BPE tokens into words, per segment (segment text fixes broken UTF-8 in token texts). */
function rawWords(seg: WhisperSegment): RawWord[] {
  const toks = (seg.tokens ?? []).filter((t) => !isSpecial(t.text));
  const out: RawWord[] = [];
  for (const t of toks) {
    const punct = PUNCT.test(t.text);
    const newWord = !out.length || (t.text.startsWith(' ') && !punct);
    if (newWord) out.push({ text: t.text.trim(), from: t.offsets.from, to: t.offsets.to, dtw: [], p: [] });
    else out[out.length - 1]!.text += t.text;
    const w = out[out.length - 1]!;
    if (!punct) {
      w.to = t.offsets.to;
      if (typeof t.t_dtw === 'number' && t.t_dtw >= 0) w.dtw.push(t.t_dtw);
      if (typeof t.p === 'number') w.p.push(t.p);
    }
    if (newWord && punct) w.from = t.offsets.from;
  }
  const words = out.filter((w) => letters(w.text) > 0);
  // a token can be half of a multi-byte letter: whisper writes its raw bytes, which decode to U+FFFD.
  // The segment text is always whole, so take the word texts from it when the counts agree.
  if (words.some((w) => w.text.includes('�'))) {
    const fromText = seg.text.split(/\s+/).filter((s) => letters(s) > 0);
    if (fromText.length === words.length) fromText.forEach((s, i) => (words[i]!.text = s));
  }
  return words;
}

/** Words of a segment without tokens (plain -oj output): split its span by letter count. */
function wordsFromSegmentText(seg: WhisperSegment): RawWord[] {
  const parts = seg.text.split(/\s+/).filter((s) => letters(s) > 0);
  const total = parts.reduce((n, s) => n + letters(s), 0) || 1;
  let t = seg.offsets.from;
  return parts.map((text, i) => {
    const d = ((seg.offsets.to - seg.offsets.from) * letters(text)) / total;
    const w = { text, from: Math.round(t), to: i === parts.length - 1 ? seg.offsets.to : Math.round(t + d), dtw: [], p: [] };
    t += d;
    return w;
  });
}

/** Parses whisper-cli JSON (-oj / -ojf, with or without -dtw) into timed words. */
export function parseWhisperJson(json: WhisperJson): TimedWord[] {
  const raw: RawWord[] = [];
  for (const seg of json.transcription ?? []) raw.push(...(seg.tokens?.length ? rawWords(seg) : wordsFromSegmentText(seg)));
  const out: TimedWord[] = [];
  let prevEnd = 0;
  for (const w of raw) {
    let start: number;
    let end: number;
    if (w.dtw.length) {
      end = w.dtw[w.dtw.length - 1]! * 10_000;
      if (w.dtw.length > 1) start = w.dtw[0]! * 10_000 - DTW_FIRST_TOKEN_LEAD_US;
      else start = end - Math.min(SINGLE_TOKEN_MAX_US, Math.max(SINGLE_TOKEN_MIN_US, letters(w.text) * US_PER_LETTER));
    } else {
      start = w.from * 1000;
      end = w.to * 1000;
    }
    start = Math.max(start, prevEnd, 0);
    end = Math.max(end, start + MIN_WORD_US);
    const p = w.p.length ? w.p.reduce((a, b) => a + b, 0) / w.p.length : undefined;
    out.push({ text: w.text, start: Math.round(start), end: Math.round(end), ...(p !== undefined ? { p: Math.round(p * 1000) / 1000 } : {}) });
    prevEnd = Math.round(end);
  }
  return out;
}

/** Language whisper detected or was told ('he', 'en'…), if present. */
export const whisperLanguage = (json: WhisperJson): string | undefined => json.result?.language;
