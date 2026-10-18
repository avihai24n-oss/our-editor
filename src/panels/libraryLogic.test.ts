import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { secToUs } from '../model/time';
import type { MediaAsset } from '../model/types';
import { useEditor } from '../store';
import {
  adjustToCssFilter,
  DND_ASSET_TYPE,
  DND_TYPE,
  durationBadge,
  filterCss,
  isFileDrag,
  middleEllipsis,
  parseDragPayload,
  resolveTransitionTarget,
  selectedVisualIds,
  setDragPayload,
  visibleAssets,
  waveformBars,
} from './libraryLogic';
import { ADJUST_PRESETS, FILTER_GROUPS, TEXT_PRESETS, TRANSITION_GROUPS } from './presets';
import { FILTERS, TRANSITIONS } from '../model/catalog';

const S = secToUs;
const mk = (kind: MediaAsset['kind'], name: string, sec = 0) =>
  createAsset({ kind, name, mime: '', size: 1, duration: kind === 'image' ? 0 : S(sec), width: 1920, height: 1080, hasAudio: kind !== 'image' });

describe('visibleAssets', () => {
  const list = [mk('video', 'b-clip.mp4', 10), mk('audio', 'A-song.mp3', 30), mk('image', 'c-pic.png'), mk('video', 'a10.mp4', 2), mk('video', 'a2.mp4', 5)];

  it('keeps insertion order for "added"', () => {
    expect(visibleAssets(list, { kind: 'all', query: '', sort: 'added' }).map((a) => a.name)).toEqual(list.map((a) => a.name));
  });
  it('filters by kind and query (case-insensitive)', () => {
    expect(visibleAssets(list, { kind: 'video', query: '', sort: 'added' })).toHaveLength(3);
    expect(visibleAssets(list, { kind: 'all', query: 'SONG', sort: 'added' }).map((a) => a.name)).toEqual(['A-song.mp3']);
    expect(visibleAssets(list, { kind: 'audio', query: 'clip', sort: 'added' })).toEqual([]);
  });
  it('sorts by name naturally, by duration desc, by type', () => {
    expect(visibleAssets(list, { kind: 'video', query: '', sort: 'name' }).map((a) => a.name)).toEqual(['a2.mp4', 'a10.mp4', 'b-clip.mp4']);
    expect(visibleAssets(list, { kind: 'all', query: '', sort: 'duration' })[0]!.name).toBe('A-song.mp3');
    expect(visibleAssets(list, { kind: 'all', query: '', sort: 'type' }).map((a) => a.kind)).toEqual(['video', 'video', 'video', 'image', 'audio']);
  });
  it('does not mutate the input', () => {
    const copy = [...list];
    visibleAssets(list, { kind: 'all', query: '', sort: 'name' });
    expect(list).toEqual(copy);
  });
});

describe('labels', () => {
  it('middle-ellipsises long names and keeps short ones', () => {
    expect(middleEllipsis('short.mp4')).toBe('short.mp4');
    const s = middleEllipsis('shabbat-candle-lighting-en-t1.mp3', 22);
    expect(s).toHaveLength(22);
    expect(s.startsWith('shabbat')).toBe(true);
    expect(s.endsWith('t1.mp3')).toBe(true);
    expect(s).toContain('...');
  });
  it('duration badge for timed media only', () => {
    expect(durationBadge({ kind: 'video', duration: S(10.4) })).toBe('00:10');
    expect(durationBadge({ kind: 'image', duration: 0 })).toBeNull();
  });
  it('waveform bars are deterministic and in range', () => {
    const a = waveformBars('ast_1');
    expect(a).toEqual(waveformBars('ast_1'));
    expect(a).not.toEqual(waveformBars('ast_2'));
    expect(a.every((h) => h >= 0.15 && h <= 1)).toBe(true);
  });
});

