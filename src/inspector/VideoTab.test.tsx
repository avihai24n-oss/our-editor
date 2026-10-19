// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsset, defaultMask } from '../model/defaults';
import { findClip } from '../model/project';
import { secToUs } from '../model/time';
import type { ImageClip, VideoClip } from '../model/types';
import { useMaskEdit } from '../player/maskEdit';
import { featherFromDrag, maskPositionAt, maskRotationFromDrag, maskScreenFrame, maskSizeAt, type ClipFrame } from '../player/maskMath';
import { useEditor } from '../store';
import { Inspector } from './Inspector';
import { displayedBox, maskForShape, pictureBox, uniformScalePatch } from './inspectorLogic';

const st = () => useEditor.getState();
const S = secToUs;
const video = () => createAsset({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 1, duration: S(4), width: 1920, height: 1080, hasAudio: true });
const image = () => createAsset({ kind: 'image', name: 'pic.png', mime: 'image/png', size: 1, duration: 0, width: 800, height: 800 });
const clip = (id: string) => findClip(st().project, id)!.clip as VideoClip | ImageClip;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  act(() => st().newProject());
});
afterEach(cleanup);

function setup(kind: 'video' | 'image' = 'video', track: 'main' | 'overlay' = 'main') {
  const a = kind === 'video' ? video() : image();
  let id = '';
  act(() => {
    st().addAssets([a]);
    id = st().addClip(a.id, { at: 0, kind: track })!;
    st().select([id], 'replace');
  });
  render(<Inspector />);
  return id;
}

describe('inspector logic (Video tab)', () => {
  it('uniform scale switch', () => {
    expect(uniformScalePatch({ scale: 1.5, scaleX: 1, scaleY: 1 }, false)).toEqual({ uniformScale: false, scaleX: 1.5, scaleY: 1.5 });
    expect(uniformScalePatch({ scale: 1.5, scaleX: 0.7, scaleY: 2 }, true)).toEqual({ uniformScale: true, scale: 0.7 });
    expect(displayedBox({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 0.5, y: 2 }, 0)).toEqual({ width: 50, height: 200 });
  });

  it('picture box and default mask sizes per shape', () => {
    const box = pictureBox({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });
    expect(box.w).toBeCloseTo(1080);
    expect(box.h).toBeCloseTo(607.5);
    expect(pictureBox({ width: 100, height: 100 }, { width: 100, height: 100 }, { left: 0.25, right: 0.25, top: 0, bottom: 0.5 })).toEqual({ w: 50, h: 50 });
    const circle = maskForShape('circle', defaultMask(), box);
    // a square half the shorter side: 303.75 px
    expect((circle.width ?? 0) * box.w).toBeCloseTo(303.75);
    expect((circle.height ?? 0) * box.h).toBeCloseTo(303.75);
    expect(maskForShape('mirror', defaultMask(), box)).toMatchObject({ shape: 'mirror', width: 1, height: 0.3 });
    expect(maskForShape('none', defaultMask(), box)).toEqual({ shape: 'none' });
    // position and rotation carry over between shapes
    const moved = { ...defaultMask(), shape: 'circle' as const, x: 0.2, rotation: 30 };
    expect(maskForShape('star', moved, box)).toMatchObject({ x: 0.2, rotation: 30 });
  });

  it('on-canvas mask maths', () => {
    const f: ClipFrame = { cx: 500, cy: 500, w: 400, h: 200, rotation: 0, flipH: false, flipV: false };
    const m = { ...defaultMask(), shape: 'circle' as const, x: 0.25, y: -0.5, width: 0.5, height: 1 };
    expect(maskScreenFrame(m, f)).toEqual({ cx: 600, cy: 400, w: 200, h: 200, rotation: 0 });
    expect(maskPositionAt(f, { x: 600, y: 400 })).toEqual({ x: 0.25, y: -0.5 });
    // flipped clip: the mask moves with the picture
    expect(maskScreenFrame(m, { ...f, flipH: true }).cx).toBe(400);
    expect(maskPositionAt({ ...f, flipH: true }, { x: 400, y: 400 })).toEqual({ x: 0.25, y: -0.5 });
    // rotated clip
    const r = maskScreenFrame({ ...m, x: 0.25, y: 0 }, { ...f, rotation: 90 });
    expect(r.cx).toBeCloseTo(500);
    expect(r.cy).toBeCloseTo(600);
    expect(maskSizeAt(m, f, { x: 800, y: 600 })).toEqual({ width: 1, height: 2 });
    expect(maskRotationFromDrag(0, f, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 })).toBe(90);
    expect(maskRotationFromDrag(0, { ...f, flipH: true }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 })).toBe(-90);
    expect(featherFromDrag(10, 50, 100)).toBe(60);
    expect(featherFromDrag(10, -500, 100)).toBe(0);
  });
});

