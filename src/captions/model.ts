/**
 * Pure caption helpers: word timing on the timeline, grouping words into captions, keeping
 * timings when the text is edited, RTL detection and style resolution. No DOM, no store.
 */
import type { Id, Project, TextClip, Track, Us } from '../model/types';
import { defaultCaptionStyle } from './presets';
import type { CaptionSegment, CaptionStyle, CaptionWord } from './types';

export type CaptionClip = TextClip & { caption: CaptionSegment };

export const isCaptionClip = (c: { type: string; caption?: unknown } | null | undefined): c is CaptionClip =>
  !!c && c.type === 'text' && !!(c as TextClip).caption;

export const isCaptionTrack = (t: Track | null | undefined): boolean => !!t && t.kind === 'text' && !!t.captions;

/** Timeline time of caption-axis time 0 for this clip. */
export const captionOrigin = (clip: Pick<TextClip, 'start'> & { caption: Pick<CaptionSegment, 'offset'> }): Us => clip.start - (clip.caption.offset || 0);

/** The clip's words in timeline µs (all of them, also those trimmed off). */
export function timelineWords(clip: CaptionClip): CaptionWord[] {
  const o = captionOrigin(clip);
  return clip.caption.words.map((w) => ({ text: w.text, start: w.start + o, end: w.end + o }));
}

/** Indices of the words that play inside the clip's own span (a trim or a split hides the rest). */
export function visibleWordIndices(clip: CaptionClip): number[] {
  const o = captionOrigin(clip);
  const a = clip.start;
  const b = clip.start + clip.duration;
  const out: number[] = [];
  clip.caption.words.forEach((w, i) => {
    const mid = (w.start + w.end) / 2 + o;
    if (mid >= a && mid < b) out.push(i);
  });
  return out;
}

/** Words shown by the clip, timeline µs. */
export const visibleWords = (clip: CaptionClip): CaptionWord[] => {
  const all = timelineWords(clip);
  return visibleWordIndices(clip).map((i) => all[i]!);
};

export const joinWords = (words: readonly Pick<CaptionWord, 'text'>[]): string => words.map((w) => w.text).join(' ');

/** Hebrew / Arabic letters → right to left. Per word, like MakePodcast. */
export const isRTL = (s: string): boolean => /[֐-׿؀-ۿיִ-ﭏ]/.test(s || '');

/** A caption reads right to left when most of its letters are Hebrew / Arabic. */
export function isRTLText(s: string): boolean {
  const rtl = (s.match(/[֐-׿؀-ۿיִ-ﭏ]/g) ?? []).length;
  const ltr = (s.match(/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g) ?? []).length;
  return rtl > 0 && rtl >= ltr;
}

/** Track style + the caption's own overrides (nested objects merged one level). */
export function resolveStyle(track: Track | null | undefined, clip: CaptionClip, project?: Pick<Project, 'settings'>): CaptionStyle {
  const base = track?.captions?.style ?? defaultCaptionStyle(project?.settings.width ?? 1080, project?.settings.height ?? 1920);
  const o = clip.caption.style;
  if (!o) return base;
  return {
    ...base,
    ...o,
    stroke: { ...base.stroke, ...o.stroke },
    shadow: { ...base.shadow, ...o.shadow },
    background: { ...base.background, ...o.background },
  };
}

/** Finds the caption track settings of a clip id. */
export function trackOfClip(project: Project, clipId: Id): Track | undefined {
  return project.tracks.find((t) => t.clips.some((c) => c.id === clipId));
}

// ---------------------------------------------------------------- grouping (MakePodcast groupWords)

export interface GroupOptions {
  maxWords: number;
  maxChars: number;
  /** A real pause between words starts a new caption. */
  maxGapUs: Us;
  /** Break after a comma too (MakePodcast does). */
  breakOnComma: boolean;
}

export const DEFAULT_GROUPING: GroupOptions = { maxWords: 4, maxChars: 26, maxGapUs: 350_000, breakOnComma: true };

