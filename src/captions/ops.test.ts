import { beforeEach, describe, expect, it } from 'vitest';
import { getFrameState, type TextDrawOp } from '../engine/frameState';
import { migrateProject } from '../model/project';
import { clipEnd } from '../model/time';
import type { Project } from '../model/types';
import { useEditor } from '../store';
import { DEFAULT_GROUPING, isCaptionClip, timelineWords, visibleWords, type CaptionClip } from './model';
import * as cops from './ops';
import type { CaptionWord } from './types';
import oldProject from '../model/__fixtures__/saved-integration.json';

const st = () => useEditor.getState();
const W = (text: string, startMs: number, endMs: number): CaptionWord => ({ text, start: startMs * 1000, end: endMs * 1000 });
const edit = <T,>(fn: (d: Project) => T): T => st().editProject((d) => fn(d));
const track = () => st().project.tracks.find((t) => t.captions)!;
const caps = () => track().clips.filter(isCaptionClip) as CaptionClip[];
const texts = () => caps().map((c) => c.text.content);

/** "a b. c d e f g. h" spoken one word per 300 ms from 1 s, with a pause before "h". */
const WORDS = [W('a', 1000, 1200), W('b.', 1300, 1500), W('c', 1600, 1800), W('d', 1900, 2100), W('e', 2200, 2400), W('f', 2500, 2700), W('g.', 2800, 3000), W('h', 5000, 5400)];

beforeEach(() => {
  st().newProject({ aspect: '9:16' });
});

describe('placing a transcription', () => {
  it('creates the caption track and one clip per group, words where they were said', () => {
    const ids = edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
    expect(ids).toHaveLength(4);
    expect(track().name).toBe('Captions');
    expect(track().kind).toBe('text');
    expect(track().captions!.style.preset).toBe('karaoke');
    expect(texts()).toEqual(['a b.', 'c d e f', 'g.', 'h']);
    expect(caps().flatMap((c) => timelineWords(c))).toEqual(WORDS);
    // bridged gaps, then a 0.5 s hold, no overlaps
    expect(caps().map((c) => [c.start, clipEnd(c)])).toEqual([
      [1_000_000, 1_600_000],
      [1_600_000, 2_800_000],
      [2_800_000, 3_500_000],
      [5_000_000, 5_900_000],
    ]);
    expect(st().past.length).toBe(1); // one undo step
    st().undo();
    expect(st().project.tracks.some((t) => t.captions)).toBe(false);
  });

  it('a re-run replaces only its range; captions crossing the edges are cut back to it', () => {
    edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
    const again = [W('C', 1600, 1800), W('D', 1900, 2100)];
    edit((d) => cops.placeTranscription(d, again, { start: 1_700_000, end: 2_600_000 }, DEFAULT_GROUPING));
    const c = caps();
    // 'c d e f' (1.6–2.8 s) crossed both edges: its tail after the range stays ("f"); its head
    // before it held no whole word (c is centred on 1.7 s) and goes; "C" (1.6–1.8) counts as in the
    // range (its middle is), and the new caption never starts before the range
    expect(c.map((x) => [x.start, clipEnd(x), x.text.content])).toEqual([
      [1_000_000, 1_600_000, 'a b.'],
      [1_700_000, 2_600_000, 'C D'],
      [2_600_000, 2_800_000, 'f'],
      [2_800_000, 3_500_000, 'g.'],
      [5_000_000, 5_900_000, 'h'],
    ]);
    // the cut-back tail still plays "f" at 2.5 s
    expect(visibleWords(c[2]!)).toEqual([W("f", 2500, 2700)]);
  });

  it('refuses a locked caption track (makes a new one instead)', () => {
    edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
    st().setTrack(track().id, { locked: true });
    expect(edit((d) => cops.editCaptionText(d, caps()[0]!.id, 'x y'))).toBe(false);
    edit((d) => cops.placeTranscription(d, [W('z', 0, 500)], { start: 0, end: 900_000 }, DEFAULT_GROUPING));
    expect(st().project.tracks.filter((t) => t.captions)).toHaveLength(2);
  });
});

