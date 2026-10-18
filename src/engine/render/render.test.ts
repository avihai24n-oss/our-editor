import { describe, expect, it } from 'vitest';
import { createAsset, createTextClip, defaultAdjust } from '../../model/defaults';
import { secToUs } from '../../model/time';
import { useEditor } from '../../store';
import { getFrameState, type ColorOps, type FrameState, type MediaDrawOp } from '../frameState';
import { colorFactors, cssFilter, tonePasses } from './color';
import { boxCorners, hitTest, letterbox, moveWithSnap, pointInBox, rotateFromDrag, scaleFromDrag } from './geometry';
import { mediaLocalBox, projectBox, renderFrame } from './renderFrame';
import { fontString, layoutText, wrapLine } from './textLayout';
import type { Ctx2D, DrawnBox, FrameSources } from './types';

const neutral = (): ColorOps => ({ ...defaultAdjust(), grayscale: 0, sepia: 0 });

// ---------------------------------------------------------------- colour

describe('color', () => {
  it('neutral adjust → no filter, no passes', () => {
    expect(cssFilter(neutral(), 0)).toBe('none');
    expect(tonePasses(neutral())).toEqual([]);
    expect(colorFactors(neutral())).toEqual({ brightness: 1, contrast: 1, saturate: 1 });
  });

  it('maps sliders to css filter functions', () => {
    const c = { ...neutral(), brightness: 50, contrast: -50, saturation: -50, grayscale: 1, sepia: 0.5 };
    const f = cssFilter(c, 4);
    expect(f).toContain('brightness(1.5)');
    expect(f).toContain('contrast(0.5)');
    expect(f).toContain('saturate(0)');
    expect(f).toContain('grayscale(1)');
    expect(f).toContain('sepia(0.5)');
    expect(f).toContain('blur(4px)');
  });

  it('exposure is in stops', () => {
    expect(colorFactors({ ...neutral(), exposure: 50 }).brightness).toBeCloseTo(2);
    expect(colorFactors({ ...neutral(), exposure: -50 }).brightness).toBeCloseTo(0.5);
  });

  it('temperature / tint / fade / vignette become tone passes', () => {
    const warm = tonePasses({ ...neutral(), temperature: 50 });
    expect(warm).toEqual([{ kind: 'fill', color: '#ff9628', alpha: 0.22 }]);
    expect(tonePasses({ ...neutral(), temperature: -25 })[0]).toMatchObject({ color: '#2878ff', alpha: 0.11 });
    const all = tonePasses({ ...neutral(), temperature: 10, tint: -10, fade: 50, vignette: 100 });
    expect(all.map((p) => p.kind)).toEqual(['fill', 'fill', 'fill', 'vignette']);
    expect(all[3]).toEqual({ kind: 'vignette', alpha: 0.85 });
  });

  it('clamps out-of-range values (filter + adjust can sum past the slider range)', () => {
    expect(tonePasses({ ...neutral(), fade: 160 })[0]).toMatchObject({ alpha: 0.4 });
    expect(colorFactors({ ...neutral(), saturation: 90 }).saturate).toBe(2);
  });
});

// ---------------------------------------------------------------- text

const mono: (t: string) => number = (t) => t.length * 10;

describe('text layout', () => {
  it('font string', () => {
    expect(fontString({ italic: true, bold: true, fontSize: 40, fontFamily: 'Georgia' })).toBe('italic bold 40px Georgia, system-ui, sans-serif');
    expect(fontString({ italic: false, bold: false, fontSize: 20, fontFamily: 'Times New Roman' })).toBe('20px "Times New Roman", system-ui, sans-serif');
  });

  it('wraps words greedily and breaks long words', () => {
    expect(wrapLine('aaa bbb ccc', 75, mono)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapLine('short', 100, mono)).toEqual(['short']);
    expect(wrapLine('abcdefghij', 40, mono)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapLine('', 40, mono)).toEqual(['']);
  });

  it('lays out a centred block with alignment', () => {
    const style = createTextClip('t', 0, 'x').text;
    const s = { ...style, fontSize: 10, lineHeight: 2, align: 'left' as const, background: { ...style.background, enabled: false } };
    const L = layoutText(s, ['abcd', 'ab'], mono, 1000);
    expect(L.lines).toHaveLength(2);
    expect(L.lineHeightPx).toBe(20);
    expect(L.height).toBe(40 + L.padding * 2);
    expect(L.width).toBe(40 + L.padding * 2);
    // left aligned: both lines start at the same x; block centred on 0
    expect(L.lines[0]!.x).toBe(-20);
    expect(L.lines[1]!.x).toBe(-20);
    expect(L.lines[0]!.y).toBeCloseTo(-10);
    expect(L.lines[1]!.y).toBeCloseTo(10);
    const R = layoutText({ ...s, align: 'right' }, ['abcd', 'ab'], mono, 1000);
    expect(R.lines[1]!.x).toBe(0);
    const C = layoutText({ ...s, align: 'center' }, ['abcd', 'ab'], mono, 1000);
    expect(C.lines[1]!.x).toBe(-10);
  });
});

