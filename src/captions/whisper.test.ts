import { describe, expect, it } from 'vitest';
import carmit from './__fixtures__/whisper-he-carmit.json';
import nisan from './__fixtures__/whisper-he-nisan.json';
import samantha from './__fixtures__/whisper-en-samantha.json';
import scribe from './__fixtures__/scribe-he-nisan.json';
import { parseWhisperJson, whisperLanguage, type WhisperJson } from './whisper';

/**
 * Fixtures are real whisper.cpp outputs (large-v3-turbo, -nfa -dtw large.v3.turbo -ojf) of:
 *  - carmit:   macOS `say -v Carmit` reading a Hebrew sentence (made for these tests);
 *  - nisan:    an ElevenLabs Hebrew narration take from the Tiferet project ("ברוכים הבאים…"),
 *              with ElevenLabs Scribe's word timings as the reference (scribe-he-nisan.json);
 *  - samantha: macOS `say -v Samantha`, English, with 1.5 s and 0.8 s pauses (speech resumes at
 *              4.18 s and 6.28 s, measured with ffmpeg silencedetect).
 */
const s = (us: number) => us / 1e6;

describe('parseWhisperJson', () => {
  it('Hebrew: BPE tokens merge into whole words (no fragments), in order, punctuation kept on the word', () => {
    const words = parseWhisperJson(carmit as WhisperJson);
    expect(words.map((w) => w.text).join(' ')).toBe('שלום לכולם, היום נספר לכם סיפור על בית הכנסת בירושלים, ועל המשפחה שבנתה אותו.');
    expect(words).toHaveLength(14);
    for (let i = 0; i < words.length; i++) {
      expect(words[i]!.end).toBeGreaterThan(words[i]!.start);
      if (i) expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.end);
    }
    expect(s(words[words.length - 1]!.end)).toBeLessThan(6.6); // the file is 6.53 s
    expect(whisperLanguage(carmit as WhisperJson)).toBe('he');
  });

  it('Hebrew narration: word timings within ~50 ms of ElevenLabs Scribe (DTW alignment)', () => {
    const words = parseWhisperJson(nisan as WhisperJson);
    const norm = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '');
    expect(words.map((w) => norm(w.text))).toEqual(scribe.map((w) => norm(w.text)));
    const startErr = words.map((w, i) => Math.abs(s(w.start) - scribe[i]!.start));
    const endErr = words.map((w, i) => Math.abs(s(w.end) - scribe[i]!.end));
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(startErr)).toBeLessThan(0.06);
    expect(mean(endErr)).toBeLessThan(0.06);
    expect(Math.max(...startErr)).toBeLessThan(0.2);
    expect(Math.max(...endErr)).toBeLessThan(0.3); // the last word ("בק.") ends 0.26 s early: DTW marks its onset
  });

  it('English: a word after a pause starts when the speech resumes, not when whisper\'s segment does', () => {
    const words = parseWhisperJson(samantha as WhisperJson);
    expect(words.map((w) => w.text).join(' ')).toMatch(/^The quick brown fox jumps over the lazy dog\. Then it rests for a moment\.? and runs home again\.$/i);
    const then = words.find((w) => w.text === 'Then')!;
    expect(Math.abs(s(then.start) - 4.18)).toBeLessThan(0.15);
    const dog = words.find((w) => w.text.startsWith('dog'))!;
    expect(s(dog.end)).toBeLessThan(2.7); // the speech stops at 2.45 s; whisper's own times run to 4.24 s
    const and = words.find((w) => /^and$/i.test(w.text))!;
    expect(Math.abs(s(and.start) - 6.28)).toBeLessThan(0.15);
  });

  it('falls back to token offsets without DTW and to the segment text without tokens', () => {
    const json: WhisperJson = {
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: ' שלום עולם',
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { text: ' של', offsets: { from: 100, to: 300 }, t_dtw: -1 },
            { text: 'ום', offsets: { from: 300, to: 450 }, t_dtw: -1 },
            { text: ' עולם', offsets: { from: 500, to: 900 }, t_dtw: -1 },
            { text: '.', offsets: { from: 900, to: 950 }, t_dtw: -1 },
          ],
        },
        { offsets: { from: 2000, to: 3000 }, text: ' good morning' },
      ],
    };
    expect(parseWhisperJson(json)).toEqual([
      { text: 'שלום', start: 100_000, end: 450_000 },
      { text: 'עולם.', start: 500_000, end: 900_000 },
      { text: 'good', start: 2_000_000, end: 2_364_000 },
      { text: 'morning', start: 2_364_000, end: 3_000_000 },
    ]);
  });

  it('repairs a word whose token held half a letter (U+FFFD) from the segment text', () => {
    const json: WhisperJson = {
      transcription: [
        {
          offsets: { from: 0, to: 800 },
          text: ' אבג דהו',
          tokens: [
            { text: ' א�', offsets: { from: 0, to: 200 }, t_dtw: 20 },
            { text: '�ג', offsets: { from: 200, to: 300 }, t_dtw: 30 },
            { text: ' דהו', offsets: { from: 300, to: 700 }, t_dtw: 70 },
          ],
        },
      ],
    };
    expect(parseWhisperJson(json).map((w) => w.text)).toEqual(['אבג', 'דהו']);
  });
});
