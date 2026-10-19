import { describe, expect, it } from 'vitest';
import { createAsset, createClipFromAsset, createTrack } from '../model/defaults';
import { secToUs } from '../model/time';
import type { Clip, Track } from '../model/types';
import {
  anchoredScroll,
  bandHeights,
  followScroll,
  stableContentWidth,
  clipsInSpan,
  contentWidth,
  fitZoom,
  magnetInsertCut,
  nearestCut,
  rulerScale,
  rulerTicks,
  sliderToZoom,
  speedBadge,
  zoomToSlider,
} from './geometry';
import { LIMITS } from '../model/catalog';

const S = secToUs;
const asset = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(60), width: 1920, height: 1080, hasAudio: true });

function trackWith(spans: [number, number][]): Track {
  const t = createTrack('main');
  t.clips = spans.map(([s, d]) => {
    const c = createClipFromAsset(asset, t.id, S(s));
    c.duration = S(d);
    return c as Clip;
  });
  return t;
}

describe('rulerScale', () => {
  it('labels are at least ~80px apart at every zoom', () => {
    for (const z of [2, 5, 10, 30, 60, 120, 300, 600]) {
      const sc = rulerScale(z, 30);
      expect((sc.majorUs / 1e6) * z).toBeGreaterThanOrEqual(80 - 1e-6);
      expect(sc.minorUs).toBeLessThanOrEqual(sc.majorUs);
      expect(sc.majorUs % sc.minorUs === 0 || sc.frames).toBe(true);
    }
  });
  it('uses whole seconds when zoomed out and frames when zoomed in', () => {
    expect(rulerScale(10, 30).frames).toBe(false);
    expect(rulerScale(10, 30).majorUs).toBe(S(10));
    const close = rulerScale(600, 30);
    expect(close.frames).toBe(true);
    expect(close.majorUs).toBeLessThan(S(1));
  });
  it('far out picks minutes (CapCut |00:00 |03:00 ...)', () => {
    expect(rulerScale(0.5, 30).majorUs).toBe(S(300));
  });
});

describe('rulerTicks', () => {
  it('produces labelled majors in MM:SS', () => {
    const sc = rulerScale(10, 30); // major 10 s
    const ticks = rulerTicks(0, S(30), sc, 30);
    const labels = ticks.filter((t) => t.major).map((t) => t.label);
    expect(labels).toEqual(['00:00', '00:10', '00:20', '00:30']);
    expect(ticks.length).toBeGreaterThan(labels.length);
  });
  it('labels frame ticks inside a second as Nf', () => {
    const sc = rulerScale(600, 30);
    const labels = rulerTicks(0, S(1), sc, 30)
      .filter((t) => t.major)
      .map((t) => t.label);
    expect(labels[0]).toBe('00:00');
    expect(labels.some((l) => l?.endsWith('f'))).toBe(true);
    expect(labels[labels.length - 1]).toBe('00:01');
  });
  it('starts at the window, not at 0', () => {
    const sc = rulerScale(60, 30);
    const ticks = rulerTicks(S(100), S(102), sc, 30);
    expect(ticks[0]!.t).toBeGreaterThanOrEqual(S(100) - sc.minorUs);
    expect(ticks[ticks.length - 1]!.t).toBeLessThanOrEqual(S(102));
  });
});

describe('zoom', () => {
  it('fitZoom fits the duration into the viewport and clamps', () => {
    const z = fitZoom(S(10), 1048);
    expect(z).toBeCloseTo(100, 5);
    expect(fitZoom(0, 1000)).toBe(LIMITS.zoomDefault);
    expect(fitZoom(S(100000), 1000)).toBe(LIMITS.zoomMin);
    expect(fitZoom(S(0.01), 1000)).toBe(LIMITS.zoomMax);
  });
  it('slider mapping is a monotonic log round-trip', () => {
    for (const z of [2, 10, 60, 300, 600]) expect(sliderToZoom(zoomToSlider(z))).toBeCloseTo(z, -0.5);
    expect(zoomToSlider(LIMITS.zoomMin)).toBe(0);
    expect(zoomToSlider(LIMITS.zoomMax)).toBe(1000);
    expect(zoomToSlider(60)).toBeGreaterThan(zoomToSlider(30));
  });
  it('anchoredScroll keeps a time at the same screen offset', () => {
    // 10 s at 100 px/s shown 200 px into the lane → scrollLeft 800
    expect(anchoredScroll(S(10), 200, 100)).toBe(800);
    expect(anchoredScroll(S(1), 500, 100)).toBe(0);
  });
  it('contentWidth leaves room after the end and fills the viewport, 1px short', () => {
    // 1px short so a fractional page zoom can't overflow by a sub-pixel and toggle the scrollbars
    expect(contentWidth(0, 60, 800)).toBe(799);
    expect(stableContentWidth(0, 60, 800, 0)).toBe(799);
    expect(stableContentWidth(0, 60, 800, 50)).toBe(850);
    expect(contentWidth(S(100), 60, 800)).toBeGreaterThan(6000 + 200 - 1);
  });
});