describe('timeline edits keep the words on their sound', () => {
  beforeEach(() => {
    edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
  });

  it('trim the left edge: the trimmed words disappear, the rest stay put; extend back brings them back', () => {
    st().setMagnet(false);
    const c = caps()[1]!; // c d e f, 1.6–2.8
    st().trimStart(c.id, 2_150_000);
    const t = caps()[1]!;
    expect(t.start).toBe(2_150_000);
    expect(visibleWords(t)).toEqual([W('e', 2200, 2400), W('f', 2500, 2700)]);
    expect(t.text.content).toBe('e f');
    st().trimStart(c.id, 1_600_000);
    expect(visibleWords(caps()[1]!)).toEqual([W('c', 1600, 1800), W('d', 1900, 2100), W('e', 2200, 2400), W('f', 2500, 2700)]);
  });

  it('split (⌘B) at 2.15 s: each part shows its own words at the same times', () => {
    const c = caps()[1]!;
    const b = st().splitClip(c.id, 2_150_000)!;
    const all = caps();
    const right = all.find((x) => x.id === b)!;
    const left = all.find((x) => x.id === c.id)!;
    expect(visibleWords(left)).toEqual([W('c', 1600, 1800), W('d', 1900, 2100)]);
    expect(visibleWords(right)).toEqual([W('e', 2200, 2400), W('f', 2500, 2700)]);
    expect([left.text.content, right.text.content]).toEqual(['c d', 'e f']);
  });

  it('move: the words go with the clip', () => {
    const h = caps()[3]!;
    st().moveClip(h.id, { start: 4_000_000, trackId: track().id });
    expect(visibleWords(caps()[3]!)).toEqual([W('h', 4000, 4400)]);
  });
});

describe('the caption lab', () => {
  beforeEach(() => {
    edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
  });

  it('edits the text, keeping timings', () => {
    const id = caps()[1]!.id;
    expect(edit((d) => cops.editCaptionText(d, id, 'c D e f'))).toBe(true);
    expect(visibleWords(caps()[1]!)).toEqual([W('c', 1600, 1800), W('D', 1900, 2100), W('e', 2200, 2400), W('f', 2500, 2700)]);
    expect(caps()[1]!.text.content).toBe('c D e f');
    expect(edit((d) => cops.editCaptionText(d, id, '  '))).toBe(false);
    expect(edit((d) => cops.setWordText(d, id, 0, 'see'))).toBe(true);
    expect(caps()[1]!.text.content).toBe('see D e f');
  });

  it('splits before a word and merges back', () => {
    const id = caps()[1]!.id;
    const b = edit((d) => cops.splitCaption(d, id, 2))!;
    expect(texts()).toEqual(['a b.', 'c d', 'e f', 'g.', 'h']);
    const right = caps().find((x) => x.id === b)!;
    expect(right.start).toBe(2_200_000);
    expect(clipEnd(caps()[1]!)).toBe(2_200_000);
    expect(visibleWords(right)).toEqual([W('e', 2200, 2400), W('f', 2500, 2700)]);
    expect(edit((d) => cops.splitCaption(d, id, 0))).toBeNull();
    expect(edit((d) => cops.mergeWithNext(d, id))).toBe(true);
    expect(texts()).toEqual(['a b.', 'c d e f', 'g.', 'h']);
    expect(visibleWords(caps()[1]!)).toEqual(WORDS.slice(2, 6));
    expect([caps()[1]!.start, clipEnd(caps()[1]!)]).toEqual([1_600_000, 2_800_000]);
  });

  it('retimes a word inside its caption', () => {
    const id = caps()[1]!.id;
    edit((d) => cops.retimeCaptionWord(d, id, 0, 1_650_000, 1_850_000));
    expect(visibleWords(caps()[1]!)[0]).toEqual(W('c', 1650, 1850));
    // clamped to the caption's span and the next word
    edit((d) => cops.retimeCaptionWord(d, id, 0, 1_000_000, 3_000_000));
    const w = visibleWords(caps()[1]!);
    expect(w[0]!.start).toBe(1_600_000);
    expect(w[0]!.end).toBe(w[1]!.start);
  });

  it('nudges captions without overlapping neighbours; the whole track as a sync offset', () => {
    const t = track().id;
    const g = caps()[2]!; // g. 2.8–3.5, next h at 5.0
    edit((d) => cops.nudgeCaptions(d, t, [g.id], 2_000_000));
    expect(caps()[2]!.start).toBe(2_800_000 + 1_500_000); // stopped by "h"
    edit((d) => cops.nudgeCaptions(d, t, [], -5_000_000));
    expect(caps()[0]!.start).toBe(0); // the whole track, stopped at 0
    expect(visibleWords(caps()[0]!)).toEqual([W('a', 0, 200), W('b.', 300, 500)]);
  });

  it('re-splits the track with other limits, timings kept', () => {
    const ids = edit((d) => cops.resplitCaptions(d, track().id, { ...DEFAULT_GROUPING, maxWords: 2 }));
    expect(ids.length).toBe(5);
    expect(texts()).toEqual(['a b.', 'c d', 'e f', 'g.', 'h']);
    expect(caps().flatMap((c) => visibleWords(c))).toEqual(WORDS);
    expect(caps().every((c) => visibleWords(c).length <= 2)).toBe(true);
  });

  it('style: preset for the track, override for one caption', () => {
    const t = track().id;
    edit((d) => cops.applyPreset(d, t, 'hormozi'));
    expect(track().captions!.style.uppercase).toBe(true);
    expect(track().captions!.style.animation).toBe('pop-highlight');
    edit((d) => cops.setCaptionTrack(d, t, { style: { highlightColor: '#00E5A0', stroke: { enabled: true } as never } }));
    expect(track().captions!.style.highlightColor).toBe('#00E5A0');
    expect(track().captions!.style.stroke).toMatchObject({ enabled: true, color: '#000000' });
    const id = caps()[0]!.id;
    edit((d) => cops.setCaptionOverride(d, id, { y: 0.2 }));
    const fs = getFrameState(st().project, 1_100_000);
    const op = fs.ops.find((o) => o.kind === 'text') as TextDrawOp;
    expect(op.caption!.style.y).toBe(0.2);
    expect(op.caption!.style.highlightColor).toBe('#00E5A0');
    edit((d) => cops.setCaptionOverride(d, id, null));
    expect(caps()[0]!.caption.style).toBeUndefined();
  });
});