// ---------------------------------------------------------------- geometry

describe('geometry', () => {
  const box: DrawnBox = { clipId: 'a', cx: 100, cy: 100, w: 40, h: 20, rotation: 0 };

  it('letterbox keeps the ratio', () => {
    const lb = letterbox(1000, 1000, 1080, 1920, 0);
    expect(lb.width).toBeCloseTo(562.5);
    expect(lb.height).toBeCloseTo(1000);
    expect(letterbox(0, 0, 1080, 1920).k).toBe(0);
  });

  it('point in rotated box', () => {
    expect(pointInBox({ x: 118, y: 100 }, box)).toBe(true);
    expect(pointInBox({ x: 100, y: 115 }, box)).toBe(false);
    const r = { ...box, rotation: 90 };
    expect(pointInBox({ x: 100, y: 115 }, r)).toBe(true);
    expect(pointInBox({ x: 118, y: 100 }, r)).toBe(false);
  });

  it('corners clockwise from top-left', () => {
    const c = boxCorners(box);
    expect(c[0]).toEqual({ x: 80, y: 90 });
    expect(c[2]).toEqual({ x: 120, y: 110 });
  });

  it('hit test returns the topmost box', () => {
    const top: DrawnBox = { ...box, clipId: 'b' };
    expect(hitTest([box, top], { x: 100, y: 100 })?.clipId).toBe('b');
    expect(hitTest([box, top], { x: 0, y: 0 })).toBeNull();
  });

  it('move snaps to the centre', () => {
    expect(moveWithSnap({ x: 0, y: 0 }, { x: 5, y: 50 }, 8)).toEqual({ x: 0, y: 50, guideX: true, guideY: false });
    expect(moveWithSnap({ x: 0, y: 0 }, { x: 5, y: 50 }, -1)).toEqual({ x: 5, y: 50, guideX: false, guideY: false });
  });

  it('scale follows the distance from the centre, clamped', () => {
    const c = { x: 0, y: 0 };
    expect(scaleFromDrag(1, c, { x: 10, y: 0 }, { x: 20, y: 0 })).toBe(2);
    expect(scaleFromDrag(1, c, { x: 10, y: 0 }, { x: 100, y: 0 })).toBe(4);
    expect(scaleFromDrag(1, c, { x: 10, y: 0 }, { x: 0, y: 0 })).toBe(0.01);
  });

  it('rotate snaps to right angles', () => {
    const c = { x: 0, y: 0 };
    expect(rotateFromDrag(0, c, { x: 10, y: 0 }, { x: 0, y: 10 })).toBe(90);
    expect(rotateFromDrag(0, c, { x: 10, y: 0 }, { x: 10, y: 0.5 })).toBe(0); // 2.9° snaps to 0
    expect(rotateFromDrag(0, c, { x: 10, y: 0 }, { x: 10, y: 3 }, 4)).toBeCloseTo(16.7, 1);
    expect(rotateFromDrag(170, c, { x: 10, y: 0 }, { x: 0, y: 10 })).toBe(-100);
  });
});

// ---------------------------------------------------------------- compositor

/** Records every call and property write on a fake 2D context. */
function fakeCtx(w: number, h: number) {
  const log: string[] = [];
  const state: Record<string, unknown> = {};
  const canvas = { width: w, height: h };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return (t: string) => ({ width: t.length * 10 });
      if (prop === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
      if (prop in state) return state[prop];
      return (...args: unknown[]) => {
        log.push(`${prop}(${args.filter((a) => typeof a !== 'object').join(',')})`);
      };
    },
    set(_t, prop: string, v) {
      state[prop] = v;
      log.push(`${prop}=${String(v)}`);
      return true;
    },
    has: (_t, prop) => prop === 'letterSpacing' || prop in state,
  };
  return { ctx: new Proxy({}, handler) as unknown as Ctx2D, log };
}

const S = secToUs;
const st = () => useEditor.getState();

