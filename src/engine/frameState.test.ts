import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip, mainTrack } from '../model/project';
import { secToUs } from '../model/time';
import type { MediaAsset } from '../model/types';
import { useEditor } from '../store';
import {
  animationEffect,
  colorOps,
  fitSize,
  getFrameState,
  transitionEffect,
  type MediaDrawOp,
  type TextDrawOp,
} from './frameState';

const S = secToUs;
const st = () => useEditor.getState();
const video = (sec: number, hasAudio = true): MediaAsset =>
  createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(sec), width: 1920, height: 1080, hasAudio });
const audio = (sec: number) => createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: S(sec), hasAudio: true });

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true });
});

describe('getFrameState', () => {
  it('empty project → no ops, canvas size from settings', () => {
    const fs = getFrameState(st().project, 0);
    expect(fs).toMatchObject({ width: 1080, height: 1920, background: '#000000', ops: [], audio: [] });
  });

  it('visible clips, local media time with in-point and speed, layer order', () => {
    const v = video(10);
    st().addAssets([v]);
    const a = st().addClip(v.id, { at: 0 })!;
    st().trimStart(a, S(2)); // inPoint 2s
    st().setSpeed(a, 2); // 8s source → 4s timeline
    const o = st().addClip(v.id, { kind: 'overlay', at: S(1) })!;
    const t = st().addTextClip({ at: 0, content: 'Hi\nthere' });
    const fs = getFrameState(st().project, S(1.5));
    expect(fs.ops.map((x) => (x.kind === 'fill' ? 'fill' : x.clipId))).toEqual([a, o, t]);
    const main = fs.ops[0] as MediaDrawOp;
    expect(main.sourceTime).toBe(S(2) + S(1.5) * 2);
    expect(main.mediaType).toBe('video');
    expect(main.layer).toBe(0);
    // 1920x1080 contained in 1080x1920
    expect(main.fitWidth).toBeCloseTo(1080);
    expect(main.fitHeight).toBeCloseTo(607.5);
    expect((fs.ops[1] as MediaDrawOp).sourceTime).toBe(S(0.5));
    expect((fs.ops[2] as TextDrawOp).lines).toEqual(['Hi', 'there']);
    // after the main clip ends (4s) only the overlay + nothing else
    expect(getFrameState(st().project, S(4.5)).ops.map((x) => (x.kind === 'fill' ? 'fill' : x.clipId))).toEqual([o]);
  });

  it('hidden tracks and disabled clips are not drawn; hidden tracks still sound', () => {
    const v = video(5);
    st().addAssets([v]);
    const a = st().addClip(v.id, { at: 0 })!;
    st().setTrack(mainTrack(st().project).id, { hidden: true });
    let fs = getFrameState(st().project, S(1));
    expect(fs.ops).toHaveLength(0);
    expect(fs.audio).toHaveLength(1);
    st().setTrack(mainTrack(st().project).id, { hidden: false });
    st().updateClip(a, { disabled: true });
    fs = getFrameState(st().project, S(1));
    expect(fs.ops).toHaveLength(0);
    expect(fs.audio).toHaveLength(0);
  });

  it('transform, opacity, blend, filter resolve into the op', () => {
    const v = video(5);
    st().addAssets([v]);
    const a = st().addClip(v.id, { at: 0 })!;
    st().updateClip(a, {
      transform: { x: 50, y: -20, scale: 1.5, rotation: 30, opacity: 0.5, flipH: true },
      blend: 'screen',
      filter: { id: 'mono', intensity: 0.5 },
      adjust: { contrast: 10 },
    });
    const op = getFrameState(st().project, S(1)).ops[0] as MediaDrawOp;
    expect(op.transform).toEqual({ x: 50, y: -20, scale: 1.5, rotation: 30, opacity: 0.5, flipH: true, flipV: false });
    expect(op.composite).toBe('screen');
    expect(op.color.grayscale).toBe(0.5);
    expect(op.color.contrast).toBe(10);
  });

  it('animation in/out progress and effect', () => {
    const v = video(5);
    st().addAssets([v]);
    const a = st().addClip(v.id, { at: 0 })!;
    st().setAnimation(a, 'in', 'fade', S(1));
    st().setAnimation(a, 'out', 'slide-left', S(1));
    let op = getFrameState(st().project, 0).ops[0] as MediaDrawOp;
    expect(op.animation).toEqual({ phase: 'in', type: 'fade', progress: 0 });
    expect(op.transform.opacity).toBe(0);
    op = getFrameState(st().project, S(0.5)).ops[0] as MediaDrawOp;
    expect(op.animation?.progress).toBe(0.5);
    expect(op.transform.opacity).toBeGreaterThan(0.5);
    op = getFrameState(st().project, S(2)).ops[0] as MediaDrawOp;
    expect(op.animation).toBeNull();
    expect(op.transform.opacity).toBe(1);
    op = getFrameState(st().project, S(4.5)).ops[0] as MediaDrawOp;
    expect(op.animation).toEqual({ phase: 'out', type: 'slide-left', progress: 0.5 });
    expect(op.transform.x).toBeLessThan(0); // exits to the left
  });

  it('transition window draws both clips with progress; source held at edges', () => {
    const v = video(4);
    st().addAssets([v]);
    const a = st().addClip(v.id, { at: 0 })!;
    const b = st().addClip(v.id, { at: S(10) })!;
    const tr = st().addTransition(a, 'mix', S(1))!;
    // window = [3.5, 4.5)
    let fs = getFrameState(st().project, S(3.4));
    expect(fs.ops.map((o) => (o.kind === 'fill' ? 'fill' : o.clipId))).toEqual([a]);
    fs = getFrameState(st().project, S(3.75));
    expect(fs.ops.map((o) => (o.kind === 'fill' ? 'fill' : o.clipId))).toEqual([a, b]);
    const from = fs.ops[0] as MediaDrawOp;
    const to = fs.ops[1] as MediaDrawOp;
    expect(from.transition).toEqual({ id: tr, type: 'mix', role: 'from', progress: 0.25 });
    expect(to.transform.opacity).toBeCloseTo(0.25);
    expect(to.sourceTime).toBe(0); // before b starts → clamped to 0
    fs = getFrameState(st().project, S(4.25));
    const from2 = fs.ops[0] as MediaDrawOp;
    expect(from2.clipId).toBe(a);
    expect(from2.sourceTime).toBe(S(4) - 1); // past a's source end → held
    expect(getFrameState(st().project, S(4.5)).ops.map((o) => (o.kind === 'fill' ? 'fill' : o.clipId))).toEqual([b]);
  });

  it('dip-to-black emits a fill op', () => {
    const v = video(4);
    st().addAssets([v]);
    const a = st().addClip(v.id, { at: 0 })!;
    st().addClip(v.id, { at: S(10) });
    st().addTransition(a, 'fade-black', S(1));
    const fs = getFrameState(st().project, S(3.75));
    expect(fs.ops.map((o) => o.kind)).toEqual(['media', 'fill']);
    expect(fs.ops[1]).toMatchObject({ kind: 'fill', color: '#000000', opacity: 0.5 });
  });

  it('audio ops: volume, fades, mute, speed; video without audio is silent', () => {
    const v = video(10);
    const silent = video(10, false);
    const au = audio(10);
    st().addAssets([v, silent, au]);
    const a = st().addClip(v.id, { at: 0 })!;
    const s = st().addClip(silent.id, { kind: 'overlay', at: 0 })!;
    const m = st().addClip(au.id, { at: 0 })!;
    st().updateClip(m, { audio: { volumeDb: -6, fadeIn: S(2) } });
    st().setSpeed(m, 2);
    let fs = getFrameState(st().project, S(1));
    expect(fs.audio.map((x) => x.clipId).sort()).toEqual([a, m].sort());
    expect(fs.audio.find((x) => x.clipId === s)).toBeUndefined();
    const music = fs.audio.find((x) => x.clipId === m)!;
    expect(music.gain).toBeCloseTo(Math.pow(10, -6 / 20) * 0.5);
    expect(music.speed).toBe(2);
    expect(music.sourceTime).toBe(S(2));
    st().setTrack(findClip(st().project, m)!.track.id, { muted: true });
    st().updateClip(a, { audio: { muted: true } });
    fs = getFrameState(st().project, S(1));
    expect(fs.audio).toHaveLength(0);
  });
});

