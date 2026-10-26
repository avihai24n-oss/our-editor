import { describe, expect, it } from 'vitest';
import { buildSegments, CAPTION_HOLD_US, DEFAULT_GROUPING, editWords, groupWords, isRTL, isRTLText, retimeWord, shiftWords, tokenize } from './model';
import type { CaptionWord } from './types';

const W = (text: string, startMs: number, endMs: number): CaptionWord => ({ text, start: startMs * 1000, end: endMs * 1000 });
const texts = (g: CaptionWord[][]) => g.map((x) => x.map((w) => w.text).join(' '));

describe('groupWords (MakePodcast grouping)', () => {
  it('breaks after a sentence end and a comma, at 4 words and at 26 characters', () => {
    const words = 'שלום לכולם, היום נספר לכם סיפור על בית הכנסת בירושלים, ועל המשפחה שבנתה אותו.'.split(' ').map((t, i) => W(t, i * 300, i * 300 + 250));
    expect(texts(groupWords(words))).toEqual(['שלום לכולם,', 'היום נספר לכם סיפור', 'על בית הכנסת בירושלים,', 'ועל המשפחה שבנתה אותו.']);
    const en = 'One. Two three four five six seven'.split(' ').map((t, i) => W(t, i * 300, i * 300 + 250));
    expect(texts(groupWords(en))).toEqual(['One.', 'Two three four five', 'six seven']);
    const long = 'internationalization standardization'.split(' ').map((t, i) => W(t, i * 300, i * 300 + 250));
    expect(texts(groupWords(long))).toEqual(['internationalization', 'standardization']);
  });

  it('a pause longer than 0.35 s starts a new caption; the caps are configurable', () => {
    const words = [W('a', 0, 100), W('b', 120, 200), W('c', 700, 800), W('d', 820, 900)];
    expect(texts(groupWords(words))).toEqual(['a b', 'c d']);
    expect(texts(groupWords(words, { ...DEFAULT_GROUPING, maxGapUs: 1e6, maxWords: 3 }))).toEqual(['a b c', 'd']);
    expect(texts(groupWords([W('x,', 0, 1), W('y', 2, 3)], { ...DEFAULT_GROUPING, breakOnComma: false }))).toEqual(['x, y']);
  });
});

describe('buildSegments', () => {
  it('bridges short gaps (no flicker), holds 0.5 s after a pause, never past the range end', () => {
    const words = [W('a.', 0, 400), W('b.', 600, 900), W('c', 3000, 3300)];
    const segs = buildSegments(words, DEFAULT_GROUPING, 3500_000);
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 600_000], // bridged to the next caption
      [600_000, 900_000 + CAPTION_HOLD_US],
      [3_000_000, 3_500_000], // held, cut at the range end
    ]);
    expect(segs[0]!.words).toEqual([words[0]]);
  });
});

describe('editWords (text edits keep timings)', () => {
  const words = [W('היום', 0, 300), W('נספר', 300, 600), W('לכם', 600, 800), W('סיפור', 800, 1200)];

  it('unchanged text keeps every word', () => {
    expect(editWords(words, 'היום נספר לכם סיפור')).toEqual(words);
  });

  it('a replaced word takes the replaced time; the others keep theirs', () => {
    const out = editWords(words, 'היום נספר לכם מעשה');
    expect(out.map((w) => w.text)).toEqual(['היום', 'נספר', 'לכם', 'מעשה']);
    expect(out.map((w) => [w.start, w.end])).toEqual(words.map((w) => [w.start, w.end]));
  });

  it('one word replaced by two shares its time by length', () => {
    const out = editWords(words, 'היום נספר לכם סיפור יפה');
    // insert at the end: shares the last word's time
    expect(out.map((w) => w.text)).toEqual(['היום', 'נספר', 'לכם', 'סיפור', 'יפה']);
    expect(out[3]!.start).toBe(800_000);
    expect(out[4]!.end).toBe(1_200_000);
    expect(out[3]!.end).toBe(out[4]!.start);
    const out2 = editWords(words, 'היום נספר לכם סי פור');
    expect(out2.slice(3).map((w) => [w.text, w.start, w.end])).toEqual([
      ['סי', 800_000, 960_000], // 2 of 5 letters
      ['פור', 960_000, 1_200_000],
    ]);
  });

  it('deleted words go, the span of the rest stays; an inserted word at the start shares the first word', () => {
    expect(editWords(words, 'היום סיפור')).toEqual([words[0], words[3]]);
    const out = editWords(words, 'אז היום נספר לכם סיפור');
    expect(out.map((w) => w.text)).toEqual(['אז', 'היום', 'נספר', 'לכם', 'סיפור']);
    expect(out[0]!.start).toBe(0);
    expect(out[1]!.end).toBe(300_000);
    expect(out[0]!.end).toBe(out[1]!.start);
  });

  it('an inserted word goes into a gap when there is one', () => {
    const gappy = [W('a', 0, 200), W('c', 800, 1000)];
    const out = editWords(gappy, 'a b c');
    expect(out).toEqual([gappy[0], { text: 'b', start: 200_000, end: 800_000 }, gappy[1]]);
  });

  it('empty text → no words (the caller refuses it)', () => {
    expect(editWords(words, '   ')).toEqual([]);
    expect(tokenize(' a  b ')).toEqual(['a', 'b']);
  });
});

describe('retimeWord / shiftWords', () => {
  const words = [W('a', 0, 200), W('b', 200, 400), W('c', 400, 600)];
  it('moves one word and pushes the neighbour edges, never past them', () => {
    expect(retimeWord(words, 1, 250_000, 500_000)).toEqual([W('a', 0, 200), W('b', 250, 500), W('c', 500, 600)]);
    // cannot cross the next word's end (keeps 20 ms for it)
    const out = retimeWord(words, 1, 300_000, 900_000);
    expect(out[1]!.end).toBe(580_000);
    expect(out[2]).toEqual(W('c', 580, 600));
  });
  it('shifts all words', () => {
    expect(shiftWords(words, 1000)[2]).toEqual({ text: 'c', start: 401_000, end: 601_000 });
  });
});

describe('RTL', () => {
  it('detects Hebrew per word and per caption', () => {
    expect(isRTL('שלום')).toBe(true);
    expect(isRTL('hello')).toBe(false);
    expect(isRTL('2024')).toBe(false);
    expect(isRTLText('שלום עולם hi')).toBe(true);
    expect(isRTLText('hello עולם wide world')).toBe(false);
    expect(isRTLText('123')).toBe(false);
  });
});