const SENTENCE_END = /[.!?…׃。！？]["'”’)\]」』）]?$/;
const CLAUSE_END = /[,،、，：；]["'”’)\]]?$/;
const isCJK = (s: string) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(s || '');

/**
 * Sentence / phrase-aware grouping, ported from MakePodcast (remotion/PodcastReel.tsx
 * groupWords): a new caption starts after a sentence end, after a comma, past the word or
 * character cap, or after a pause longer than maxGapUs.
 */
export function groupWords<W extends CaptionWord>(words: readonly W[], o: GroupOptions = DEFAULT_GROUPING): W[][] {
  const groups: W[][] = [];
  let cur: W[] = [];
  let chars = 0;
  for (const w of words) {
    const cjk = isCJK(w.text);
    const maxWords = cjk ? Infinity : o.maxWords;
    const maxChars = cjk ? 12 : o.maxChars;
    const prev = cur[cur.length - 1];
    const addLen = [...(w.text || '')].length + (cjk ? 0 : 1);
    const breakBefore =
      !!prev &&
      (SENTENCE_END.test(prev.text) ||
        (o.breakOnComma && CLAUSE_END.test(prev.text)) ||
        cur.length >= maxWords ||
        chars + addLen > maxChars ||
        w.start - prev.end > o.maxGapUs);
    if (breakBefore) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += addLen;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export interface SegmentSpan {
  start: Us;
  end: Us;
  words: CaptionWord[];
}

/** How long a caption stays after its last word when nothing follows soon. */
export const CAPTION_HOLD_US = 500_000;
/** Gaps up to this long are bridged: the caption stays until the next one (no flicker). */
export const CAPTION_BRIDGE_US = 700_000;

/**
 * Turns timeline-time words into caption spans: each group shows from its first word until the
 * next caption starts (short gaps) or `CAPTION_HOLD_US` after its last word, never past `rangeEnd`.
 */
export function buildSegments(words: readonly CaptionWord[], o: GroupOptions = DEFAULT_GROUPING, rangeEnd: Us = Number.MAX_SAFE_INTEGER, minUs = 33_334): SegmentSpan[] {
  const groups = groupWords(words, o);
  return groups.map((g, i) => {
    const next = groups[i + 1];
    const start = g[0]!.start;
    const last = g[g.length - 1]!.end;
    let end = last + CAPTION_HOLD_US;
    if (next && next[0]!.start - last <= CAPTION_BRIDGE_US) end = next[0]!.start;
    else if (next) end = Math.min(end, next[0]!.start);
    end = Math.min(end, rangeEnd);
    end = Math.max(end, Math.min(rangeEnd, last), start + minUs);
    return { start, end, words: g.map((w) => ({ ...w })) };
  });
}

// ---------------------------------------------------------------- editing words

export const tokenize = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** Splits [a, b) between pieces in proportion to their character counts. */
function distribute(texts: string[], a: Us, b: Us): CaptionWord[] {
  const weights = texts.map((t) => Math.max(1, [...t].length));
  const total = weights.reduce((x, y) => x + y, 0);
  const out: CaptionWord[] = [];
  let t = a;
  texts.forEach((text, i) => {
    const end = i === texts.length - 1 ? b : Math.round(t + ((b - a) * weights[i]!) / total);
    out.push({ text, start: t, end: Math.max(t, end) });
    t = end;
  });
  return out;
}

/** Longest common subsequence alignment of two token lists → difflib-like opcodes. */
function opcodes(a: string[], b: string[]): { tag: 'equal' | 'replace' | 'insert' | 'delete'; i1: number; i2: number; j1: number; j2: number }[] {
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++;
    else j++;
  }
  pairs.push([n, m]);
  const out: ReturnType<typeof opcodes> = [];
  let pi = 0;
  let pj = 0;
  for (const [ei, ej] of pairs) {
    if (pi < ei || pj < ej) out.push({ tag: pi < ei && pj < ej ? 'replace' : pi < ei ? 'delete' : 'insert', i1: pi, i2: ei, j1: pj, j2: ej });
    if (ei < n) out.push({ tag: 'equal', i1: ei, i2: ei + 1, j1: ej, j2: ej + 1 });
    pi = ei + 1;
    pj = ej + 1;
  }
  return out;
}

/**
 * New text for a caption, keeping the timings: unchanged words keep theirs, a replaced run shares
 * the time of the words it replaces (by length), an inserted word takes the gap before the next
 * word or a share of its neighbour, deleted words are dropped. Never moves the caption's span.
 */
export function editWords(words: readonly CaptionWord[], text: string): CaptionWord[] {
  const next = tokenize(text);
  if (!next.length) return [];
  if (!words.length) return [];
  const old = words.map((w) => w.text);
  const out: CaptionWord[] = [];
  for (const op of opcodes(old, next)) {
    const texts = next.slice(op.j1, op.j2);
    if (op.tag === 'equal') out.push({ ...words[op.i1]! });
    else if (op.tag === 'replace') out.push(...distribute(texts, words[op.i1]!.start, words[op.i2 - 1]!.end));
    else if (op.tag === 'insert') {
      const prev = out[out.length - 1];
      const nextOld = words[op.i1];
      const gapA = prev ? prev.end : (nextOld?.start ?? 0);
      const gapB = nextOld ? nextOld.start : prev ? prev.end : 0;
      if (gapB - gapA >= 80_000 * texts.length) out.push(...distribute(texts, gapA, gapB));
      else if (prev) {
        // share the previous word's time with the inserted ones
        out.pop();
        out.push(...distribute([prev.text, ...texts], prev.start, prev.end));
      } else if (nextOld) {
        // inserted before the first word: share the first word's time (it is taken next as 'equal' / 'replace')
        const shared = distribute([...texts, nextOld.text], nextOld.start, nextOld.end);
        out.push(...shared.slice(0, texts.length));
        words = words.map((w, k) => (k === op.i1 ? { ...w, start: shared[texts.length]!.start } : w));
      }
    }
  }
  return out;
}

/** Changes one word's timing, clamped between its neighbours and to at least 20 ms. */
export function retimeWord(words: readonly CaptionWord[], i: number, start: Us, end: Us): CaptionWord[] {
  const min = 20_000;
  const lo = i > 0 ? words[i - 1]!.start + min : Number.MIN_SAFE_INTEGER;
  const hi = i < words.length - 1 ? words[i + 1]!.end - min : Number.MAX_SAFE_INTEGER;
  let s = Math.round(Math.max(lo, Math.min(start, hi - min)));
  let e = Math.round(Math.min(hi, Math.max(end, s + min)));
  if (e - s < min) s = e - min;
  return words.map((w, k) => {
    if (k === i) return { ...w, start: s, end: e };
    if (k === i - 1 && w.end > s) return { ...w, end: s };
    if (k === i + 1 && w.start < e) return { ...w, start: e };
    return w;
  });
}

/** Moves every word by `delta` µs. */
export const shiftWords = (words: readonly CaptionWord[], delta: Us): CaptionWord[] => words.map((w) => ({ ...w, start: w.start + delta, end: w.end + delta }));
