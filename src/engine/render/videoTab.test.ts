/**
 * Video tab maths and wiring: Uniform scale off, masks, chroma key, canvas background, linear burn.
 * Pixel-level checks of the real canvas output live in e2e/tab-video.spec.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset, defaultMask } from '../../model/defaults';
import { migrateProject } from '../../model/project';
import { secToUs } from '../../model/time';
import type { ClipMask, ImageClip, MediaAsset, Project, VideoClip } from '../../model/types';
import { useEditor } from '../../store';
import { CANVAS_BLUR_OVERSCAN, baseScaleXY, coverSize, getFrameState, type FillDrawOp, type MediaDrawOp } from '../frameState';
import { CHROMA_MAX_THRESHOLD, chromaAlpha, chromaKeyPixels, chromaParams, hexToRgb } from './chroma';
import { scaleXYFromDrag } from './geometry';
import { FEATHER_FRACTION, heartPoints, maskAlphaAt, maskGeometry, pointInPolygon, starPoints } from './mask';
import { projectBox, renderFrame } from './renderFrame';
import type { Ctx2D, FrameSources } from './types';

const S = secToUs;
const st = () => useEditor.getState();
const video = (): MediaAsset => createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(10), width: 1080, height: 1920, hasAudio: false });
const image = (w = 1000, h = 500): MediaAsset => createAsset({ kind: 'image', name: 'i.png', mime: 'image/png', size: 1, duration: 0, width: w, height: h });
const clipOf = (id: string) => st().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as VideoClip | ImageClip;
const mask = (m: Partial<ClipMask>): ClipMask => ({ ...defaultMask(), ...m });

beforeEach(() => {
  st().newProject();
});

// ---------------------------------------------------------------- model

describe('model: defaults, patching, migration', () => {
  it('new media clips carry the Video-tab defaults', () => {
    const v = video();
    st().addAssets([v]);
    const c = clipOf(st().addClip(v.id, { at: 0 })!);
    expect(c.transform).toMatchObject({ uniformScale: true, scaleX: 1, scaleY: 1 });
    expect(c.mask.shape).toBe('none');
    expect(c.chroma).toEqual({ enabled: false, color: '#00ff00', intensity: 50, shadow: 0 });
    expect(c.canvas).toEqual({ type: 'none', color: '#000000', blur: 2, assetId: null });
  });

  it('updateClip merges and clamps the new fields; undo restores them', () => {
    const v = video();
    st().addAssets([v]);
    const id = st().addClip(v.id, { at: 0 })!;
    st().updateClip(id, { transform: { uniformScale: false, scaleX: 9, scaleY: 0 } });
    expect(clipOf(id).transform).toMatchObject({ uniformScale: false, scaleX: 4, scaleY: 0.01 });
    st().updateClip(id, { mask: { shape: 'circle', feather: 300, roundCorners: -5 }, chroma: { intensity: 140, shadow: -1 }, canvas: { type: 'blur', blur: 9 } });
    const c = clipOf(id);
    expect(c.mask).toMatchObject({ shape: 'circle', feather: 100, roundCorners: 0, width: 0.5 });
    expect(c.chroma).toMatchObject({ intensity: 100, shadow: 0 });
    expect(c.canvas).toMatchObject({ type: 'blur', blur: 4 });
    st().undo();
    expect(clipOf(id).mask.shape).toBe('none');
    expect(clipOf(id).canvas.type).toBe('none');
  });

  it('migrates projects saved before the Video tab fields existed', () => {
    const v = video();
    st().addAssets([v]);
    const id = st().addClip(v.id, { at: 0 })!;
    st().updateClip(id, { transform: { scale: 1.5 } });
    const old = JSON.parse(JSON.stringify(st().project)) as Project;
    const c = old.tracks[0]!.clips[0] as unknown as Record<string, unknown>;
    const tf = c.transform as Record<string, unknown>;
    delete tf.uniformScale;
    delete tf.scaleX;
    delete tf.scaleY;
    delete c.mask;
    delete c.chroma;
    c.canvas = { type: 'color' }; // partially saved object keeps its values
    const m = migrateProject(old);
    const mc = m.tracks[0]!.clips[0] as VideoClip;
    expect(mc.transform).toMatchObject({ scale: 1.5, uniformScale: true, scaleX: 1.5, scaleY: 1.5 });
    expect(mc.mask).toEqual(defaultMask());
    expect(mc.chroma.enabled).toBe(false);
    expect(mc.canvas).toEqual({ type: 'color', color: '#000000', blur: 2, assetId: null });
    // already-current projects are returned untouched
    expect(migrateProject(m)).toBe(m);
  });
});

// ---------------------------------------------------------------- frame state

describe('frame state', () => {
  it('Uniform scale off → per-axis scale (animations multiply both)', () => {
    expect(baseScaleXY({ scale: 2, scaleX: 0.5, scaleY: 3, uniformScale: false } as VideoClip['transform'])).toEqual({ x: 0.5, y: 3 });
    expect(baseScaleXY({ scale: 2, scaleX: 0.5, scaleY: 3, uniformScale: true } as VideoClip['transform'])).toEqual({ x: 2, y: 2 });
    const v = video();
    st().addAssets([v]);
    const id = st().addClip(v.id, { at: 0 })!;
    st().updateClip(id, { transform: { uniformScale: false, scaleX: 0.5, scaleY: 2 } });
    const op = getFrameState(st().project, S(1)).ops[0] as MediaDrawOp;
    expect(op.transform).toMatchObject({ scaleX: 0.5, scaleY: 2, scale: 1 });
    // a 1080×1920 clip at 50 % × 200 % → 540 × 3840 box
    expect(projectBox(op, { w: op.fitWidth, h: op.fitHeight, ox: 0, oy: 0 }, 1080, 1920)).toMatchObject({ w: 540, h: 3840 });
  });

  it('mask and chroma reach the op only when active', () => {
    const v = video();
    st().addAssets([v]);
    const id = st().addClip(v.id, { at: 0 })!;
    let op = getFrameState(st().project, S(1)).ops[0] as MediaDrawOp;
    expect(op.mask).toBeNull();
    expect(op.chroma).toBeNull();
    st().updateClip(id, { mask: { shape: 'star' }, chroma: { enabled: true } });
    op = getFrameState(st().project, S(1)).ops[0] as MediaDrawOp;
    expect(op.mask?.shape).toBe('star');
    expect(op.chroma?.color).toBe('#00ff00');
  });

  it('canvas background: colour fill, blurred cover copy, image; main track only', () => {
    const v = video();
    const img = image(1000, 500);
    st().addAssets([v, img]);
    const id = st().addClip(v.id, { at: 0 })!;
    st().updateClip(id, { canvas: { type: 'color', color: '#ff0000' } });
    let ops = getFrameState(st().project, S(1)).ops;
    expect(ops.map((o) => o.kind)).toEqual(['fill', 'media']);
    expect(ops[0] as FillDrawOp).toMatchObject({ color: '#ff0000', opacity: 1 });

    st().updateClip(id, { canvas: { type: 'blur', blur: 3 } });
    ops = getFrameState(st().project, S(1)).ops;
    const bg = ops[0] as MediaDrawOp;
    expect(bg).toMatchObject({ role: 'background', clipId: id, mediaType: 'video', blur: 60, sourceTime: (ops[1] as MediaDrawOp).sourceTime });
    expect(bg.fitWidth).toBeCloseTo(1080 * CANVAS_BLUR_OVERSCAN);

    st().updateClip(id, { canvas: { type: 'image', assetId: img.id } });
    const ib = getFrameState(st().project, S(1)).ops[0] as MediaDrawOp;
    expect(ib).toMatchObject({ role: 'background', mediaType: 'image', assetId: img.id, blur: 0 });
    // 1000×500 cover-fitted into 1080×1920 → height fills
    expect(ib.fitHeight).toBeCloseTo(1920);
    expect(ib.fitWidth).toBeCloseTo(3840);
    expect(coverSize(1000, 500, 1080, 1920)).toEqual({ width: 3840, height: 1920 });

    // an overlay clip with the same settings gets no background
    const o = st().addClip(v.id, { kind: 'overlay', at: 0 })!;
    st().updateClip(o, { canvas: { type: 'color', color: '#00ff00' } });
    const kinds = getFrameState(st().project, S(1)).ops.map((x) => (x.kind === 'fill' ? x.color : (x as MediaDrawOp).role ?? x.clipId));
    expect(kinds).toEqual(['background', id, o]);
  });

  it('blend linear burn keeps a valid canvas composite and names the mode', () => {
    const v = video();
    st().addAssets([v]);
    const id = st().addClip(v.id, { at: 0 })!;
    st().updateClip(id, { blend: 'linear-burn' });
    const op = getFrameState(st().project, S(1)).ops[0] as MediaDrawOp;
    expect(op.composite).toBe('source-over');
    expect(op.blendMode).toBe('linear-burn');
    st().updateClip(id, { blendEnabled: false });
    expect((getFrameState(st().project, S(1)).ops[0] as MediaDrawOp).blendMode).toBe('normal');
  });
});

// ---------------------------------------------------------------- mask geometry

describe('mask geometry', () => {
  const box = { w: 1000, h: 500, ox: 0, oy: 0 };

  it('resolves fractions of the picture to local px', () => {
    const g = maskGeometry(mask({ shape: 'rectangle', x: 0.1, y: -0.2, width: 0.5, height: 0.4, feather: 50, roundCorners: 100, rotation: 90 }), box)!;
    expect(g).toMatchObject({ cx: 100, cy: -100, w: 500, h: 200, radius: 100 });
    expect(g.rot).toBeCloseTo(Math.PI / 2);
    expect(g.feather).toBeCloseTo(0.5 * FEATHER_FRACTION * 200);
    expect(maskGeometry(mask({ shape: 'none' }), box)).toBeNull();
    // open shapes feather relative to the picture
    expect(maskGeometry(mask({ shape: 'linear', feather: 100 }), box)!.feather).toBeCloseTo(FEATHER_FRACTION * 500);
  });

  it('circle: inside / outside / invert', () => {
    const g = maskGeometry(mask({ shape: 'circle', width: 0.5, height: 1 }), box)!; // 500×500 circle
    expect(maskAlphaAt(g, { x: 0, y: 0 })).toBe(1);
    expect(maskAlphaAt(g, { x: 240, y: 0 })).toBe(1);
    expect(maskAlphaAt(g, { x: 260, y: 0 })).toBe(0);
    expect(maskAlphaAt(g, { x: 200, y: 200 })).toBe(0); // the box corner region
    expect(maskAlphaAt({ ...g, invert: true }, { x: 0, y: 0 })).toBe(0);
  });

  it('linear keeps the side above the line; rotation turns it; feather ramps across the line', () => {
    const g = maskGeometry(mask({ shape: 'linear' }), box)!;
    expect(maskAlphaAt(g, { x: 0, y: -10 })).toBe(1);
    expect(maskAlphaAt(g, { x: 0, y: 10 })).toBe(0);
    const r = maskGeometry(mask({ shape: 'linear', rotation: 90 }), box)!;
    // rotated 90° clockwise: the kept side faces +x
    expect(maskAlphaAt(r, { x: 10, y: 0 })).toBe(1);
    expect(maskAlphaAt(r, { x: -10, y: 0 })).toBe(0);
    const f = maskGeometry(mask({ shape: 'linear', feather: 40 }), box)!; // 0.4 × 0.5 × 500 = 100 px ramp
    expect(f.feather).toBeCloseTo(100);
    expect(maskAlphaAt(f, { x: 0, y: 0 })).toBeCloseTo(0.5);
    expect(maskAlphaAt(f, { x: 0, y: -25 })).toBeCloseTo(0.75);
    expect(maskAlphaAt(f, { x: 0, y: 60 })).toBe(0);
  });

  it('mirror keeps a band of the given height', () => {
    const g = maskGeometry(mask({ shape: 'mirror', height: 0.2 }), box)!; // 100 px band
    expect(maskAlphaAt(g, { x: 400, y: 49 })).toBe(1);
    expect(maskAlphaAt(g, { x: 400, y: 51 })).toBe(0);
    expect(maskAlphaAt({ ...g, invert: true }, { x: 400, y: 51 })).toBe(1);
  });

  it('rectangle rounds its corners', () => {
    const g = maskGeometry(mask({ shape: 'rectangle', width: 0.4, height: 0.8, roundCorners: 100 }), box)!; // 400×400, r=200 → a circle
    expect(maskAlphaAt(g, { x: 190, y: 0 })).toBe(1);
    expect(maskAlphaAt(g, { x: 190, y: 190 })).toBe(0);
    const sq = { ...g, radius: 0 };
    expect(maskAlphaAt(sq, { x: 190, y: 190 })).toBe(1);
  });

  it('star and heart fill their box and leave the corners out', () => {
    const star = starPoints(200, 200);
    expect(star).toHaveLength(10);
    const xs = star.map((p) => p.x);
    const ys = star.map((p) => p.y);
    expect(Math.max(...xs)).toBeCloseTo(100);
    expect(Math.min(...xs)).toBeCloseTo(-100);
    expect(Math.min(...ys)).toBeCloseTo(-100);
    expect(Math.max(...ys)).toBeCloseTo(100);
    expect(star[0]).toMatchObject({ x: 0 }); // top point
    expect(pointInPolygon({ x: 0, y: 0 }, star)).toBe(true);
    expect(pointInPolygon({ x: 95, y: 95 }, star)).toBe(false);
    const heart = heartPoints(200, 180);
    expect(Math.max(...heart.map((p) => p.x))).toBeCloseTo(100);
    expect(Math.max(...heart.map((p) => p.y))).toBeCloseTo(90);
    expect(pointInPolygon({ x: 0, y: 0 }, heart)).toBe(true);
    expect(pointInPolygon({ x: 0, y: -85 }, heart)).toBe(false); // the notch at the top
    expect(pointInPolygon({ x: 95, y: 85 }, heart)).toBe(false);
  });
});

// ---------------------------------------------------------------- chroma

describe('chroma key', () => {
  it('parses colours', () => {
    expect(hexToRgb('#00ff00')).toEqual([0, 255, 0]);
    expect(hexToRgb('#f00')).toEqual([255, 0, 0]);
  });

  it('keys the key colour, keeps far colours, ramps by Shadow', () => {
    const p = chromaParams({ color: '#00ff00', intensity: 50, shadow: 0 });
    expect(p.threshold).toBeCloseTo(CHROMA_MAX_THRESHOLD / 2);
    expect(chromaAlpha(p, 0, 255, 0)).toBe(0);
    expect(chromaAlpha(p, 30, 220, 40)).toBe(0); // a darker green screen
    expect(chromaAlpha(p, 255, 0, 255)).toBe(1); // magenta
    expect(chromaAlpha(p, 128, 128, 128)).toBe(1); // grey
    expect(chromaAlpha(chromaParams({ color: '#00ff00', intensity: 0, shadow: 0 }), 30, 220, 40)).toBe(1);
    const soft = chromaParams({ color: '#00ff00', intensity: 30, shadow: 100 });
    const a = chromaAlpha(soft, 60, 200, 60);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  it('chromaKeyPixels clears green and despills partial pixels', () => {
    const data = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255]);
    chromaKeyPixels(data, chromaParams({ color: '#00ff00', intensity: 50, shadow: 0 }));
    expect(data[3]).toBe(0);
    expect(Array.from(data.slice(4))).toEqual([255, 0, 0, 255]);
  });
});

// ---------------------------------------------------------------- gestures

describe('non-uniform corner drag', () => {
  it('scales both axes by the same factor and keeps the ratio at the limits', () => {
    const c = { x: 0, y: 0 };
    expect(scaleXYFromDrag(0.5, 2, c, { x: 10, y: 0 }, { x: 20, y: 0 })).toEqual({ scaleX: 1, scaleY: 4 });
    expect(scaleXYFromDrag(0.5, 2, c, { x: 10, y: 0 }, { x: 100, y: 0 })).toEqual({ scaleX: 1, scaleY: 4 });
    expect(scaleXYFromDrag(0.5, 2, c, { x: 10, y: 0 }, { x: 0, y: 0 })).toEqual({ scaleX: 0.01, scaleY: 0.04 });
  });
});

// ---------------------------------------------------------------- compositor wiring

function fakeCtx(w: number, h: number) {
  const log: string[] = [];
  const state: Record<string, unknown> = {};
  const canvas = { width: w, height: h };
  const grad = () => ({ addColorStop: (o: number, c: string) => log.push(`stop(${o},${c})`) });
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === 'canvas') return canvas;
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return (...a: number[]) => (log.push(`${prop}(${a.join(',')})`), grad());
      if (prop === 'getImageData') return (_x: number, _y: number, iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4) });
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
    has: (_t, prop) => prop in state,
  };
  return { ctx: new Proxy({}, handler) as unknown as Ctx2D, log };
}

describe('renderFrame: Video tab', () => {
  const sources: FrameSources = { get: () => ({ image: {} as CanvasImageSource, width: 1080, height: 1920 }) };
  const setup = () => {
    const v = video();
    st().addAssets([v]);
    return st().addClip(v.id, { at: 0 })!;
  };

  it('draws a non-uniform scale', () => {
    const id = setup();
    st().updateClip(id, { transform: { uniformScale: false, scaleX: 0.5, scaleY: 1 } });
    const { ctx, log } = fakeCtx(1080, 1920);
    renderFrame(ctx, getFrameState(st().project, S(1)), { scale: 1, sources });
    expect(log).toContain('scale(0.5,1)');
  });

  it('a mask cuts the clip on its layer: circle = destination-in, inverted = destination-out, feather = blur', () => {
    const id = setup();
    st().updateClip(id, { mask: { shape: 'circle', width: 0.5, height: 0.28125, feather: 40 } });
    const main = fakeCtx(1080, 1920);
    const layer = fakeCtx(1080, 1920);
    renderFrame(main.ctx, getFrameState(st().project, S(1)), { scale: 1, sources, layers: { get: () => layer.ctx } });
    expect(layer.log).toContain('globalCompositeOperation=destination-in');
    expect(layer.log.some((l) => l.startsWith('ellipse(0,0,270,270'))).toBe(true);
    // feather 40 of a 540 px circle: 0.4 × 0.5 × 540 = 108 px ramp → σ = 27 px
    expect(layer.log).toContain('filter=blur(27.00px)');
    expect(main.log.some((l) => l.startsWith('drawImage(0,0)'))).toBe(true);

    st().updateClip(id, { mask: { invert: true, feather: 0 } });
    const layer2 = fakeCtx(1080, 1920);
    renderFrame(fakeCtx(1080, 1920).ctx, getFrameState(st().project, S(1)), { scale: 1, sources, layers: { get: () => layer2.ctx } });
    expect(layer2.log).toContain('globalCompositeOperation=destination-out');
    expect(layer2.log.some((l) => l.startsWith('filter=blur'))).toBe(false);
  });

  it('a feathered linear mask uses a gradient', () => {
    const id = setup();
    st().updateClip(id, { mask: { shape: 'linear', feather: 100 } });
    const layer = fakeCtx(1080, 1920);
    renderFrame(fakeCtx(1080, 1920).ctx, getFrameState(st().project, S(1)), { scale: 1, sources, layers: { get: () => layer.ctx } });
    // ramp = 0.5 × 1080 = 540 px centred on the line
    expect(layer.log).toContain('createLinearGradient(0,-270,0,270)');
    expect(layer.log).toContain('stop(0,rgba(0,0,0,1))');
    expect(layer.log).toContain('stop(1,rgba(0,0,0,0))');
  });

  it('background ops are drawn but not hit-testable', () => {
    const id = setup();
    st().updateClip(id, { canvas: { type: 'blur', blur: 1 } });
    const { ctx, log } = fakeCtx(1080, 1920);
    const boxes = renderFrame(ctx, getFrameState(st().project, S(1)), { scale: 1, sources });
    expect(boxes).toHaveLength(1);
    expect(log).toContain('filter=blur(12px)');
  });

  it('linear burn composites with difference + lighter passes', () => {
    const id = setup();
    st().updateClip(id, { blend: 'linear-burn', transform: { opacity: 0.5 } });
    const main = fakeCtx(1080, 1920);
    const layer = fakeCtx(1080, 1920);
    const inv = fakeCtx(1080, 1920);
    renderFrame(main.ctx, getFrameState(st().project, S(1)), { scale: 1, sources, layers: { get: () => layer.ctx }, scratch: { get: () => inv.ctx } });
    expect(inv.log).toContain('globalCompositeOperation=difference');
    const ops = main.log.filter((l) => l.startsWith('globalCompositeOperation='));
    expect(ops).toEqual(expect.arrayContaining(['globalCompositeOperation=difference', 'globalCompositeOperation=lighter']));
    expect(main.log).toContain('globalAlpha=0.5');
  });
});
