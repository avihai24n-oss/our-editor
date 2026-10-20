import { describe, expect, it } from 'vitest';
import { projectDuration } from '../../model/time';
import { projectViolations } from '../../store/invariants';
import draft from './__fixtures__/ep07-1018.json';
import { convertCapcutDraft, displayNameOf, formatReport, placeholderResolver } from './convert';
import type { CcDraft } from './types';

const FOLDER = '/Users/avihaielnekave/Movies/CapCut/User Data/Projects/com.lveditor.draft/1018';
const r = convertCapcutDraft(draft as unknown as CcDraft, placeholderResolver(FOLDER), { name: '1018' });
const main = r.project.tracks.find((t) => t.kind === 'main')!;
const audio = r.project.tracks.filter((t) => t.kind === 'audio');

describe('CapCut draft 1018 (episode 7)', () => {
  it('keeps the tracks and segments', () => {
    expect(r.project.tracks.map((t) => t.kind)).toEqual(['main', 'audio', 'audio']);
    expect(main.clips).toHaveLength(29);
    expect(main.clips.filter((c) => c.type === 'video')).toHaveLength(24);
    expect(main.clips.filter((c) => c.type === 'image')).toHaveLength(4);
    expect(main.clips.filter((c) => c.type === 'compound')).toHaveLength(1);
    expect(audio.map((t) => t.clips.length)).toEqual([1, 1]);
    expect(r.assets).toHaveLength(23);
    expect(r.project.markers.map((m) => m.time)).toEqual([17433333]);
  });

  it('total duration is 182.1 s', () => {
    expect(projectDuration(r.project)).toBe(182_100_000);
  });

  it('exact timings, in-points and speeds', () => {
    const segs = (draft as unknown as CcDraft).tracks![0]!.segments;
    main.clips.forEach((c, i) => {
      expect(c.start).toBe(segs[i]!.target_timerange!.start);
      // the compound clip is 1 µs shorter: its subproject ends at 4 733 333 µs
      expect(Math.abs(c.duration - segs[i]!.target_timerange!.duration!)).toBeLessThanOrEqual(1);
    });
    const c1 = main.clips[1]!;
    expect(c1.type === 'video' && c1.inPoint).toBe(833333);
    const c13 = main.clips[13]!;
    expect(c13.type === 'video' && c13.inPoint).toBe(6600000);
    expect(c13.type === 'video' && c13.speed).toBeCloseTo(2100000 / 1733333, 9);
    const music = audio[0]!.clips[0]!;
    expect(music.type === 'audio' && music.inPoint).toBe(1100000);
    expect(music.type === 'audio' && music.audio.volumeDb).toBeCloseTo(-9.89, 1);
    expect(main.clips[28]!.disabled).toBe(true);
  });

  it('satisfies the model invariants', () => {
    expect(projectViolations(r.project, { magnet: true })).toEqual([]);
  });

  it('names blank files and writes a report', () => {
    expect(displayNameOf('/x/sh-mayor/after-ai/ .mp4')).toBe('sh-mayor-untitled.mp4');
    expect(formatReport(r.report)[0]).toMatch(/^Imported 29 clips/);
  });
});
