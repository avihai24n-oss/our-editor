import { describe, expect, it } from 'vitest';
import { formatTimestamp, parseSubtitles, parseTimestamp, parseWordJson, spreadWords, toSrt, toVtt, toWordJson, type CueIn } from './srt';
import { downmix, encodeWav, resample } from './wav';

const cues: CueIn[] = [
  { start: 180_000, end: 1_280_000, text: 'שלום לכולם,', words: [{ text: 'שלום', start: 180_000, end: 360_000 }, { text: 'לכולם,', start: 520_000, end: 820_000 }] },
  { start: 1_280_000, end: 3_723_456, text: 'Then it rests' },
  { start: 3_661_001_000, end: 3_662_000_000, text: 'an hour later' },
];

describe('timestamps', () => {
  it('formats SRT / VTT and parses every common form', () => {
    expect(formatTimestamp(3_723_456)).toBe('00:00:03,723');
    expect(formatTimestamp(3_661_001_000, '.')).toBe('01:01:01.001');
    expect(parseTimestamp('00:00:03,723')).toBe(3_723_000);
    expect(parseTimestamp('01:02.5')).toBe(62_500_000);
    expect(parseTimestamp('1:01:01.001')).toBe(3_661_001_000);
    expect(parseTimestamp('nope')).toBeNaN();
  });
});

describe('SRT / VTT', () => {
  it('round trip: toSrt → parseSubtitles gives the same cues (ms precision)', () => {
    const back = parseSubtitles(toSrt(cues));
    expect(back.map((c) => c.text)).toEqual(cues.map((c) => c.text));
    back.forEach((c, i) => {
      expect(Math.abs(c.start - cues[i]!.start)).toBeLessThan(1000);
      expect(Math.abs(c.end - cues[i]!.end)).toBeLessThan(1000);
    });
    const vtt = toVtt(cues);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(parseSubtitles(vtt).map((c) => c.text)).toEqual(cues.map((c) => c.text));
  });

  it('reads BOM, CRLF, tags, multi-line cues, cue settings, and skips broken cues', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>שורה אחת</i>\r\nשורה שתיים\r\n\r\n2\r\n00:00:05,000 --> 00:00:04,000\r\nbackwards\r\n\r\n3\r\n00:00:06,000 --> 00:00:07,000 align:start\r\n{\\an8}top\r\n';
    expect(parseSubtitles(srt)).toEqual([
      { start: 1_000_000, end: 2_500_000, text: 'שורה אחת\nשורה שתיים' },
      { start: 6_000_000, end: 7_000_000, text: 'top' },
    ]);
  });
});

describe('word JSON', () => {
  it('keeps each word timing and reads back', () => {
    const j = toWordJson(cues, 'he');
    expect(j.language).toBe('he');
    expect(j.captions[0]!.words).toEqual([
      { text: 'שלום', start: 0.18, end: 0.36 },
      { text: 'לכולם,', start: 0.52, end: 0.82 },
    ]);
    const back = parseWordJson(JSON.stringify(j))!;
    expect(back[0]!.words).toEqual(cues[0]!.words);
    expect(parseWordJson('{"x":1}')).toBeNull();
    expect(parseWordJson('1\n00:00')).toBeNull();
  });

  it('spreads untimed cue words by length', () => {
    expect(spreadWords('ab abcd', 0, 600_000)).toEqual([
      { text: 'ab', start: 0, end: 200_000 },
      { text: 'abcd', start: 200_000, end: 600_000 },
    ]);
  });
});

describe('wav', () => {
  it('writes a mono 16-bit PCM header and clamps samples', () => {
    const buf = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 8);
    expect(String.fromCharCode(...new Uint8Array(buf, 0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
    expect(v.getInt16(50, true)).toBe(32767);
  });

  it('down-mixes and resamples 48 kHz → 16 kHz', () => {
    const l = new Float32Array(48_000).fill(0.5);
    const r = new Float32Array(48_000).fill(-0.5);
    expect(downmix([l, r])[10]).toBe(0);
    const out = resample(l, 48_000, 16_000);
    expect(out.length).toBe(16_000);
    expect(out[100]).toBeCloseTo(0.5);
  });
});