describe('drag payload', () => {
  const dt = () => {
    const data: Record<string, string> = {};
    return { data, setData: (t: string, d: string) => void (data[t] = d), effectAllowed: '' };
  };
  it('writes the JSON contract and the bare asset id', () => {
    const d = dt();
    setDragPayload(d, { kind: 'asset', assetId: 'ast_9' });
    expect(JSON.parse(d.data[DND_TYPE]!)).toEqual({ kind: 'asset', assetId: 'ast_9' });
    expect(d.data[DND_ASSET_TYPE]).toBe('ast_9');
    expect(d.effectAllowed).toBe('copy');
  });
  it('round-trips through parseDragPayload and rejects junk', () => {
    expect(parseDragPayload(JSON.stringify({ kind: 'transition', type: 'mix' }))).toEqual({ kind: 'transition', type: 'mix' });
    expect(parseDragPayload(JSON.stringify({ kind: 'text', preset: 'neon' }))).toEqual({ kind: 'text', preset: 'neon' });
    expect(parseDragPayload('nope')).toBeNull();
    expect(parseDragPayload(JSON.stringify({ kind: 'asset' }))).toBeNull();
    expect(parseDragPayload(null)).toBeNull();
  });
  it('detects OS file drags', () => {
    expect(isFileDrag(['Files'])).toBe(true);
    expect(isFileDrag([DND_TYPE])).toBe(false);
  });
});

describe('css previews', () => {
  it('neutral adjust → none', () => {
    expect(adjustToCssFilter({})).toBe('none');
  });
  it('maps the main controls', () => {
    const css = adjustToCssFilter({ brightness: 20, contrast: -20, saturation: 50 }, { grayscale: 1 });
    expect(css).toContain('brightness(1.2)');
    expect(css).toContain('contrast(0.8)');
    expect(css).toContain('saturate(2)');
    expect(css).toContain('grayscale(1)');
  });
  it('every built-in filter has a preview', () => {
    for (const f of FILTERS) expect(filterCss(f.id)).not.toBe('none');
  });
});

describe('preset catalogues', () => {
  it('groups cover every transition and filter exactly once', () => {
    expect(TRANSITION_GROUPS.flatMap((g) => g.types).sort()).toEqual(TRANSITIONS.map((t) => t.id).sort());
    expect(FILTER_GROUPS.flatMap((g) => g.ids).sort()).toEqual(FILTERS.map((f) => f.id).sort());
  });
  it('text presets and adjust presets have unique ids', () => {
    expect(new Set(TEXT_PRESETS.map((p) => p.id)).size).toBe(TEXT_PRESETS.length);
    expect(new Set(ADJUST_PRESETS.map((p) => p.id)).size).toBe(ADJUST_PRESETS.length);
    expect(TEXT_PRESETS[0]!.id).toBe('default');
  });
});

describe('apply targets (store-backed)', () => {
  const st = () => useEditor.getState();
  beforeEach(() => st().newProject());

  function twoOnMain() {
    const a = mk('video', 'a.mp4', 4);
    const b = mk('video', 'b.mp4', 4);
    st().addAssets([a, b]);
    const c1 = st().addClip(a.id, { at: 0 })!;
    const c2 = st().addClip(b.id, { at: S(10) })!;
    return { c1, c2 };
  }

  it('selected clip → cut after it; last clip → cut before it', () => {
    const { c1, c2 } = twoOnMain();
    const p = st().project;
    expect(resolveTransitionTarget(p, { clipIds: [c1], transitionId: null }, 0)).toEqual({ mode: 'add', fromClipId: c1 });
    expect(resolveTransitionTarget(p, { clipIds: [c2], transitionId: null }, 0)).toEqual({ mode: 'add', fromClipId: c1 });
  });
  it('no selection → main-track cut nearest the playhead; selected transition → update', () => {
    const { c1 } = twoOnMain();
    expect(resolveTransitionTarget(st().project, { clipIds: [], transitionId: null }, S(100))).toEqual({ mode: 'add', fromClipId: c1 });
    expect(resolveTransitionTarget(st().project, { clipIds: [], transitionId: 'trn_x' }, 0)).toEqual({ mode: 'update', transitionId: 'trn_x' });
  });
  it('single clip, nothing adjacent → null', () => {
    const a = mk('video', 'a.mp4', 4);
    st().addAssets([a]);
    const c = st().addClip(a.id, { at: 0 })!;
    expect(resolveTransitionTarget(st().project, { clipIds: [c], transitionId: null }, 0)).toBeNull();
    expect(resolveTransitionTarget(st().project, { clipIds: [], transitionId: null }, 0)).toBeNull();
  });
  it('selectedVisualIds drops audio clips and missing ids', () => {
    const v = mk('video', 'v.mp4', 3);
    const au = mk('audio', 'a.mp3', 3);
    st().addAssets([v, au]);
    const cv = st().addClip(v.id, { at: 0 })!;
    const ca = st().addClip(au.id, { at: 0 })!;
    const t = st().addTextClip({ at: 0 });
    expect(selectedVisualIds(st().project, [cv, ca, t, 'nope'])).toEqual([cv, t]);
  });
});
