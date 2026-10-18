import { describe, expect, it } from 'vitest';
import { createProject, createTextClip } from './defaults';
import {
  clipAtTime,
  clipContains,
  clipEnd,
  clipsAtTime,
  formatShort,
  formatTimecode,
  frameToUs,
  nextEditPoint,
  parseTimecode,
  prevEditPoint,
  projectDuration,
  secToUs,
  snapCandidates,
  snapRange,
  snapTime,
  snapToFrame,
  sourceTimeAt,
  usToFrame,
  usToSec,
} from './time';

const S = secToUs;

describe('conversion', () => {
  it('sec <-> us are integers and round-trip', () => {
    expect(secToUs(0.1 + 0.2)).toBe(300000);
    expect(usToSec(S(2.5))).toBe(2.5);
  });
  it('frames', () => {
    expect(frameToUs(1, 30)).toBe(33333);
    expect(usToFrame(frameToUs(1, 30), 30)).toBe(1);
    expect(usToFrame(frameToUs(45, 30), 30)).toBe(45);
    expect(usToFrame(S(1), 25)).toBe(25);
    expect(snapToFrame(S(1) + 10000, 30)).toBe(S(1));
    expect(snapToFrame(S(1) + 20000, 30)).toBe(frameToUs(31, 30));
  });
});

describe('timecode', () => {
  it('formats HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(S(1) + frameToUs(15, 30), 30)).toBe('00:00:01:15');
    expect(formatTimecode(S(3661), 30)).toBe('01:01:01:00');
    expect(formatTimecode(-5, 30)).toBe('00:00:00:00');
    expect(formatTimecode(S(396), 30)).toBe('00:06:36:00');
  });
  it('short form', () => {
    expect(formatShort(S(9.9))).toBe('00:09');
    expect(formatShort(S(75))).toBe('01:15');
    expect(formatShort(S(3725))).toBe('1:02:05');
  });
  it('parses', () => {
    expect(parseTimecode('00:00:01:15', 30)).toBe(S(1) + frameToUs(15, 30));
    expect(parseTimecode('01:30', 30)).toBe(S(90));
    expect(parseTimecode('2.5', 30)).toBe(S(2.5));
    expect(parseTimecode('abc', 30)).toBeNull();
  });
});

describe('clip time', () => {
  const clip = { start: S(2), duration: S(3), inPoint: S(1), speed: 2 };
  it('end / contains are half-open', () => {
    expect(clipEnd(clip)).toBe(S(5));
    expect(clipContains(clip, S(2))).toBe(true);
    expect(clipContains(clip, S(5))).toBe(false);
    expect(clipContains(clip, S(1.999))).toBe(false);
  });
  it('source time accounts for in-point and speed', () => {
    expect(sourceTimeAt(clip, S(2))).toBe(S(1));
    expect(sourceTimeAt(clip, S(3))).toBe(S(3));
  });
  it('lookups over a project', () => {
    const p = createProject();
    const main = p.tracks[0]!;
    const a = createTextClip(main.id, 0, 'a', S(2));
    const b = createTextClip(main.id, S(2), 'b', S(3));
    main.clips.push(a, b);
    expect(clipAtTime(main, S(1))?.id).toBe(a.id);
    expect(clipAtTime(main, S(2))?.id).toBe(b.id);
    expect(clipAtTime(main, S(5))).toBeUndefined();
    expect(clipsAtTime(p, S(4)).map((x) => x.clip.id)).toEqual([b.id]);
    expect(projectDuration(p)).toBe(S(5));
    expect(prevEditPoint(p, S(3))).toBe(S(2));
    expect(nextEditPoint(p, S(3))).toBe(S(5));
    expect(nextEditPoint(p, S(9))).toBe(S(9));
  });
});

describe('snapping', () => {
  it('snaps within threshold only', () => {
    expect(snapTime(S(1.05), [0, S(1)], S(0.1))).toEqual({ time: S(1), snapped: true, target: S(1) });
    expect(snapTime(S(1.5), [0, S(1)], S(0.1)).snapped).toBe(false);
  });
  it('snaps a range by either edge', () => {
    const r = snapRange(S(0.95), S(2), [S(3)], S(0.1));
    expect(r).toEqual({ start: S(1), snapped: true, target: S(3) });
    expect(snapRange(S(0.02), S(2), [0, S(3)], S(0.1)).start).toBe(0);
  });
  it('candidates include playhead, clip edges, markers; exclude given clips', () => {
    const p = createProject();
    const main = p.tracks[0]!;
    const a = createTextClip(main.id, S(1), 'a', S(2));
    main.clips.push(a);
    p.markers.push({ id: 'm', time: S(7), color: '#fff' });
    expect(snapCandidates(p, S(5))).toEqual([0, S(1), S(3), S(5), S(7)]);
    expect(snapCandidates(p, S(5), [a.id])).toEqual([0, S(5), S(7)]);
  });
});
