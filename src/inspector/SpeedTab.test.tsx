// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import { curveMean, presetCurve } from '../model/speedCurve';
import { secToUs } from '../model/time';
import type { VideoClip } from '../model/types';
import { useEditor } from '../store';
import { Inspector } from './Inspector';
import { addPoint, movePoint, removePoint } from './tabs/SpeedTab';

const st = () => useEditor.getState();
const S = secToUs;

let id = '';
const clip = () => findClip(st().project, id)!.clip as VideoClip;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  // jsdom has no ResizeObserver
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  act(() => {
    st().newProject();
    const a = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(5), width: 1080, height: 1920, hasAudio: true });
    st().addAssets([a]);
    id = st().addClip(a.id, { at: 0 })!;
    st().select([id]);
  });
  render(<Inspector />);
  fireEvent.click(screen.getByRole('tab', { name: 'Speed' }));
});
afterEach(cleanup);

describe('Speed tab', () => {
  it('has Standard, Curve and a disabled Velocity effects sub-tab, and the disabled Smooth slow-mo row', () => {
    expect(screen.getByRole('tab', { name: 'Standard' })).toBeTruthy();
    expect((screen.getByRole('tab', { name: 'Velocity effects' }) as HTMLButtonElement).disabled).toBe(true);
    const slow = screen.getByTestId('smooth-slowmo');
    expect(slow.textContent).toContain('Only slow-speed videos are supported.');
    expect((slow.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });

  it('Standard Reset restores 1x and the original pitch in one step', () => {
    act(() => {
      st().setSpeed(id, 2);
      st().updateClip(id, { preservePitch: false });
    });
    const before = st().past.length;
    fireEvent.click(screen.getByTestId('speed-reset'));
    expect(clip()).toMatchObject({ speed: 1, preservePitch: true, duration: S(5) });
    expect(st().past.length).toBe(before + 1);
    expect((screen.getByTestId('speed-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Curve: the eight tiles, picking a preset applies it and shows the editor with the new duration', () => {
    fireEvent.click(screen.getByRole('tab', { name: 'Curve' }));
    const tiles = screen.getAllByRole('option').map((b) => b.textContent);
    expect(tiles).toEqual(['None', 'Custom', 'Montage', 'Hero', 'Bullet', 'Jump cut', 'Flash in', 'Flash out']);
    expect(screen.queryByTestId('curve-editor')).toBeNull();
    fireEvent.click(screen.getByTestId('curve-preset-bullet'));
    expect(clip().speedCurve?.preset).toBe('bullet');
    expect(screen.getByTestId('curve-editor')).toBeTruthy();
    const d = Math.round(S(5) / curveMean(presetCurve('bullet')));
    expect(screen.getByTestId('curve-duration').textContent).toBe(`${(d / 1e6).toFixed(1)}s`);
    expect(screen.getByTestId('curve-duration-from').textContent).toBe('5.0s');
    expect(screen.getAllByTestId('curve-point')).toHaveLength(presetCurve('bullet').points.length);
    // the clip's timeline badge source of truth
    expect(clip().duration).toBe(d);
  });

  it('None removes the curve and keeps the Curve panel open', () => {
    fireEvent.click(screen.getByRole('tab', { name: 'Curve' }));
    fireEvent.click(screen.getByTestId('curve-preset-hero'));
    fireEvent.click(screen.getByTestId('curve-preset-none'));
    expect(clip().speedCurve).toBeNull();
    expect(clip().duration).toBe(S(5));
    expect(screen.getByTestId('speed-curve')).toBeTruthy();
    st().undo();
    expect(clip().speedCurve?.preset).toBe('hero');
  });

  it('opens on Curve for a clip that has a curve; Standard warns that a speed replaces it', () => {
    act(() => st().setSpeedCurve(id, presetCurve('montage')));
    cleanup();
    render(<Inspector />);
    fireEvent.click(screen.getByRole('tab', { name: 'Speed' }));
    expect(screen.getByTestId('curve-editor')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Standard' }));
    expect(screen.getByTestId('speed-curve-active')).toBeTruthy();
  });

  it('curve Reset restores the preset points; + adds at the playhead, − deletes the selected point', () => {
    fireEvent.click(screen.getByRole('tab', { name: 'Curve' }));
    fireEvent.click(screen.getByTestId('curve-preset-custom'));
    expect((screen.getByTestId('curve-reset') as HTMLButtonElement).disabled).toBe(true);
    act(() => st().setSpeedCurve(id, movePoint(clip().speedCurve!, 2, 0.5, 4)));
    expect((screen.getByTestId('curve-reset') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('curve-reset'));
    expect(clip().speedCurve!.points.every((p) => p.v === 1)).toBe(true);
    // playhead at 40 % of the clip → "+" adds a point there
    act(() => st().setPlayhead(Math.round(clip().duration * 0.4)));
    fireEvent.click(screen.getByTestId('curve-add-remove'));
    expect(clip().speedCurve!.points).toHaveLength(6);
    expect(clip().speedCurve!.points[2]!.x).toBeCloseTo(0.4, 3);
    // select it and delete it
    fireEvent.pointerDown(screen.getAllByTestId('curve-point')[2]!, { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId('curve-point')[2]!, { pointerId: 1 });
    expect(screen.getByTestId('curve-add-remove').textContent).toBe('−');
    fireEvent.click(screen.getByTestId('curve-add-remove'));
    expect(clip().speedCurve!.points).toHaveLength(5);
  });
});

describe('curve point helpers', () => {
  it('movePoint keeps x between neighbours, end points vertical only, speed clamped', () => {
    const c = presetCurve('custom');
    expect(movePoint(c, 2, 0.9, 50).points[2]).toEqual({ x: 0.73, v: 10 });
    expect(movePoint(c, 0, 0.5, 0.01).points[0]).toEqual({ x: 0, v: 0.1 });
    expect(movePoint(c, 4, 0.2, 3).points[4]).toEqual({ x: 1, v: 3 });
  });
  it('addPoint inserts on the curve; refuses near another point or the ends', () => {
    const c = presetCurve('flash-in');
    const n = addPoint(c, 0.5)!;
    expect(n.points.map((p) => p.x)).toEqual([0, 0.31, 0.5, 0.66, 1]);
    expect(addPoint(c, 0.32)).toBeNull();
    expect(addPoint(c, 0.005)).toBeNull();
  });
  it('removePoint never removes the end points', () => {
    const c = presetCurve('custom');
    expect(removePoint(c, 0)).toBeNull();
    expect(removePoint(c, 4)).toBeNull();
    expect(removePoint(c, 1)!.points).toHaveLength(4);
  });
});