describe('pure effects', () => {
  it('fitSize contains', () => {
    expect(fitSize({ width: 1000, height: 1000 }, 1080, 1920)).toEqual({ width: 1080, height: 1080 });
    expect(fitSize(undefined, 1080, 1920)).toEqual({ width: 1080, height: 1920 });
  });
  it('animations end at rest (in) and start at rest (out)', () => {
    for (const type of ['fade', 'zoom-in', 'zoom-out', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'rotate', 'blur'] as const) {
      const endIn = animationEffect(type, 'in', 1, 1080, 1920);
      const startOut = animationEffect(type, 'out', 0, 1080, 1920);
      for (const e of [endIn, startOut]) {
        expect(e.dx).toBeCloseTo(0);
        expect(e.dy).toBeCloseTo(0);
        expect(e.scaleMul).toBeCloseTo(1);
        expect(e.rotation).toBeCloseTo(0);
        expect(e.alphaMul).toBeCloseTo(1);
        expect(e.blur).toBeCloseTo(0);
      }
    }
    expect(animationEffect('slide-left', 'in', 0, 1080, 1920).dx).toBe(1080); // comes from the right
    expect(animationEffect('slide-right', 'in', 0, 1080, 1920).dx).toBe(-1080);
  });
  it('transitions: from fully shown at p=0, to fully shown at p=1', () => {
    for (const type of ['mix', 'fade-black', 'fade-white', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'wipe-left', 'wipe-right', 'zoom', 'blur'] as const) {
      const start = transitionEffect(type, 0, 1080, 1920);
      expect(start.from.visible).toBe(true);
      expect(start.from.dx).toBeCloseTo(0);
      expect(start.from.alphaMul).toBeCloseTo(1);
      const end = transitionEffect(type, 1, 1080, 1920);
      expect(end.to.visible).toBe(true);
      expect(end.to.dx).toBeCloseTo(0);
      expect(end.to.dy).toBeCloseTo(0);
      expect(end.to.alphaMul).toBeCloseTo(1);
      expect(end.fill?.opacity ?? 0).toBeCloseTo(0);
    }
  });
  it('colorOps merges filter by intensity', () => {
    const c = {
      adjust: { brightness: 0, contrast: 0, saturation: 5, exposure: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, fade: 0, vignette: 0, sharpen: 0 },
      filter: { id: 'warm' as const, intensity: 0.5 },
    };
    const ops = colorOps(c as never);
    expect(ops.temperature).toBe(15);
    expect(ops.saturation).toBe(9);
  });
});