describe('files and export', () => {
  it('cues out, cues in', () => {
    edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
    const cues = cops.captionCues(st().project);
    expect(cues.map((c) => c.text)).toEqual(['a b.', 'c d e f', 'g.', 'h']);
    expect(cues[1]!.words).toEqual(WORDS.slice(2, 6));
    edit((d) => cops.clearCaptions(d, track().id));
    expect(caps()).toHaveLength(0);
    edit((d) => cops.importCues(d, cues));
    expect(cops.captionCues(st().project)).toEqual(cues);
  });

  it('burn-in off hides the caption track in the export project only', () => {
    edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
    const p = st().project;
    expect(cops.withoutPreviewOnlyCaptions(p)).toBe(p);
    edit((d) => cops.setCaptionTrack(d, track().id, { burnIn: false }));
    const out = cops.withoutPreviewOnlyCaptions(st().project);
    expect(out.tracks.find((t) => t.captions)!.hidden).toBe(true);
    expect(getFrameState(out, 1_100_000).ops.some((o) => o.kind === 'text')).toBe(false);
    expect(getFrameState(st().project, 1_100_000).ops.some((o) => o.kind === 'text')).toBe(true);
  });
});

describe('render contract + compatibility', () => {
  it('the caption op carries the words, the time and the style position', () => {
    edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
    const fs = getFrameState(st().project, 1_350_000);
    const op = fs.ops.find((o) => o.kind === 'text') as TextDrawOp;
    expect(op.caption!.words).toEqual([W('a', 1000, 1200), W('b.', 1300, 1500)]);
    expect(op.caption!.now).toBe(1_350_000);
    expect(op.caption!.rtl).toBe(false);
    const { height } = st().project.settings;
    expect(op.transform.y).toBeCloseTo((0.8 - 0.5) * height);
  });

  it('old projects load unchanged; a project with captions survives JSON + migration', () => {
    const old = (oldProject as unknown as { project: Project }).project;
    const m = migrateProject(old);
    expect(m.tracks.some((t) => t.captions)).toBe(false);
    edit((d) => cops.placeTranscription(d, WORDS, { start: 0, end: 6_000_000 }, DEFAULT_GROUPING));
    const json = JSON.parse(JSON.stringify(st().project)) as Project;
    const back = migrateProject(json);
    expect(back.tracks.find((t) => t.captions)!.clips.map((c) => (c.type === 'text' ? c.caption?.words.length : 0))).toEqual([2, 4, 1, 1]);
  });
});
