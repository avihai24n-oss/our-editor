/**
 * Animation tab v2: model + store rules (CapCut clamping, Combo/Loop slots, undo, split,
 * migration of old projects) and how getFrameState / renderFrame carry the animations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip, migrateProject } from '../model/project';
import { secToUs } from '../model/time';
import type { MediaAsset, Project, TextClip, VideoClip } from '../model/types';
import { useEditor } from '../store';
import { activeAnimations, framesToOp, getFrameState, resolveAnimation, type MediaDrawOp, type TextDrawOp } from './frameState';
import { animationFrame } from './animations';
import { fxFilter, renderFrame, revealLayout } from './render/renderFrame';
import type { Ctx2D, FrameSources } from './render/types';

const S = secToUs;
const st = () => useEditor.getState();
const video = (sec: number): MediaAsset =>
  createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(sec), width: 1080, height: 1920, hasAudio: false });
const clip = (id: string) => findClip(st().project, id)!.clip as VideoClip;

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true });
});

function fiveSecondClip() {
  const v = video(5);
  st().addAssets([v]);
  return st().addClip(v.id, { at: 0 })!;
}

describe('store: CapCut duration rules', () => {
  it('In/Out default 0.5 s; In + Out never exceed the clip (the slot edited last wins)', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'fade');
    expect(clip(id).animationIn).toEqual({ type: 'fade', duration: S(0.5) });
    st().setAnimation(id, 'out', 'slide-left');
    st().setAnimationDuration(id, 'in', S(4));
    expect(clip(id).animationIn!.duration).toBe(S(4));
    expect(clip(id).animationOut!.duration).toBe(S(0.5));
    st().setAnimationDuration(id, 'out', S(3));
    expect(clip(id).animationOut!.duration).toBe(S(3));
    expect(clip(id).animationIn!.duration).toBe(S(2)); // shrank to make room
    st().setAnimationDuration(id, 'out', S(99));
    expect(clip(id).animationOut!.duration).toBe(S(5));
    expect(clip(id).animationIn).toBeNull(); // nothing left for In
  });

  it('minimum 0.1 s; changing the type keeps the duration', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'fade', S(0.01));
    expect(clip(id).animationIn!.duration).toBe(S(0.1));
    st().setAnimationDuration(id, 'in', S(1.2));
    st().setAnimation(id, 'in', 'zoom-in');
    expect(clip(id).animationIn).toEqual({ type: 'zoom-in', duration: S(1.2) });
  });

  it('Combo defaults to the whole clip and replaces In/Out; applying In again removes the Combo', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'fade');
    st().setAnimation(id, 'out', 'fade');
    st().setAnimation(id, 'combo', 'zoom-in-out');
    let c = clip(id);
    expect(c.animationCombo).toEqual({ type: 'zoom-in-out', duration: S(5) });
    expect(c.animationIn).toBeNull();
    expect(c.animationOut).toBeNull();
    st().setAnimationDuration(id, 'combo', S(9));
    expect(clip(id).animationCombo!.duration).toBe(S(5));
    st().setAnimation(id, 'in', 'slide-up');
    c = clip(id);
    expect(c.animationCombo).toBeNull();
    expect(c.animationIn?.type).toBe('slide-up');
  });

  it('text Loop: one cycle 0.1–5 s, default 1 s, combines with In/Out', () => {
    const t = st().addTextClip({ at: 0, content: 'Hi' });
    st().setAnimation(t, 'in', 'typewriter');
    st().setAnimation(t, 'loop', 'pulse');
    const c = findClip(st().project, t)!.clip as TextClip;
    expect(c.animationLoop).toEqual({ type: 'pulse', duration: S(1) });
    expect(c.animationIn?.type).toBe('typewriter');
    st().setAnimationDuration(t, 'loop', S(30));
    expect((findClip(st().project, t)!.clip as TextClip).animationLoop!.duration).toBe(S(5));
  });

  it('trimming a clip shorter clamps every slot', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'combo', 'spin-360');
    st().trimEnd(id, S(2));
    expect(clip(id).animationCombo!.duration).toBe(S(2));
  });

  it('every change is one undo step; None removes', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'fade');
    st().setAnimationDuration(id, 'in', S(2));
    st().setAnimation(id, 'in', null);
    expect(clip(id).animationIn).toBeNull();
    st().undo();
    expect(clip(id).animationIn).toEqual({ type: 'fade', duration: S(2) });
    st().undo();
    expect(clip(id).animationIn).toEqual({ type: 'fade', duration: S(0.5) });
    st().undo();
    expect(clip(id).animationIn).toBeNull();
    st().redo();
    expect(clip(id).animationIn?.type).toBe('fade');
  });

  it('split: Combo stays on the left part, Loop on both', () => {
    const t = st().addTextClip({ at: 0, content: 'Hi' });
    st().setAnimation(t, 'loop', 'swing');
    const r = st().splitClip(t, S(1))!;
    expect((findClip(st().project, r)!.clip as TextClip).animationLoop?.type).toBe('swing');
    const id = fiveSecondClip();
    st().setAnimation(id, 'combo', 'shake-shake');
    const r2 = st().splitClip(id, S(2))!;
    expect(clip(id).animationCombo).toEqual({ type: 'shake-shake', duration: S(2) });
    expect(clip(r2).animationCombo).toBeNull();
  });

  it('audio clips refuse animations', () => {
    const a = createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: S(3), hasAudio: true });
    st().addAssets([a]);
    const id = st().addClip(a.id, { at: 0 })!;
    st().setAnimation(id, 'in', 'fade');
    expect('animationIn' in findClip(st().project, id)!.clip).toBe(false);
  });
});

describe('migration', () => {
  it('old projects get empty Combo / Loop slots and keep their In/Out', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'zoom-in');
    const p = structuredClone(st().project) as Project;
    const old = p.tracks[0]!.clips[0] as Partial<VideoClip>;
    delete old.animationCombo;
    delete old.animationLoop;
    const m = migrateProject(p);
    const c = m.tracks[0]!.clips[0] as VideoClip;
    expect(c.animationCombo).toBeNull();
    expect(c.animationLoop).toBeNull();
    expect(c.animationIn).toEqual({ type: 'zoom-in', duration: S(0.5) });
    expect(migrateProject(m)).toBe(m); // idempotent
  });

  it('setAnimation works on a clip that predates the Combo field', () => {
    const id = fiveSecondClip();
    const p = structuredClone(st().project) as Project;
    delete (p.tracks[0]!.clips[0] as Partial<VideoClip>).animationCombo;
    useEditor.setState({ project: p });
    st().setAnimation(id, 'combo', 'float');
    expect(clip(id).animationCombo?.type).toBe('float');
  });
});

describe('frame state', () => {
  it('In at the start, Out at the end, Combo from the start, Loop over the whole clip', () => {
    const t = st().addTextClip({ at: 0, content: 'Hello' }); // 3 s
    st().setAnimation(t, 'in', 'fade', S(1));
    st().setAnimation(t, 'out', 'slide-left', S(1));
    st().setAnimation(t, 'loop', 'pulse', S(0.4));
    const c = findClip(st().project, t)!.clip as TextClip;
    expect(activeAnimations(c, S(0.5)).map((a) => a.phase)).toEqual(['in', 'loop']);
    expect(activeAnimations(c, S(1.5)).map((a) => a.phase)).toEqual(['loop']);
    expect(activeAnimations(c, S(2.5)).map((a) => [a.phase, a.progress])).toEqual([
      ['out', 0.5],
      ['loop', expect.closeTo(0.25, 5)],
    ]);
    expect(activeAnimations(c, S(3))).toEqual([]);
  });

  it('the op carries the transform delta and the fx', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'flip-3d', S(1));
    const op = getFrameState(st().project, S(0.5)).ops[0] as MediaDrawOp;
    const f = animationFrame('in', 'flip-3d', 0.5);
    expect(op.fx!.sx).toBeCloseTo(f.sx);
    expect(op.fx!.skewY).toBeCloseTo(f.skewY);
    expect(op.transform.opacity).toBeCloseTo(f.alpha);
    expect(op.animation).toEqual({ phase: 'in', type: 'flip-3d', progress: 0.5 });
    // at rest: no fx at all
    expect((getFrameState(st().project, S(2)).ops[0] as MediaDrawOp).fx).toBeNull();
  });

  it('slides move the op by the canvas size; pixel effects scale with the canvas', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'slide-left', S(1));
    const op = getFrameState(st().project, 0).ops[0] as MediaDrawOp;
    expect(op.transform.x).toBeCloseTo(1080);
    const { fx } = framesToOp([animationFrame('in', 'rgb-split', 0)], 540, 960);
    expect(fx!.rgbSplit).toBeCloseTo(20); // 40 px @1080 → 20 px @540
  });

  it('Combo returns to rest at its end; unknown ids are ignored', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'combo', 'zoom-in-out', S(2));
    const at = (t: number) => getFrameState(st().project, t).ops[0] as MediaDrawOp;
    expect(at(S(1)).transform.scale).toBeCloseTo(1.3);
    expect(at(S(2.5)).transform.scale).toBe(1);
    st().updateClip(id, { animationCombo: { type: 'gone', duration: S(2) } });
    const r = resolveAnimation(clip(id), S(1), 1080, 1920);
    expect(r.effect.scaleMul).toBe(1);
    expect(r.fx).toBeNull();
  });
});

// ---------------------------------------------------------------- renderer

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
        log.push(`${prop}(${args.filter((a) => typeof a !== 'object').map((a) => (typeof a === 'number' ? Math.round(a * 100) / 100 : a)).join(',')})`);
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
const sources: FrameSources = { get: () => ({ image: {} as CanvasImageSource, width: 1080, height: 1920 }) };

describe('renderFrame with animations', () => {
  it('3D flip: skew/scale matrix around the pivot', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'door', S(1));
    const fs = getFrameState(st().project, S(0.5));
    const { ctx, log } = fakeCtx(1080, 1920);
    renderFrame(ctx, fs, { scale: 1, sources });
    const op = fs.ops[0] as MediaDrawOp;
    // pivot = left edge of the 1080-wide box
    expect(log).toContain('translate(-540,0)');
    expect(log.some((l) => l.startsWith(`transform(${Math.round(op.fx!.sx * 100) / 100},`))).toBe(true);
  });

  it('mask reveal clips to the shape in the clip box', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'wipe-right', S(1));
    const fs = getFrameState(st().project, 0.5 * S(1));
    const { ctx, log } = fakeCtx(1080, 1920);
    renderFrame(ctx, fs, { scale: 1, sources });
    // 87.5 % of the box width from its left edge (-540)
    expect(log).toContain('rect(-540,-960,945,1920)');
    expect(log).toContain('clip()');
  });

  it('light: brightness + glow join the colour filter', () => {
    expect(fxFilter(null, 1)).toBe('');
    const { fx } = framesToOp([animationFrame('in', 'glow', 0.2)], 1080, 1920);
    const f = fxFilter(fx, 1);
    expect(f).toMatch(/brightness\(/);
    expect(f).toMatch(/drop-shadow\(0 0 [\d.]+px rgba\(255,255,255,/);
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'flash', S(1));
    const { ctx, log } = fakeCtx(1080, 1920);
    renderFrame(ctx, getFrameState(st().project, 0), { scale: 1, sources });
    expect(log).toContain('filter=brightness(4)');
  });

  it('glitch goes through the scratch layer', () => {
    const id = fiveSecondClip();
    st().setAnimation(id, 'in', 'slice', S(1));
    const fs = getFrameState(st().project, S(0.1));
    const main = fakeCtx(1080, 1920);
    const layer = fakeCtx(1080, 1920);
    renderFrame(main.ctx, fs, { scale: 1, sources, layers: { get: () => layer.ctx } });
    expect(layer.log.some((l) => l.startsWith('drawImage'))).toBe(true);
    // 12 slices drawn from the layer
    expect(main.log.filter((l) => l.startsWith('drawImage(0,')).length).toBe(12);
  });

  it('typewriter draws only the revealed characters, in place', () => {
    const t = st().addTextClip({ at: 0, content: 'Hello' });
    st().setAnimation(t, 'in', 'typewriter', S(1));
    const fs = getFrameState(st().project, S(0.4));
    expect((fs.ops[0] as TextDrawOp).fx!.reveal).toBeCloseTo(0.4);
    const { ctx, log } = fakeCtx(1080, 1920);
    renderFrame(ctx, fs, { scale: 1, sources });
    expect(log.some((l) => l.startsWith('fillText(He,'))).toBe(true);
    expect(log.some((l) => l.startsWith('fillText(Hello'))).toBe(false);
  });

  it('revealLayout keeps line positions and counts characters across lines', () => {
    const L = { lines: [{ text: 'abcd', width: 40, x: -20, y: 0 }, { text: 'ef', width: 20, x: -10, y: 10 }], width: 40, height: 20, lineHeightPx: 10, padding: 0 };
    const r = revealLayout(L, 0.5, (t) => t.length * 10);
    expect(r.lines.map((l) => [l.text, l.x, l.width])).toEqual([
      ['abc', -20, 30],
      ['', -10, 0],
    ]);
    expect(revealLayout(L, 1, () => 0)).toBe(L);
  });
});

