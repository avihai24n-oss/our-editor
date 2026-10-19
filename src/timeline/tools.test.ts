import { describe, expect, it } from 'vitest';
import { createAsset, createClipFromAsset, createProject, createTrack } from '../model/defaults';
import { mainTrack } from '../model/project';
import { pxToUs, secToUs, snapToFrame } from '../model/time';
import type { Clip, Track } from '../model/types';
import { SNAP_PX } from './geometry';
import { defOf, resolveShortcut, shortcutLabel } from './shortcutDefs';
import { bladeTime, clipsOnSide, svgCursor, toolDef, toolSide, toolTrims, TOOLS } from './tools';

const S = secToUs;
const k = (key: string, code: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...m,
});

describe('tool table', () => {
  it("lists CapCut's four cursor tools in dropdown order", () => {
    expect(TOOLS.map((t) => t.id)).toEqual(['select', 'split', 'selectLeft', 'selectRight']);
    expect(TOOLS.map((t) => t.label)).toEqual(['Select', 'Split', 'Select leftward', 'Select rightward']);
  });

  it('every tool has a bound shortcut in the shared table: A, B, [, ]', () => {
    expect(TOOLS.map((t) => shortcutLabel(t.command, 'mac'))).toEqual(['A', 'B', '[', ']']);
    for (const t of TOOLS) expect(defOf(t.command)?.status).toBe('works');
    expect(resolveShortcut(k('a', 'KeyA'))).toBe('toolSelect');
    expect(resolveShortcut(k('b', 'KeyB'))).toBe('toolSplit');
    expect(resolveShortcut(k('[', 'BracketLeft'))).toBe('selectLeft');
    expect(resolveShortcut(k(']', 'BracketRight'))).toBe('selectRight');
  });

  it('a held modifier never picks a tool (⌘B splits at the playhead, ⌘A selects all)', () => {
    expect(resolveShortcut(k('b', 'KeyB', { metaKey: true }))).toBe('split');
    expect(resolveShortcut(k('b', 'KeyB', { ctrlKey: true }))).toBe('split');
    expect(resolveShortcut(k('a', 'KeyA', { metaKey: true }))).toBe('selectAll');
    expect(resolveShortcut(k('B', 'KeyB', { shiftKey: true }))).toBe('curveSpeed');
    expect(resolveShortcut(k('a', 'KeyA', { altKey: true }))).toBeNull();
    expect(resolveShortcut(k('[', 'BracketLeft', { metaKey: true }))).toBeNull();
  });

  it('works on a Hebrew layout (physical keys)', () => {
    expect(resolveShortcut(k('ש', 'KeyA'))).toBe('toolSelect');
    expect(resolveShortcut(k('נ', 'KeyB'))).toBe('toolSplit');
  });

  it('select is the plain arrow; every other tool has its own SVG cursor with a hotspot', () => {
    expect(toolDef('select').cursor).toBe('default');
    const others = TOOLS.filter((t) => t.id !== 'select').map((t) => t.cursor);
    for (const c of others) expect(c).toMatch(/^url\("data:image\/svg\+xml;utf8,.+"\) \d+ \d+, [a-z-]+$/);
    expect(new Set(others).size).toBe(others.length);
    expect(toolDef('split').cursor).toMatch(/ 16 18, crosshair$/);
  });

  it('svgCursor escapes the markup so it is a valid CSS url()', () => {
    const c = svgCursor("<path d='M0 0'/>", 1, 2, 'default');
    expect(c).not.toMatch(/[<>#]/);
    expect(decodeURIComponent(c)).toContain("<path d='M0 0'/>");
  });

  it('only the Select tool drags and trims; side tools know their side', () => {
    expect(TOOLS.filter((t) => toolTrims(t.id)).map((t) => t.id)).toEqual(['select']);
    expect(toolSide('selectLeft')).toBe('left');
    expect(toolSide('selectRight')).toBe('right');
    expect(toolSide('split')).toBeNull();
    expect(toolSide('select')).toBeNull();
    expect(toolDef('nope' as never).id).toBe('select');
  });
});

describe('bladeTime', () => {
  const clip = { start: S(2), duration: S(4) };
  const zoom = 100; // px per second
  const fps = 30;

  it('cuts on a frame boundary', () => {
    const raw = S(3) + 12_345;
    expect(bladeTime(clip, raw, 0, zoom, fps, true)).toBe(snapToFrame(raw, fps));
    const t = bladeTime(clip, raw, 0, zoom, fps, true)!;
    expect(snapToFrame(t, fps)).toBe(t);
    expect(t).not.toBe(raw);
  });

  it('pulls onto the playhead within the snap distance, only with snapping on', () => {
    const playhead = S(4) + 7; // off-frame on purpose
    const near = playhead + pxToUs(SNAP_PX - 1, zoom);
    expect(bladeTime(clip, near, playhead, zoom, fps, true)).toBe(playhead);
    expect(bladeTime(clip, near, playhead, zoom, fps, false)).toBe(snapToFrame(near, fps));
    const far = playhead + pxToUs(SNAP_PX + 4, zoom);
    expect(bladeTime(clip, far, playhead, zoom, fps, true)).toBe(snapToFrame(far, fps));
  });

  it('refuses a cut on (or outside) the clip edges', () => {
    expect(bladeTime(clip, S(2), 0, zoom, fps, true)).toBeNull();
    expect(bladeTime(clip, S(6), 0, zoom, fps, true)).toBeNull();
    expect(bladeTime(clip, S(1), 0, zoom, fps, true)).toBeNull();
    expect(bladeTime(clip, S(2) + 1000, 0, zoom, fps, true)).toBeNull(); // rounds onto the start frame
    // a playhead sitting on the edge does not make the edge cuttable
    expect(bladeTime(clip, S(2) + pxToUs(2, zoom), S(2), zoom, fps, true)).toBeNull();
  });
});

describe('clipsOnSide', () => {
  function setup() {
    const vid = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(60), width: 1920, height: 1080, hasAudio: true });
    const p = createProject();
    p.assets[vid.id] = vid;
    const main = mainTrack(p);
    const overlay = createTrack('overlay');
    const locked = createTrack('overlay');
    locked.locked = true;
    p.tracks.push(overlay, locked);
    const add = (t: Track, start: number, dur: number): Clip => {
      const c = createClipFromAsset(vid, t.id, 0);
      c.trackId = t.id;
      c.start = S(start);
      c.duration = S(dur);
      t.clips.push(c);
      return c;
    };
    const a = add(main, 0, 4);
    const b = add(main, 4, 4);
    const o = add(overlay, 3, 2);
    const l = add(locked, 0, 10);
    return { p, a, b, o, l };
  }

  it('leftward takes every clip that starts before t, on every unlocked track', () => {
    const { p, a, b, o } = setup();
    expect(clipsOnSide(p, S(3.5), 'left').sort()).toEqual([a.id, o.id].sort());
    expect(clipsOnSide(p, S(4), 'left').sort()).toEqual([a.id, o.id].sort()); // b starts at t: not left
    expect(clipsOnSide(p, S(10), 'left').sort()).toEqual([a.id, b.id, o.id].sort());
    expect(clipsOnSide(p, 0, 'left')).toEqual([]);
  });

  it('rightward takes every clip that ends after t (a crossing clip counts)', () => {
    const { p, a, b, o } = setup();
    expect(clipsOnSide(p, S(3.5), 'right').sort()).toEqual([a.id, b.id, o.id].sort());
    expect(clipsOnSide(p, S(4), 'right').sort()).toEqual([b.id, o.id].sort()); // a ends at t: not right
    expect(clipsOnSide(p, S(8), 'right')).toEqual([]);
  });

  it('never takes clips on locked tracks', () => {
    const { p, l } = setup();
    expect(clipsOnSide(p, S(5), 'left')).not.toContain(l.id);
    expect(clipsOnSide(p, S(5), 'right')).not.toContain(l.id);
  });
});
