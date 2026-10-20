import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import { curveMean, presetCurve } from '../model/speedCurve';
import { secToUs, sourceSpan } from '../model/time';
import type { AudioClip, Clip, ImageClip, TextClip, VideoClip } from '../model/types';
import { useEditor } from '../store';
import { projectViolations } from '../store/invariants';
import { slots } from '../timeline/contextMenu/registry';
import { resolveShortcut, shortcutLabel } from '../timeline/shortcutDefs';
import { useTimelineUi } from '../timeline/uiStore';
import {
  applicableGroups,
  attributesMenuItem,
  copyAttributes,
  extractAttributes,
  pasteAttributes,
  requestPasteAttributes,
  usePasteAttributesDialog,
  type AttrGroup,
} from './attributes';

const S = secToUs;
const st = () => useEditor.getState();
const clip = <T extends Clip>(id: string) => findClip(st().project, id)!.clip as T;
const healthy = () => expect(projectViolations(st().project, { magnet: st().magnet, selection: st().selection.clipIds })).toEqual([]);

function video(sec = 5, at?: number) {
  const a = createAsset({ kind: 'video', name: `v${Math.random()}.mp4`, mime: 'video/mp4', size: 1, duration: S(sec), width: 1080, height: 1920, hasAudio: true });
  st().addAssets([a]);
  return st().addClip(a.id, at === undefined ? {} : { at })!;
}
function image() {
  const a = createAsset({ kind: 'image', name: 'i.png', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100 });
  st().addAssets([a]);
  return st().addClip(a.id, { kind: 'overlay', at: 0 })!;
}
function audio() {
  const a = createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: S(6) });
  st().addAssets([a]);
  return st().addClip(a.id, { at: 0 })!;
}

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true });
  useTimelineUi.setState({ attributeClipboard: null });
  usePasteAttributesDialog.getState().close();
});

/** A source video with every group changed from its default. */
function styledSource(): string {
  const id = video(5);
  st().updateClip(id, {
    transform: { x: 120, y: -40, rotation: 30, uniformScale: false, scaleX: 1.5, scaleY: 0.7, flipH: true, opacity: 0.4 },
    crop: { left: 0.1 },
    blend: 'screen',
    blendEnabled: true,
    mask: { shape: 'circle', feather: 30 },
    chroma: { enabled: true, color: '#00ff00', intensity: 40 },
    canvas: { type: 'color', color: '#ff0000' },
    filter: { id: 'noir', intensity: 0.8 },
    adjust: { saturation: -20, contrast: 15 },
    audio: { volumeDb: -6, fadeIn: S(0.5), fadeOut: S(0.3), normalize: true, reduceNoise: true, fillChannel: 'left', voiceFilter: { id: 'robot', strength: 70 } },
    preservePitch: false,
  });
  st().setAnimation(id, 'in', 'fade', S(0.4));
  st().setAnimation(id, 'out', 'zoom-out', S(0.6));
  st().setSpeed(id, 2);
  return id;
}

describe('extractAttributes', () => {
  it('copies every group of a main-track video (not mute, deep copies)', () => {
    const id = styledSource();
    const snap = extractAttributes(st().project, id)!;
    expect(Object.keys(snap.groups).sort()).toEqual(['adjust', 'animation', 'audio', 'blend', 'canvas', 'chroma', 'mask', 'speed', 'transform']);
    expect(snap.groups.transform).toMatchObject({ x: 120, scaleX: 1.5, scaleY: 0.7, uniformScale: false, flipH: true });
    expect(snap.groups.transform).not.toHaveProperty('opacity');
    expect(snap.groups.blend).toEqual({ blend: 'screen', blendEnabled: true, opacity: 0.4 });
    expect(snap.groups.speed).toEqual({ speed: 2, speedCurve: null, preservePitch: false });
    expect(snap.groups.audio).not.toHaveProperty('muted');
    expect(snap.groups.animation!.in).toEqual({ type: 'fade', duration: S(0.4) });
    // later edits of the source do not reach the clipboard
    st().updateClip(id, { transform: { x: 0 } });
    expect(snap.groups.transform!.x).toBe(120);
  });

  it('text: style without content; audio: speed + audio; overlay image: no canvas', () => {
    const t = st().addTextClip({ content: 'Hello' });
    expect(Object.keys(extractAttributes(st().project, t)!.groups).sort()).toEqual(['adjust', 'animation', 'blend', 'text', 'transform']);
    expect(extractAttributes(st().project, t)!.groups.text).not.toHaveProperty('content');
    const au = audio();
    const im = image();
    expect(Object.keys(extractAttributes(st().project, au)!.groups).sort()).toEqual(['audio', 'speed']);
    expect(extractAttributes(st().project, im)!.groups.canvas).toBeUndefined();
  });
});