describe('followScroll (playback follows the playhead without paging)', () => {
  it('does nothing while the playhead is left of the follow point', () => {
    expect(followScroll(300, 0, 1000)).toBeNull();
    expect(followScroll(750, 0, 1000)).toBeNull();
  });
  it('glides: past 75 % of the lane the view moves by exactly the playhead step', () => {
    expect(followScroll(760, 0, 1000)).toBe(10);
    expect(followScroll(780, 10, 1000)).toBe(30);
    // successive frames never jump more than the playhead moved
    let sl = 0;
    for (let px = 700; px < 3000; px += 20) {
      const n = followScroll(px, sl, 1000);
      if (n !== null) {
        expect(n - sl).toBeLessThanOrEqual(20);
        sl = n;
      }
    }
  });
  it('brings an off-screen playhead into view 10 % from the left', () => {
    expect(followScroll(50, 400, 1000)).toBe(0);
    expect(followScroll(5000, 0, 1000)).toBe(4900);
  });
});

describe('stableContentWidth', () => {
  it('never shrinks below what is on screen (no scroll clamp when the edit gets shorter)', () => {
    expect(stableContentWidth(S(10), 100, 1000, 0)).toBe(contentWidth(S(10), 100, 1000));
    expect(stableContentWidth(S(10), 100, 1000, 4000)).toBe(5000);
  });
});

describe('bandHeights', () => {
  const area = 315;
  const base = bandHeights(area, 0, 64, 0, 28);
  const mainY = (b: { top: number }, above: number) => b.top + above;
  it('matches the empty-project layout', () => {
    expect(base.top).toBe(28 + Math.floor((315 - 64 - 56) * 0.55));
    expect(base.top + 64 + base.bottom).toBe(area);
  });
  it('keeps the main track still when an audio track is added below', () => {
    expect(mainY(bandHeights(area, 0, 64, 48, 28), 0)).toBe(mainY(base, 0));
    const tall = bandHeights(500, 0, 64, 0, 28);
    expect(mainY(bandHeights(500, 0, 64, 2 * 48, 28), 0)).toBe(mainY(tall, 0));
  });
  it('keeps the main track still when an overlay track is added above', () => {
    expect(mainY(bandHeights(area, 48, 64, 0, 28), 48)).toBe(mainY(base, 0));
    expect(mainY(bandHeights(area, 48, 64, 48, 28), 48)).toBe(mainY(base, 0));
  });
  it('moves the stack up only when it would not fit, and never below the minimum bands', () => {
    const b = bandHeights(area, 0, 64, 4 * 48, 28);
    expect(b.top + 64 + 4 * 48 + b.bottom).toBe(area);
    expect(b.bottom).toBe(28);
    const full = bandHeights(area, 3 * 48, 64, 3 * 48, 28);
    expect(full).toEqual({ top: 28, bottom: 28 });
  });
});

describe('placement helpers', () => {
  const t = trackWith([
    [0, 4],
    [4, 2],
    [6, 6],
  ]);
  it('magnetInsertCut follows the midpoint rule', () => {
    expect(magnetInsertCut(t.clips, S(1))).toBe(0);
    expect(magnetInsertCut(t.clips, S(2))).toBe(S(4));
    expect(magnetInsertCut(t.clips, S(5.5))).toBe(S(6));
    expect(magnetInsertCut(t.clips, S(100))).toBe(S(12));
  });
  it('magnetInsertCut ignores the dragged clip (repacks the rest)', () => {
    const first = t.clips[0]!.id;
    expect(magnetInsertCut(t.clips, S(100), [first])).toBe(S(8));
    expect(magnetInsertCut(t.clips, S(1.5), [first])).toBe(S(2));
  });
  it('nearestCut finds adjacent cuts within the threshold', () => {
    expect(nearestCut(t, S(4.2), S(0.5))?.at).toBe(S(4));
    expect(nearestCut(t, S(5.9), S(0.5))?.fromClipId).toBe(t.clips[1]!.id);
    expect(nearestCut(t, S(5), S(0.5))).toBeNull();
    const gap = trackWith([
      [0, 2],
      [3, 2],
    ]);
    expect(nearestCut(gap, S(2), S(1))).toBeNull();
  });
  it('clipsInSpan uses half-open overlap', () => {
    expect(clipsInSpan(t, S(4), S(6)).map((c) => c.start)).toEqual([S(4)]);
    expect(clipsInSpan(t, S(3.9), S(6.1))).toHaveLength(3);
  });
});

describe('speedBadge', () => {
  it('hides at 1x and formats like CapCut', () => {
    expect(speedBadge(1)).toBeNull();
    expect(speedBadge(2)).toBe('2.0x');
    expect(speedBadge(0.5)).toBe('0.5x');
    expect(speedBadge(25)).toBe('25x');
  });
});