describe('Video tab UI', () => {
  it('has CapCut sub-tabs and AI sections switched off', () => {
    setup();
    for (const label of ['Basic', 'Remove BG', 'Mask']) expect((screen.getByRole('tab', { name: label }) as HTMLButtonElement).disabled).toBe(false);
    for (const id of ['stabilize', 'enhance', 'denoise', 'opticalflow', 'airemove', 'aiexpand', 'retouch']) {
      const sec = screen.getByTestId(`section-${id}`);
      expect((sec.querySelector('input[type=checkbox]') as HTMLInputElement).disabled).toBe(true);
      expect(sec.textContent).toContain('Coming soon');
    }
    expect(screen.getByTestId('section-canvas')).toBeTruthy();
  });

  it('image clips: no video-only AI sections; overlay clips: no Canvas', () => {
    setup('image', 'overlay');
    expect(screen.queryByTestId('section-stabilize')).toBeNull();
    expect(screen.queryByTestId('section-opticalflow')).toBeNull();
    expect(screen.queryByTestId('section-canvas')).toBeNull();
    expect(screen.getByTestId('section-transform')).toBeTruthy();
  });

  it('Uniform scale off shows width / height sliders', () => {
    const id = setup();
    fireEvent.click(screen.getByRole('switch', { name: 'Uniform scale' }));
    expect(clip(id).transform.uniformScale).toBe(false);
    const w = screen.getByRole('slider', { name: 'Scale width' });
    act(() => {
      fireEvent.pointerDown(w);
      fireEvent.change(w, { target: { value: '50' } });
      window.dispatchEvent(new Event('pointerup'));
    });
    expect(clip(id).transform.scaleX).toBe(0.5);
    expect(clip(id).transform.scaleY).toBe(1);
    // Reset brings back uniform 100 %
    fireEvent.click(screen.getByRole('button', { name: 'Reset Transform' }));
    expect(clip(id).transform).toMatchObject({ uniformScale: true, scale: 1, scaleX: 1, scaleY: 1 });
  });

  it('Canvas: colour, blur, Apply to all', () => {
    const a = video();
    let ids: string[] = [];
    act(() => {
      st().addAssets([a]);
      ids = [st().addClip(a.id, { at: 0 })!, st().addClip(a.id, { at: S(4) })!];
      st().select([ids[0]!], 'replace');
    });
    render(<Inspector />);
    fireEvent.click(screen.getByLabelText('Enable Canvas'));
    expect(clip(ids[0]!).canvas.type).toBe('blur');
    fireEvent.click(screen.getByRole('button', { name: 'Blur 4' }));
    expect(clip(ids[0]!).canvas.blur).toBe(4);
    fireEvent.change(screen.getByLabelText('Canvas type'), { target: { value: 'color' } });
    fireEvent.click(screen.getByRole('button', { name: 'Canvas colour #e94b3c' }));
    expect(clip(ids[0]!).canvas).toMatchObject({ type: 'color', color: '#e94b3c' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all' }));
    expect(clip(ids[1]!).canvas).toMatchObject({ type: 'color', color: '#e94b3c' });
    act(() => st().undo());
    expect(clip(ids[1]!).canvas.type).toBe('none');
  });

  it('Remove BG: AI rows disabled, chroma key works', () => {
    const id = setup();
    fireEvent.click(screen.getByRole('tab', { name: 'Remove BG' }));
    expect((screen.getByTestId('section-autoremoval').querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('section-customremoval').querySelector('input') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Enable Chroma key'));
    expect(clip(id).chroma.enabled).toBe(true);
    const s = screen.getByRole('slider', { name: 'Intensity' });
    act(() => {
      fireEvent.pointerDown(s);
      fireEvent.change(s, { target: { value: '80' } });
      window.dispatchEvent(new Event('pointerup'));
    });
    expect(clip(id).chroma.intensity).toBe(80);
  });

  it('Mask: shape tiles, controls, invert, on-canvas edit flag', () => {
    const id = setup();
    fireEvent.click(screen.getByRole('tab', { name: 'Mask' }));
    expect(useMaskEdit.getState().active).toBe(true);
    for (const s of ['none', 'linear', 'mirror', 'circle', 'rectangle', 'heart', 'star']) expect(screen.getByTestId(`mask-${s}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('mask-rectangle'));
    expect(clip(id).mask).toMatchObject({ shape: 'rectangle', width: 0.6, height: 0.4 });
    expect(screen.getByTestId('mask-round')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Invert mask' }));
    expect(clip(id).mask.invert).toBe(true);
    const box = screen.getByLabelText('Mask width') as HTMLInputElement;
    act(() => {
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: '540' } });
      fireEvent.blur(box);
    });
    expect(clip(id).mask.width).toBeCloseTo(0.5);
    fireEvent.click(screen.getByTestId('mask-linear'));
    expect(screen.queryByLabelText('Mask width')).toBeNull();
    fireEvent.click(screen.getByTestId('mask-none'));
    expect(clip(id).mask.shape).toBe('none');
    fireEvent.click(screen.getByRole('tab', { name: 'Basic' }));
    expect(useMaskEdit.getState().active).toBe(false);
  });
});