describe('renderFrame', () => {
  const sources = (img = true): FrameSources => ({
    get: (_op: MediaDrawOp) => (img ? { image: {} as CanvasImageSource, width: 1920, height: 1080 } : null),
  });

  function projectWithVideo() {
    st().newProject();
    const v = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(10), width: 1920, height: 1080, hasAudio: true });
    st().addAssets([v]);
    const id = st().addClip(v.id, { at: 0 })!;
    return { id, v };
  }

  it('clears with the background and draws media into its fitted box', () => {
    projectWithVideo();
    const fs = getFrameState(st().project, S(1));
    const { ctx, log } = fakeCtx(540, 960);
    const boxes = renderFrame(ctx, fs, { scale: 0.5, sources: sources() });
    expect(log).toContain('fillStyle=#000000');
    expect(log).toContain('fillRect(0,0,540,960)');
    // 1920×1080 contain-fit in 1080×1920 → 1080×607.5, centred on (540, 960)
    expect(log.some((l) => l.startsWith('drawImage(0,0,1920,1080,-540,-303.75,1080,607.5)'))).toBe(true);
    expect(log).toContain('setTransform(0.5,0,0,0.5,0,0)');
    expect(boxes).toEqual([{ clipId: expect.any(String), cx: 540, cy: 960, w: 1080, h: 607.5, rotation: 0 }]);
  });

  it('skips the picture while the source is not ready but still reports the box', () => {
    projectWithVideo();
    const fs = getFrameState(st().project, S(1));
    const { ctx, log } = fakeCtx(1080, 1920);
    const boxes = renderFrame(ctx, fs, { scale: 1, sources: sources(false) });
    expect(log.some((l) => l.startsWith('drawImage'))).toBe(false);
    expect(boxes).toHaveLength(1);
  });

  it('applies blend, opacity, filter and wipe clip', () => {
    const { id } = projectWithVideo();
    st().updateClip(id, { blend: 'screen', transform: { opacity: 0.5 }, adjust: { brightness: 50 } });
    const fs = getFrameState(st().project, S(1));
    const op = { ...(fs.ops[0] as MediaDrawOp), clipRect: { x: 0, y: 0, w: 0.5, h: 1 } };
    const { ctx, log } = fakeCtx(1080, 1920);
    renderFrame(ctx, { ...fs, ops: [op] }, { scale: 1, sources: sources() });
    expect(log).toContain('globalCompositeOperation=screen');
    expect(log).toContain('globalAlpha=0.5');
    expect(log).toContain('filter=brightness(1.5)');
    expect(log).toContain('rect(0,0,540,1920)');
    expect(log).toContain('clip()');
  });

  it('uses a layer for tone passes and composites it with source-atop passes', () => {
    const { id } = projectWithVideo();
    st().updateClip(id, { adjust: { temperature: 50 } });
    const fs = getFrameState(st().project, S(1));
    const main = fakeCtx(1080, 1920);
    const layer = fakeCtx(1080, 1920);
    renderFrame(main.ctx, fs, { scale: 1, sources: sources(), layers: { get: () => layer.ctx } });
    expect(layer.log).toContain('globalCompositeOperation=source-atop');
    expect(layer.log).toContain('fillStyle=#ff9628');
    expect(layer.log.some((l) => l.startsWith('drawImage'))).toBe(true);
    expect(main.log.some((l) => l.startsWith('drawImage(0,0)'))).toBe(true);
  });

  it('draws fill ops and text', () => {
    st().newProject();
    st().addTextClip({ at: 0, content: 'Hello' });
    const fs = getFrameState(st().project, S(1));
    const withFill: FrameState = { ...fs, ops: [...fs.ops, { kind: 'fill', trackId: 't', layer: 0, color: '#ffffff', opacity: 0.25 }] };
    const { ctx, log } = fakeCtx(1080, 1920);
    const boxes = renderFrame(ctx, withFill, { scale: 1, sources: sources() });
    expect(log.some((l) => l.startsWith('fillText(Hello'))).toBe(true);
    expect(log).toContain('globalAlpha=0.25');
    expect(log).toContain('fillStyle=#ffffff');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.w).toBeGreaterThan(50);
  });

  it('media lost → placeholder', () => {
    projectWithVideo();
    const fs = getFrameState(st().project, S(1));
    const { ctx, log } = fakeCtx(1080, 1920);
    renderFrame(ctx, fs, { scale: 1, sources: { get: () => 'missing' } });
    expect(log.some((l) => l.startsWith('fillText(Media lost'))).toBe(true);
  });

  it('local box honours crop; project box honours transform', () => {
    const op = { fitWidth: 100, fitHeight: 50, crop: { left: 0.2, right: 0, top: 0, bottom: 0.5 } } as MediaDrawOp;
    expect(mediaLocalBox(op)).toEqual({ w: 80, h: 25, ox: 10, oy: -12.5 });
    const b = projectBox(
      { clipId: 'c', transform: { x: 10, y: 0, scale: 2, rotation: 0, opacity: 1, flipH: false, flipV: false } } as MediaDrawOp,
      { w: 80, h: 25, ox: 10, oy: -12.5 },
      200,
      100,
    );
    expect(b).toEqual({ clipId: 'c', cx: 130, cy: 25, w: 160, h: 50, rotation: 0 });
  });
});
