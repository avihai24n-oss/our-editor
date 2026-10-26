/**
 * Caption edit operations. Each MUTATES a Project draft and is run through
 * `useEditor.getState().editProject(...)` (one undo step, normalize, locked tracks respected).
 * Pure apart from the draft: no React, no DOM.
 */
import { current, isDraft } from 'immer';
import { createTextClip, createTrack, newId } from '../model/defaults';
import { clipEnd } from '../model/time';
import type { Clip, Id, Project, TextClip, Track, Us } from '../model/types';
import { buildSegments, captionOrigin, editWords, isCaptionClip, isCaptionTrack, joinWords, retimeWord, visibleWordIndices, type CaptionClip, type GroupOptions, type SegmentSpan } from './model';
import { defaultCaptionStyle, presetStyle } from './presets';
import { spreadWords, type CueIn } from './srt';
import type { CaptionStyle, CaptionTrackSettings, CaptionWord } from './types';

const findClip = (p: Project, id: Id): { track: Track; clip: Clip; index: number } | null => {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
};

const findCaption = (p: Project, id: Id): { track: Track; clip: CaptionClip; index: number } | null => {
  const f = findClip(p, id);
  if (!f || f.track.locked || !isCaptionClip(f.clip)) return null;
  return f as { track: Track; clip: CaptionClip; index: number };
};

/** Keeps a caption clip's text (timeline label, Text tab, hit box fallback) equal to its visible words. */
export function syncCaptionClip(c: TextClip): void {
  if (!isCaptionClip(c)) return;
  const words = c.caption.words;
  const vis = visibleWordIndices(c).map((i) => words[i]!);
  const text = joinWords(vis.length ? vis : words);
  if (c.text.content !== text) c.text.content = text;
  if (c.name !== text) c.name = text;
}

/** ops.trimStart hook: the left edge moved by `shift` µs; the words stay on their sound. */
export function captionTrimStart(c: Clip, shift: Us): void {
  if (isCaptionClip(c)) c.caption.offset = (c.caption.offset || 0) + shift;
}

/** ops.splitClip hook: `b` (a copy of `a`) now starts `at` µs into `a`. */
export function captionSplit(b: Clip, at: Us): void {
  if (isCaptionClip(b)) b.caption.offset = (b.caption.offset || 0) + at;
}

// ---------------------------------------------------------------- tracks

export const captionTracks = (p: Project): Track[] => p.tracks.filter(isCaptionTrack);

/** The first caption track (unlocked) or a new one on top of every visual track. */
export function ensureCaptionTrack(p: Project, style?: CaptionStyle): Track {
  const found = p.tracks.find((t) => isCaptionTrack(t) && !t.locked);
  if (found) return found;
  const t = createTrack('text');
  t.name = 'Captions';
  t.captions = { style: style ?? defaultCaptionStyle(p.settings.width, p.settings.height), burnIn: true };
  p.tracks.push(t);
  return p.tracks[p.tracks.length - 1]!;
}

export function setCaptionTrack(p: Project, trackId: Id, patch: Partial<Omit<CaptionTrackSettings, 'style'>> & { style?: Partial<CaptionStyle> }): boolean {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || t.locked || !t.captions) return false;
  const { style, ...rest } = patch;
  Object.assign(t.captions, rest);
  if (style) {
    const s = t.captions.style;
    Object.assign(s, { ...style, stroke: { ...s.stroke, ...style.stroke }, shadow: { ...s.shadow, ...style.shadow }, background: { ...s.background, ...style.background } });
  }
  return true;
}

/** Applies a preset to the track; keeps the font size if the user changed it? No — a preset is a full look. */
export function applyPreset(p: Project, trackId: Id, presetId: string, keepColors = false): boolean {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || t.locked || !t.captions) return false;
  const old = t.captions.style;
  const next = presetStyle(presetId, p.settings.width, p.settings.height);
  if (keepColors) next.highlightColor = old.highlightColor;
  // keep where the user put the captions
  next.x = old.x;
  next.y = presetId === 'subtitle' || old.preset === 'subtitle' ? next.y : old.y;
  t.captions.style = next;
  // per-caption look overrides would hide the new preset: drop them (positions stay on transforms)
  for (const c of t.clips) if (isCaptionClip(c)) delete c.caption.style;
  return true;
}

// ---------------------------------------------------------------- placing transcriptions

function newCaptionClip(trackId: Id, span: SegmentSpan): CaptionClip {
  const text = joinWords(span.words);
  const c = createTextClip(trackId, span.start, text, Math.max(1, span.end - span.start)) as CaptionClip;
  c.caption = { offset: 0, words: span.words.map((w) => ({ text: w.text, start: w.start - span.start, end: w.end - span.start })) };
  return c;
}

