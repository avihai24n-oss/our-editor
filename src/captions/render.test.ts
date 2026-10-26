import { describe, expect, it } from 'vitest';
import type { Ctx2D } from '../engine/render/types';
import { renderFrame } from '../engine/render';
import { getFrameState } from '../engine/frameState';
import { useEditor } from '../store';
import { activeWordIndex, spring, wordState, type CaptionFrame } from './frame';
import { DEFAULT_GROUPING } from './model';
import * as cops from './ops';
import { CAPTION_PRESETS, presetStyle } from './presets';
import { drawCaption, layoutCaption, withAlpha, wordLook } from './render';
import type { CaptionStyle, CaptionWord } from './types';

/** Fake 2D context: 10 px per character, records fillText / fillStyle / font / direction. */
function fakeCtx() {
  const log: string[] = [];
  const state: Record<string, unknown> = { direction: 'ltr' };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === 'canvas') return { width: 1080, height: 1920 };
      if (prop === 'measureText') return (t: string) => ({ width: [...t].length * 10 * ((parseFloat(String(state.font).replace(/^.*?(\d+(\.\d+)?)px.*$/, '$1')) || 10) / 10) });
      if (prop in state) return state[prop];
      return (...args: unknown[]) => log.push(`${prop}(${args.filter((a) => typeof a !== 'object').join(',')})`);
    },
    set(_t, prop: string, v) {
      state[prop] = v;
      log.push(`${prop}=${String(v)}`);
      return true;
    },
    has: (_t, prop) => prop in state || prop === 'direction',
  };
  return { ctx: new Proxy({}, handler) as unknown as Ctx2D, log };
}

const W = (text: string, s: number, e: number): CaptionWord => ({ text, start: s * 1000, end: e * 1000 });
const style = (id: string, patch: Partial<CaptionStyle> = {}): CaptionStyle => ({ ...presetStyle(id, 1080, 1920), safeArea: false, ...patch });
const op = (s: CaptionStyle, words: CaptionWord[], now: number, rtl = false) => ({
  caption: { style: s, words, now: now * 1000, rtl } as CaptionFrame,
  transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
});

describe('timing helpers', () => {
  it('word state, spring and the Word Pop word', () => {
    const w = W('a', 100, 300);
    expect(wordState(w, 50_000).phase).toBe('future');
    expect(wordState(w, 200_000)).toMatchObject({ phase: 'active', progress: 0.5 });
    expect(wordState(w, 300_000).phase).toBe('past');
    expect(spring(0, { damping: 12, stiffness: 200, mass: 0.5 })).toBe(0);
    expect(spring(2, { damping: 12, stiffness: 200, mass: 0.5 })).toBeCloseTo(1, 3);
    // underdamped: overshoots a little, like Remotion's spring
    expect(Math.max(...[0.1, 0.15, 0.2, 0.25].map((t) => spring(t, { damping: 12, stiffness: 200, mass: 0.5 })))).toBeGreaterThan(1);
    expect(activeWordIndex([W('a', 0, 100), W('b', 200, 300)], 150_000)).toBe(-1);
    expect(activeWordIndex([W('a', 0, 100), W('b', 200, 300)], 250_000)).toBe(1);
  });
});

describe('word looks (MakePodcast modes)', () => {
  const words = [W('one', 0, 200), W('two', 200, 400), W('three', 400, 600)];
  const at = (id: string, ms: number, i: number, patch: Partial<CaptionStyle> = {}) => {
    const s = style(id, patch);
    return wordLook(s, op(s, words, ms).caption, i);
  };
  it('Karaoke: only the spoken word in the highlight colour; Clean: none', () => {
    expect(at('karaoke', 300, 1).color).toBe('#FF5A3C');
    expect(at('karaoke', 300, 0).color).toBe('#FFFFFF');
    expect(at('plain', 300, 1).color).toBe('#FFFFFF');
  });
  it('Word Pop springs from 0.5; Hormozi pops the spoken word from 0.86', () => {
    expect(at('word-pop', 200, 1).scale).toBe(0.5);
    expect(at('word-pop', 600, 1).scale).toBeGreaterThan(0.95);
    expect(at('word-pop-glow', 300, 1).color).toBe('#FF5A3C');
    expect(at('hormozi', 200, 1).scale).toBeCloseTo(0.86);
    expect(at('hormozi', 200, 0).scale).toBe(1);
  });
  it('Box, fill, bounce, reveal', () => {
    expect(at('box', 300, 1).boxed).toBe(true);
    expect(at('box', 300, 0).boxed).toBe(false);
    expect(at('karaoke-fill', 300, 1).fill).toBeCloseTo(0.5);
    expect(at('karaoke-fill', 300, 0).fill).toBe(1);
    expect(at('karaoke-fill', 300, 2).fill).toBe(0);
    expect(at('bounce', 350, 1).dy).toBeLessThan(0);
    expect(at('reveal', 300, 2).alpha).toBe(0);
    expect(at('reveal', 300, 0).alpha).toBe(1);
  });
});

