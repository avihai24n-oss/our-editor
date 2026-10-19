// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsset, defaultGrade } from '../model/defaults';
import { findClip } from '../model/project';
import { secToUs } from '../model/time';
import type { VisualClip } from '../model/types';
import { AdjustmentTab } from '../panels/LooksTabs';
import { useEditor } from '../store';
import { PRESETS_KEY, useAdjustPresets } from '../store/adjustPresets';
import { Inspector } from './Inspector';

const st = () => useEditor.getState();
const S = secToUs;
const video = () => createAsset({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 1, duration: S(4), width: 1920, height: 1080, hasAudio: false });
const clipOf = (id: string) => findClip(st().project, id)!.clip as VisualClip;

let id = '';
let id2 = '';

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  useAdjustPresets.getState().reload();
  const a = video();
  act(() => {
    st().newProject();
    st().addAssets([a]);
    id = st().addClip(a.id, { at: 0 })!;
    id2 = st().addClip(a.id, { at: S(4) })!;
    st().select([id]);
  });
  render(<Inspector />);
  fireEvent.click(screen.getByRole('tab', { name: 'Adjust' }));
});
afterEach(cleanup);

const sub = (label: string) => fireEvent.click(screen.getByRole('tab', { name: label }));
const drag = (el: HTMLElement, value: string) =>
  act(() => {
    fireEvent.pointerDown(el);
    fireEvent.change(el, { target: { value } });
    fireEvent.pointerUp(window);
  });

describe('Inspector › Adjust', () => {
  it('has CapCut sub-tabs, and the AI rows are disabled "coming soon"', () => {
    for (const l of ['Basic', 'HSL', 'Curves', 'Color wheel', 'Mask']) expect((screen.getByRole('tab', { name: l }) as HTMLButtonElement).disabled).toBe(false);
    for (const r of ['auto-adjust', 'color-match', 'color-correction']) {
      const row = screen.getByTestId(`adjust-ai-${r}`);
      expect((row.querySelector('input[type=checkbox]') as HTMLInputElement).disabled).toBe(true);
      expect(row.textContent).toMatch(/coming soon/i);
    }
    for (const l of ['Temp', 'Tint', 'Saturation', 'Exposure', 'Brightness', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks', 'Brilliance', 'Sharpen', 'Clarity', 'Particles', 'Fade', 'Vignette'])
      expect(screen.getByRole('slider', { name: l })).toBeTruthy();
  });

  it('Basic sliders are undoable, one step per drag, and reset per section', () => {
    const before = st().past.length;
    drag(screen.getByRole('slider', { name: 'Whites' }), '-30');
    expect(clipOf(id).adjust.whites).toBe(-30);
    expect(st().past.length).toBe(before + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Adjust' }));
    expect(clipOf(id).adjust.whites).toBe(0);
    act(() => st().undo());
    expect(clipOf(id).adjust.whites).toBe(-30);
  });

  it('HSL: picks a range and edits its hue / saturation / lightness', () => {
    sub('HSL');
    fireEvent.click(screen.getByTestId('hsl-blue'));
    drag(screen.getByRole('slider', { name: 'Saturation' }), '-100');
    expect(clipOf(id).grade.hsl.bands.blue.saturation).toBe(-100);
    expect(clipOf(id).grade.hsl.bands.red.saturation).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reset HSL' }));
    expect(clipOf(id).grade.hsl).toEqual(defaultGrade().hsl);
  });

  it('Color wheel: luminance slider and per-wheel reset', () => {
    sub('Color wheel');
    for (const w of ['lift', 'gamma', 'gain', 'offset']) expect(screen.getByTestId(`wheel-${w}`)).toBeTruthy();
    drag(screen.getByTestId('wheel-lift-luma').querySelector('input[type=range]') as HTMLElement, '40');
    expect(clipOf(id).grade.wheels.lift.luma).toBe(40);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Lift' }));
    expect(clipOf(id).grade.wheels.lift).toEqual({ x: 0, y: 0, luma: 0 });
  });

  it('Mask: choosing a shape shows its controls; invert toggles', () => {
    sub('Mask');
    expect(screen.queryByRole('slider', { name: 'Feather' })).toBeNull();
    fireEvent.click(screen.getByTestId('mask-circle'));
    expect(clipOf(id).grade.mask.shape).toBe('circle');
    expect(screen.getByRole('slider', { name: 'Feather' })).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Invert' }));
    expect(clipOf(id).grade.mask.invert).toBe(true);
  });

  it('Curves: shows the editor with the two end points and resets', () => {
    sub('Curves');
    expect(screen.getAllByTestId('curve-point')).toHaveLength(2);
    act(() => st().updateClip(id, { grade: { curves: { ...defaultGrade().curves, master: [{ x: 0, y: 1 }, { x: 1, y: 0 }] } } }));
    expect(screen.getAllByTestId('curve-point')[0]!.getAttribute('data-y')).toBe('1.000');
    fireEvent.click(screen.getByTestId('curve-reset-channel'));
    expect(clipOf(id).grade.curves.master).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('Apply to all copies every adjustment to the other clips', () => {
    drag(screen.getByRole('slider', { name: 'Temp' }), '25');
    sub('HSL');
    drag(screen.getByRole('slider', { name: 'Hue' }), '50');
    fireEvent.click(screen.getByTestId('adjust-apply-all'));
    expect(clipOf(id2).adjust.temperature).toBe(25);
    expect(clipOf(id2).grade.hsl.bands.red.hue).toBe(50);
  });

  it('Save as preset stores it in localStorage and it applies from Library › Adjustment › My presets', () => {
    drag(screen.getByRole('slider', { name: 'Contrast' }), '20');
    fireEvent.click(screen.getByTestId('adjust-save-preset'));
    fireEvent.change(screen.getByTestId('preset-name'), { target: { value: 'Punchy' } });
    fireEvent.click(screen.getByTestId('preset-save'));
    const stored = JSON.parse(localStorage.getItem(PRESETS_KEY)!) as { name: string; adjust: { contrast: number } }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.name).toBe('Punchy');
    expect(stored[0]!.adjust.contrast).toBe(20);
    cleanup();
    act(() => st().select([id2]));
    render(<AdjustmentTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Punchy' }));
    expect(clipOf(id2).adjust.contrast).toBe(20);
  });
});