/**
 * Puts captions for `words` (timeline µs) on the caption track, replacing the captions in
 * [range.start, range.end) only: captions outside the range stay; ones that overlap its edges are
 * trimmed back to it. Returns the new clip ids. Creates the caption track when needed.
 */
export function placeTranscription(
  p: Project,
  words: readonly CaptionWord[],
  range: { start: Us; end: Us },
  grouping: GroupOptions,
  opts: { trackId?: Id; language?: string; minUs?: number; style?: CaptionStyle } = {},
): Id[] {
  const track = (opts.trackId && p.tracks.find((t) => t.id === opts.trackId && isCaptionTrack(t) && !t.locked)) || ensureCaptionTrack(p, opts.style);
  if (track.locked) return [];
  if (opts.language && track.captions) track.captions.language = opts.language;
  const inRange = words.filter((w) => (w.start + w.end) / 2 >= range.start && (w.start + w.end) / 2 < range.end);
  clearRange(track, range);
  const before = track.clips.filter((c) => clipEnd(c) <= range.start);
  const after = track.clips.filter((c) => c.start >= range.end);
  const limit = Math.min(range.end, after.length ? Math.min(...after.map((c) => c.start)) : Number.MAX_SAFE_INTEGER);
  const floor = Math.max(range.start, before.length ? Math.max(...before.map(clipEnd)) : 0);
  const spans = buildSegments(inRange, grouping, limit, opts.minUs);
  const ids: Id[] = [];
  for (const s of spans) {
    const start = Math.max(s.start, floor);
    const end = Math.min(s.end, limit);
    if (end - start < (opts.minUs ?? 1)) continue;
    const clip = newCaptionClip(track.id, { ...s, start, end });
    syncCaptionClip(clip);
    track.clips.push(clip);
    ids.push(clip.id);
  }
  track.clips.sort((a, b) => a.start - b.start);
  return ids;
}

/**
 * Removes the caption clips of `track` inside the range; one crossing an edge keeps the part
 * outside (a caption crossing both edges becomes two). Parts left without a word are dropped.
 */
function clearRange(track: Track, range: { start: Us; end: Us }): void {
  const keep: Clip[] = [];
  for (const c of track.clips) {
    const end = clipEnd(c);
    if (end <= range.start || c.start >= range.end || !isCaptionClip(c)) {
      keep.push(c);
      continue;
    }
    if (end > range.end) {
      // the part after the range (a copy when the head stays too)
      const tail = (c.start < range.start ? structuredClone(isDraft(c) ? current(c) : c) : c) as CaptionClip;
      if (tail !== c) tail.id = newId('clp');
      tail.caption.offset = (tail.caption.offset || 0) + (range.end - c.start);
      tail.start = range.end;
      tail.duration = end - range.end;
      if (visibleWordIndices(tail).length) keep.push(tail);
    }
    if (c.start < range.start) {
      c.duration = range.start - c.start; // the part before the range
      if (visibleWordIndices(c).length) keep.push(c);
    }
  }
  keep.sort((a, b) => a.start - b.start);
  track.clips = keep;
  track.transitions = track.transitions.filter((t) => keep.some((c) => c.id === t.fromClipId) && keep.some((c) => c.id === t.toClipId));
}

/** Imports SRT / VTT / word-JSON cues as a caption track (the cues' own spans are kept). */
export function importCues(p: Project, cues: readonly CueIn[], opts: { trackId?: Id; style?: CaptionStyle } = {}): Id[] {
  const track = (opts.trackId && p.tracks.find((t) => t.id === opts.trackId && isCaptionTrack(t) && !t.locked)) || ensureCaptionTrack(p, opts.style);
  if (track.locked || !cues.length) return [];
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const range = { start: sorted[0]!.start, end: Math.max(...sorted.map((c) => c.end)) };
  clearRange(track, range);
  const ids: Id[] = [];
  let lastEnd = 0;
  for (const cue of sorted) {
    const start = Math.max(cue.start, lastEnd);
    const end = cue.end;
    if (end <= start) continue;
    if (track.clips.some((c) => c.start < end && clipEnd(c) > start)) continue;
    const words = cue.words?.length ? cue.words : spreadWords(cue.text, cue.start, cue.end);
    const clip = newCaptionClip(track.id, { start, end, words: words.map((w) => ({ ...w })) });
    syncCaptionClip(clip);
    track.clips.push(clip);
    track.clips.sort((a, b) => a.start - b.start);
    ids.push(clip.id);
    lastEnd = end;
  }
  return ids;
}