describe('layout', () => {
  it('Hebrew: the first word sits at the right end of the line', () => {
    const { ctx } = fakeCtx();
    const s = style('plain', { fontSize: 10, wordSpacing: 0.5 });
    const L = layoutCaption(ctx, op(s, [W('אבג', 0, 1), W('דה', 1, 2)], 0, true), 1080, 1920);
    const [first, second] = L.words;
    expect(first!.text).toBe('אבג');
    expect(first!.x).toBeGreaterThan(second!.x);
    expect(first!.rtl).toBe(true);
    // English stays left to right
    const L2 = layoutCaption(ctx, op(s, [W('abc', 0, 1), W('de', 1, 2)], 0, false), 1080, 1920);
    expect(L2.words[0]!.x).toBeLessThan(L2.words[1]!.x);
  });

  it('one-line fit shrinks the font (not below half), more lines wrap', () => {
    const { ctx } = fakeCtx();
    const words = Array.from({ length: 8 }, (_, i) => W('abcdefghij', i, i + 1)); // 8 × 100 px at 10 px
    const s = style('karaoke', { fontSize: 10, wordSpacing: 0, maxWidth: 600 / 1080 });
    const L = layoutCaption(ctx, op(s, words, 0), 1080, 1920);
    expect(L.fontSize).toBeLessThan(7.5); // 8 × 100 px does not fit 600 px: shrinks until one line fits
    expect(L.words.length * L.fontSize * 10).toBeLessThanOrEqual(600);
    expect(new Set(L.words.map((w) => w.y)).size).toBe(1);
    // too long even at half size: half size, and the words wrap rather than run off the frame
    const many = layoutCaption(ctx, op(s, [...words, ...words], 0), 1080, 1920);
    expect(many.fontSize).toBe(5);
    expect(new Set(many.words.map((w) => w.y)).size).toBe(2);
    const two = layoutCaption(ctx, op({ ...s, maxLines: 2 }, words, 0), 1080, 1920);
    expect(two.fontSize).toBeGreaterThan(5);
    expect(new Set(two.words.map((w) => w.y)).size).toBe(2);
  });

  it('Word Pop lays out only the spoken word; the safe area pulls a block back inside', () => {
    const { ctx } = fakeCtx();
    const s = style('word-pop', { fontSize: 10 });
    expect(layoutCaption(ctx, op(s, [W('a', 0, 100), W('b', 100, 200)], 150), 1080, 1920).words.map((w) => w.text)).toEqual(['b']);
    const safe = { ...style('plain', { fontSize: 100 }), safeArea: true };
    const o = op(safe, [W('abcdef', 0, 100)], 50);
    o.transform.y = 960; // centre at the very bottom edge
    const L = layoutCaption(ctx, o, 1080, 1920);
    expect(L.box.oy).toBeLessThan(0);
    expect(960 + 960 + L.box.oy + L.box.h / 2).toBeLessThanOrEqual(1920 * 0.95 + 0.01);
  });
});

describe('drawing', () => {
  it('draws each word with its colour; the box mode paints the box first', () => {
    const { ctx, log } = fakeCtx();
    const s = style('box');
    const o = op(s, [W('one', 0, 200), W('two', 200, 400)], 300);
    drawCaption(ctx, o, layoutCaption(ctx, o, 1080, 1920), 1);
    const iTwo = log.indexOf('fillText(two,0,0)');
    expect(iTwo).toBeGreaterThan(0);
    expect(log.slice(0, iTwo).filter((l) => l === 'fillStyle=#FF5A3C')).toHaveLength(1);
    expect(log.some((l) => l.startsWith('roundRect('))).toBe(true);
  });

  it('every preset draws its words without throwing', () => {
    for (const p of CAPTION_PRESETS) {
      const { ctx, log } = fakeCtx();
      const o = op(style(p.id), [W('שלום', 0, 200), W('לכולם,', 200, 400)], 300, true);
      drawCaption(ctx, o, layoutCaption(ctx, o, 1080, 1920), 1);
      expect(log.some((l) => l.startsWith('fillText(לכולם,')), p.id).toBe(true);
    }
  });

  it('renderFrame draws a caption clip through the shared compositor and reports its box', () => {
    const st = useEditor.getState();
    st.newProject({ aspect: '9:16' });
    st.editProject((d) => cops.placeTranscription(d, [W('hello', 1000, 1300), W('world', 1300, 1700)], { start: 0, end: 3_000_000 }, DEFAULT_GROUPING));
    const fs = getFrameState(useEditor.getState().project, 1_400_000);
    const { ctx, log } = fakeCtx();
    const boxes = renderFrame(ctx, fs, { scale: 0.5, sources: { get: () => null } });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.cy).toBeCloseTo(1920 * 0.8, 0);
    expect(log).toContain('fillText(hello,0,0)');
    expect(log).toContain('fillText(world,0,0)');
  });

  it('colour helper', () => {
    expect(withAlpha('#ff5a3c', 0.8)).toBe('rgba(255,90,60,0.8)');
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255,255,255,0.5)');
    expect(withAlpha('rgba(0,0,0,0.9)', 0.2)).toBe('rgba(0,0,0,0.2)');
  });
});