describe('pasteAttributes', () => {
  it('pastes each group onto another video, one undo step, model healthy', () => {
    const src = styledSource();
    const dst = video(4);
    const snap = extractAttributes(st().project, src)!;
    const past = st().past.length;
    const all: AttrGroup[] = ['transform', 'blend', 'mask', 'chroma', 'canvas', 'speed', 'animation', 'adjust', 'audio'];
    expect(pasteAttributes([dst], all, snap)).toEqual([dst]);
    expect(st().past.length).toBe(past + 1);
    healthy();
    const c = clip<VideoClip>(dst);
    const s = clip<VideoClip>(src);
    expect(c.transform).toEqual(s.transform);
    expect(c.crop).toEqual(s.crop);
    expect([c.blend, c.blendEnabled]).toEqual(['screen', true]);
    expect(c.mask).toEqual(s.mask);
    expect(c.chroma).toEqual(s.chroma);
    expect(c.canvas).toEqual(s.canvas);
    expect(c.filter).toEqual({ id: 'noir', intensity: 0.8 });
    expect(c.adjust).toEqual(s.adjust);
    expect(c.grade).toEqual(s.grade);
    expect(c.animationIn).toEqual(s.animationIn);
    expect(c.animationOut).toEqual(s.animationOut);
    expect({ ...c.audio, muted: 0 }).toEqual({ ...s.audio, muted: 0 });
    expect(c.speed).toBe(2);
    expect(c.preservePitch).toBe(false);
    expect(c.duration).toBe(S(2)); // 4 s source at 2x
    // nested objects are not shared with the source
    expect(c.audio.voiceFilter).not.toBe(s.audio.voiceFilter);
    st().undo();
    expect(clip<VideoClip>(dst).speed).toBe(1);
    expect(clip<VideoClip>(dst).transform.x).toBe(0);
    expect(clip<VideoClip>(dst).duration).toBe(S(4));
  });

  it('only the ticked groups are pasted', () => {
    const src = styledSource();
    const dst = video(4);
    pasteAttributes([dst], ['mask'], extractAttributes(st().project, src)!);
    const c = clip<VideoClip>(dst);
    expect(c.mask.shape).toBe('circle');
    expect(c.transform.x).toBe(0);
    expect(c.speed).toBe(1);
    expect(c.blend).toBe('normal');
  });

  it('speed curve paste recomputes the duration of every target and keeps the source span', () => {
    const src = video(5);
    st().setSpeedCurve(src, presetCurve('bullet'));
    const a = video(4);
    const b = video(3);
    const before = [a, b].map((id) => sourceSpan(clip<VideoClip>(id)));
    const past = st().past.length;
    pasteAttributes([a, b], ['speed'], extractAttributes(st().project, src)!);
    expect(st().past.length).toBe(past + 1);
    healthy();
    [a, b].forEach((id, i) => {
      const c = clip<VideoClip>(id);
      expect(c.speedCurve?.preset).toBe('bullet');
      expect(c.speed).toBe(1);
      expect(Math.abs(sourceSpan(c) - before[i]!)).toBeLessThanOrEqual(2);
      expect(Math.abs(c.duration - before[i]! / curveMean(presetCurve('bullet')))).toBeLessThanOrEqual(1);
    });
    // standard speed over a curve clears the curve
    const std = video(2);
    st().setSpeed(std, 0.5);
    pasteAttributes([a], ['speed'], extractAttributes(st().project, std)!);
    expect(clip<VideoClip>(a).speedCurve).toBeNull();
    expect(clip<VideoClip>(a).speed).toBe(0.5);
    healthy();
  });

  it('animations and fades are clamped to a shorter target; combo replaces In/Out', () => {
    const src = video(5);
    st().setAnimation(src, 'combo', 'rotate', S(4));
    st().updateClip(src, { audio: { fadeIn: S(3), fadeOut: S(1) } });
    const dst = video(1);
    st().setAnimation(dst, 'in', 'fade', S(0.3));
    pasteAttributes([dst], ['animation', 'audio'], extractAttributes(st().project, src)!);
    const c = clip<VideoClip>(dst);
    expect(c.animationIn).toBeNull();
    expect(c.animationCombo).toEqual({ type: 'rotate', duration: S(1) });
    expect(c.audio.fadeIn + c.audio.fadeOut).toBeLessThanOrEqual(c.duration);
    healthy();
  });

  it('text style without content; video groups skip text and audio targets', () => {
    const t1 = st().addTextClip({ content: 'One' });
    st().updateClip(t1, { text: { color: '#ff00ff', fontSize: 120, bold: true, stroke: { enabled: true, width: 6 } } });
    st().setAnimation(t1, 'loop', 'rotate', S(1));
    const t2 = st().addTextClip({ content: 'Two', at: S(10) });
    pasteAttributes([t2], ['text', 'animation'], extractAttributes(st().project, t1)!);
    const c = clip<TextClip>(t2);
    expect(c.text.content).toBe('Two');
    expect(c.text).toMatchObject({ color: '#ff00ff', fontSize: 120, bold: true, stroke: { enabled: true, width: 6 } });
    expect(c.animationLoop?.type).toBe('rotate');

    const src = styledSource();
    const au = audio();
    const snap = extractAttributes(st().project, src)!;
    expect(applicableGroups(snap, st().project, [au])).toEqual(['speed', 'audio']);
    expect(applicableGroups(snap, st().project, [t2])).toEqual(['transform', 'blend', 'animation', 'adjust']);
    const im = image();
    expect(applicableGroups(snap, st().project, [im])).toEqual(['transform', 'blend', 'mask', 'chroma', 'animation', 'adjust']);
    pasteAttributes([au, t2, im], ['transform', 'speed', 'audio', 'mask', 'canvas'], snap);
    expect(clip<AudioClip>(au).audio.volumeDb).toBe(-6);
    expect(clip<AudioClip>(au).speed).toBe(2);
    expect(clip<TextClip>(t2).transform.x).toBe(120);
    expect(clip<ImageClip>(im).mask.shape).toBe('circle');
    expect(clip<ImageClip>(im).canvas.type).toBe('none'); // overlay: no canvas
    healthy();
  });
});