/** Cues for export (timeline µs), from the caption clips of one track (or every caption track). */
export function captionCues(p: Project, trackId?: Id): CueIn[] {
  const tracks = trackId ? p.tracks.filter((t) => t.id === trackId) : captionTracks(p);
  const out: CueIn[] = [];
  for (const t of tracks) {
    for (const c of t.clips) {
      if (!isCaptionClip(c) || c.disabled) continue;
      const o = captionOrigin(c);
      const words = visibleWordIndices(c).map((i) => c.caption.words[i]!).map((w) => ({ text: w.text, start: w.start + o, end: w.end + o }));
      if (!words.length) continue;
      out.push({ start: c.start, end: clipEnd(c), text: joinWords(words), words });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- the caption lab

/** New text for a caption; word timings kept where the words did not change (see editWords). */
export function editCaptionText(p: Project, clipId: Id, text: string): boolean {
  const f = findCaption(p, clipId);
  if (!f) return false;
  const c = f.clip;
  const vis = visibleWordIndices(c);
  if (!vis.length) return false;
  const a = vis[0]!;
  const b = vis[vis.length - 1]! + 1;
  const edited = editWords(c.caption.words.slice(a, b), text);
  if (!edited.length) return false;
  c.caption.words = [...c.caption.words.slice(0, a), ...edited, ...c.caption.words.slice(b)];
  syncCaptionClip(c);
  return true;
}

/** Sets one word's text (no timing change). */
export function setWordText(p: Project, clipId: Id, index: number, text: string): boolean {
  const f = findCaption(p, clipId);
  const w = f?.clip.caption.words[index];
  if (!f || !w || !text.trim()) return false;
  w.text = text.trim().replace(/\s+/g, ' ');
  syncCaptionClip(f.clip);
  return true;
}

/** Retimes word `index` (timeline µs), clamped to its neighbours and to the caption's span. */
export function retimeCaptionWord(p: Project, clipId: Id, index: number, start: Us, end: Us): boolean {
  const f = findCaption(p, clipId);
  if (!f || !f.clip.caption.words[index]) return false;
  const c = f.clip;
  const o = captionOrigin(c);
  const lo = c.start - o;
  const hi = clipEnd(c) - o;
  const s = Math.max(lo, Math.min(start - o, hi - 20_000));
  const e = Math.min(hi, Math.max(end - o, s + 20_000));
  c.caption.words = retimeWord(c.caption.words, index, s, e);
  return true;
}

/**
 * Splits a caption before word `index` (of its visible words): the left part keeps the words
 * before it, the right part starts when that word starts. Returns the new clip's id.
 */
export function splitCaption(p: Project, clipId: Id, index: number): Id | null {
  const f = findCaption(p, clipId);
  if (!f) return null;
  const c = f.clip;
  const vis = visibleWordIndices(c);
  if (index <= 0 || index >= vis.length) return null;
  const o = captionOrigin(c);
  const words = vis.map((i) => c.caption.words[i]!);
  const at = Math.round(words[index]!.start + o);
  const end = clipEnd(c);
  if (at <= c.start || at >= end) return null;
  const left = words.slice(0, index);
  const right = words.slice(index);
  const b = structuredClone(isDraft(c) ? current(c) : c) as CaptionClip;
  b.id = newId('clp');
  b.start = at;
  b.duration = end - at;
  b.animationIn = null;
  b.animationCombo = null;
  b.caption = { ...b.caption, offset: 0, words: right.map((w) => ({ text: w.text, start: w.start + o - at, end: w.end + o - at })) };
  c.duration = at - c.start;
  c.animationOut = null;
  c.caption.words = left.map((w) => ({ ...w }));
  syncCaptionClip(c);
  syncCaptionClip(b);
  f.track.clips.splice(f.index + 1, 0, b);
  return b.id;
}

/** Merges a caption with the next caption on its track (they become one). */
export function mergeWithNext(p: Project, clipId: Id): boolean {
  const f = findCaption(p, clipId);
  if (!f) return false;
  const a = f.clip;
  const b = f.track.clips[f.index + 1];
  if (!b || !isCaptionClip(b)) return false;
  const oa = captionOrigin(a);
  const ob = captionOrigin(b);
  const wa = visibleWordIndices(a).map((i) => a.caption.words[i]!);
  const wb = visibleWordIndices(b).map((i) => b.caption.words[i]!).map((w) => ({ text: w.text, start: w.start + ob - oa, end: w.end + ob - oa }));
  a.caption.words = [...wa.map((w) => ({ ...w })), ...wb];
  a.duration = clipEnd(b) - a.start;
  a.animationOut = (b as TextClip).animationOut;
  f.track.clips.splice(f.index + 1, 1);
  f.track.transitions = f.track.transitions.filter((t) => t.fromClipId !== b.id && t.toClipId !== b.id);
  syncCaptionClip(a);
  return true;
}

/**
 * Moves captions (and their words) by `delta` µs, never over a neighbour or before 0.
 * `clipIds` empty = the whole track (a sync offset for every caption).
 */
export function nudgeCaptions(p: Project, trackId: Id, clipIds: readonly Id[], delta: Us): boolean {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || t.locked || !delta) return false;
  const set = new Set(clipIds.length ? clipIds : t.clips.map((c) => c.id));
  const moving = t.clips.filter((c) => set.has(c.id));
  if (!moving.length) return false;
  // the largest move that keeps every moving clip clear of the clips that stay
  let d = delta;
  for (const c of moving) {
    const i = t.clips.indexOf(c);
    if (d < 0) {
      let j = i - 1;
      while (j >= 0 && set.has(t.clips[j]!.id)) j--;
      const floor = j >= 0 ? clipEnd(t.clips[j]!) : 0;
      d = Math.max(d, floor - c.start);
    } else {
      let j = i + 1;
      while (j < t.clips.length && set.has(t.clips[j]!.id)) j++;
      if (j < t.clips.length) d = Math.min(d, t.clips[j]!.start - clipEnd(c));
    }
  }
  if (!d) return false;
  for (const c of moving) c.start += d;
  return true;
}

/** Per-caption style override (null clears it). */
export function setCaptionOverride(p: Project, clipId: Id, patch: Partial<CaptionStyle> | null): boolean {
  const f = findCaption(p, clipId);
  if (!f) return false;
  if (!patch) delete f.clip.caption.style;
  else f.clip.caption.style = { ...f.clip.caption.style, ...patch };
  return true;
}

/** Removes the caption clips in a range (the whole track when no range). */
export function clearCaptions(p: Project, trackId: Id, range?: { start: Us; end: Us }): boolean {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || t.locked) return false;
  const n = t.clips.length;
  clearRange(t, range ?? { start: 0, end: Number.MAX_SAFE_INTEGER });
  return t.clips.length !== n;
}

/** The project with every caption track that is not burnt in hidden (export). */
export function withoutPreviewOnlyCaptions(p: Project): Project {
  if (!p.tracks.some((t) => t.captions && t.captions.burnIn === false)) return p;
  return { ...p, tracks: p.tracks.map((t) => (t.captions && t.captions.burnIn === false ? { ...t, hidden: true } : t)) };
}

/**
 * Regroups every caption of the track with new limits (words per caption, characters), keeping
 * every word's timing: the words are gathered from the captions and placed again over the same
 * span. Per-caption style overrides, dragged positions and animations are not carried over.
 */
export function resplitCaptions(p: Project, trackId: Id, grouping: GroupOptions, minUs?: number): Id[] {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || t.locked || !t.captions) return [];
  const caps = t.clips.filter(isCaptionClip).filter((c) => !c.disabled);
  if (!caps.length) return [];
  const words = caps.flatMap((c) => {
    const o = captionOrigin(c);
    return visibleWordIndices(c).map((i) => c.caption.words[i]!).map((w) => ({ text: w.text, start: w.start + o, end: w.end + o }));
  });
  const range = { start: Math.min(...caps.map((c) => c.start)), end: Math.max(...caps.map(clipEnd)) };
  return placeTranscription(p, words, range, grouping, { trackId, minUs });
}

/**
 * A caption dragged in the player carries its own offset (clip.transform x / y). This makes that
 * place the track's caption position: the track style moves there and every caption's own drag
 * offset is cleared.
 */
export function adoptCaptionPosition(p: Project, clipId: Id): boolean {
  const f = findCaption(p, clipId);
  if (!f || !f.track.captions) return false;
  const { width: W, height: H } = p.settings;
  const s = f.track.captions.style;
  const base = { ...s, ...f.clip.caption.style };
  s.x = Math.round(((base.x * W + f.clip.transform.x) / W) * 1000) / 1000;
  s.y = Math.round(((base.y * H + f.clip.transform.y) / H) * 1000) / 1000;
  for (const c of f.track.clips) {
    if (!isCaptionClip(c)) continue;
    c.transform.x = 0;
    c.transform.y = 0;
    if (c.caption.style) {
      delete c.caption.style.x;
      delete c.caption.style.y;
    }
  }
  return true;
}
