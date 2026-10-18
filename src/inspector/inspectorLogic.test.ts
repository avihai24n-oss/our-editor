import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { secToUs } from '../model/time';
import { useEditor } from '../store';
import { normalizeHex } from './controls/ColorInput';
import { fromPct, parseNumber, toPct } from './controls/format';
import {
  alignPosition,
  animationMax,
  applyAllTargets,
  clipTabs,
  dialAngle,
  displayedBox,
  fadeMax,
  formatDb,
  normalizeAngle,
  pickTab,
  SPEED_SLIDER_MAX,
  SPEED_TICKS,
  sliderToSpeed,
  speedToSlider,
  transitionMax,
} from './inspectorLogic';

const S = secToUs;

describe('clipTabs', () => {
  it('matches the CapCut tab rows', () => {
    expect(clipTabs({ type: 'video' }, { hasAudio: true })).toEqual(['video', 'audio', 'speed', 'animation', 'adjust']);
    expect(clipTabs({ type: 'video' }, { hasAudio: false })).not.toContain('audio');
    expect(clipTabs({ type: 'image' })).toEqual(['video', 'animation', 'adjust']);
    expect(clipTabs({ type: 'audio' })).toEqual(['audio', 'speed']);
    expect(clipTabs({ type: 'text' })[0]).toBe('text');
  });
  it('pickTab keeps the wanted tab only when available', () => {
    expect(pickTab(['video', 'speed'], 'speed')).toBe('speed');
    expect(pickTab(['audio', 'speed'], 'video')).toBe('audio');
    expect(pickTab(['text'], null)).toBe('text');
  });
});

describe('speed slider', () => {
  it('puts the six ticks evenly along the track', () => {
    SPEED_TICKS.forEach((t, i) => expect(speedToSlider(t)).toBe((SPEED_SLIDER_MAX / 5) * i));
  });
  it('maps back to the ticks exactly and is monotonic', () => {
    for (const t of SPEED_TICKS) expect(sliderToSpeed(speedToSlider(t))).toBe(t);
    let prev = 0;
    for (let p = 0; p <= SPEED_SLIDER_MAX; p += 7) {
      const s = sliderToSpeed(p);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
  it('round-trips arbitrary speeds closely and clamps', () => {
    for (const s of [0.25, 0.5, 1.5, 3, 7.5, 42]) expect(Math.abs(sliderToSpeed(speedToSlider(s)) - s) / s).toBeLessThan(0.03);
    expect(speedToSlider(0.01)).toBe(0);
    expect(speedToSlider(1000)).toBe(SPEED_SLIDER_MAX);
    expect(sliderToSpeed(-5)).toBe(0.1);
  });
});

describe('audio / timing helpers', () => {
  it('formats dB with -∞ at the floor', () => {
    expect(formatDb(0)).toBe('0.0dB');
    expect(formatDb(-6.25)).toBe('-6.3dB');
    expect(formatDb(-60)).toBe('-∞dB');
  });
  it('fade and animation limits leave room for the other side', () => {
    expect(fadeMax(S(5), S(2))).toBe(S(3));
    expect(fadeMax(S(1), S(3))).toBe(0);
    expect(animationMax(S(3), S(1))).toBe(S(2));
    expect(animationMax(S(0.5), S(0.5))).toBe(100_000);
  });
});

describe('transform maths', () => {
  const canvas = { width: 1080, height: 1920 };
  it('contain-fits a 16:9 source into 9:16 and applies scale', () => {
    expect(displayedBox({ width: 1920, height: 1080 }, canvas, 1, 0)).toEqual({ width: 1080, height: 607.5 });
    expect(displayedBox({ width: 1920, height: 1080 }, canvas, 2, 0).width).toBe(2160);
  });
  it('uses the rotated bounding box', () => {
    const b = displayedBox({ width: 100, height: 50 }, canvas, 1, 90, false);
    expect(b.width).toBeCloseTo(50);
    expect(b.height).toBeCloseTo(100);
  });
  it('aligns against edges and centre', () => {
    const box = { width: 540, height: 400 };
    expect(alignPosition('left', box, canvas)).toEqual({ x: -270 });
    expect(alignPosition('right', box, canvas)).toEqual({ x: 270 });
    expect(alignPosition('top', box, canvas)).toEqual({ y: -760 });
    expect(alignPosition('bottom', box, canvas)).toEqual({ y: 760 });
    expect(alignPosition('center-h', box, canvas)).toEqual({ x: 0 });
    expect(alignPosition('center-v', box, canvas)).toEqual({ y: 0 });
  });
  it('normalises angles and reads the dial', () => {
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(720)).toBe(0);
    expect(dialAngle(0, 0, 0, -10)).toBe(0);
    expect(dialAngle(0, 0, 10, 0)).toBe(90);
    expect(dialAngle(0, 0, -10, 0)).toBe(-90);
  });
});

describe('number parsing', () => {
  it('parses values with units', () => {
    expect(parseNumber('100%')).toBe(100);
    expect(parseNumber(' -12.5dB')).toBe(-12.5);
    expect(parseNumber('1,5x')).toBe(1.5);
    expect(parseNumber('−3')).toBe(-3);
    expect(parseNumber('-∞dB')).toBe(-Infinity);
    expect(parseNumber('abc')).toBeNull();
    expect(toPct(0.456)).toBe(46);
    expect(fromPct(150)).toBe(1);
  });
  it('normalises hex colours', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('22d3ee')).toBe('#22d3ee');
    expect(normalizeHex('#12345')).toBeNull();
  });
});

describe('store-backed helpers', () => {
  const st = () => useEditor.getState();
  beforeEach(() => st().newProject());
  const vid = (name: string, sec: number) => createAsset({ kind: 'video', name, mime: '', size: 1, duration: S(sec), width: 1920, height: 1080, hasAudio: true });

  it('transitionMax = half the shorter clip', () => {
    const a = vid('a', 4);
    const b = vid('b', 2);
    st().addAssets([a, b]);
    const c1 = st().addClip(a.id, { at: 0 })!;
    st().addClip(b.id, { at: S(10) });
    const tr = st().addTransition(c1, 'mix')!;
    expect(transitionMax(st().project, tr)).toBe(S(1));
    expect(transitionMax(st().project, 'missing')).toBe(100_000);
  });

  it('applyAllTargets: main + overlay clips together, text separately', () => {
    const a = vid('a', 4);
    const b = vid('b', 4);
    st().addAssets([a, b]);
    const c1 = st().addClip(a.id, { at: 0 })!;
    const c2 = st().addClip(b.id, { at: 0, kind: 'overlay' })!;
    const t1 = st().addTextClip({ at: 0 });
    expect(applyAllTargets(st().project, c1).sort()).toEqual([c1, c2].sort());
    expect(applyAllTargets(st().project, t1)).toEqual([t1]);
  });
});