describe('commands, menu item and shortcuts', () => {
  it('⌥⌘C / ⌥⌘V are in the shortcut table and do not shadow ⌘C / ⌘V', () => {
    const k = (code: string, alt: boolean) => ({ key: 'x', code, metaKey: true, ctrlKey: false, shiftKey: false, altKey: alt });
    expect(resolveShortcut(k('KeyC', true))).toBe('copyAttributes');
    expect(resolveShortcut(k('KeyV', true))).toBe('pasteAttributes');
    expect(resolveShortcut(k('KeyC', false))).toBe('copy');
    expect(resolveShortcut(k('KeyV', false))).toBe('paste');
    expect(shortcutLabel('copyAttributes', 'mac')).toBe('⌥⌘C');
    expect(shortcutLabel('pasteAttributes', 'win')).toBe('Ctrl+Alt+V');
  });

  it('registers the slot; Paste is disabled until something is copied; paste opens the dialog', () => {
    expect(slots.attributes).toBe(attributesMenuItem);
    const src = styledSource();
    const dst = video(3);
    const ctx = { clipIds: [dst], primaryId: dst, trackId: '', time: 0 };
    const [copy, paste] = attributesMenuItem.submenu!(ctx);
    expect(copy!.disabled!(ctx)).toBe(false);
    expect(copy!.disabled!({ ...ctx, primaryId: 'nope' })).toBe(true);
    expect(paste!.disabled!(ctx)).toBe(true);
    expect(requestPasteAttributes([dst])).toBe(false);
    expect(copyAttributes(src)).toBe(true);
    expect(paste!.disabled!(ctx)).toBe(false);
    paste!.run!(ctx);
    expect(usePasteAttributesDialog.getState()).toMatchObject({ open: true, targets: [dst] });
    // nothing applies to an audio clip from a text clip
    const t = st().addTextClip({ content: 'x', at: S(20) });
    copyAttributes(t);
    const au = audio();
    expect(paste!.disabled!({ ...ctx, clipIds: [au], primaryId: au })).toBe(true);
  });
});
