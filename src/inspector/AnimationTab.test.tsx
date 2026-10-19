// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import { secToUs } from '../model/time';
import type { TextClip, VideoClip } from '../model/types';
import { useEditor } from '../store';
import { Inspector } from './Inspector';
import { stopAnimationPreview } from './tabs/animPreview';

const st = () => useEditor.getState();
const S = secToUs;
const video = () => createAsset({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 1, duration: S(4), width: 1920, height: 1080, hasAudio: false });

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  act(() => st().newProject());
});
afterEach(() => {
  stopAnimationPreview();
  cleanup();
});

function videoClip(): string {
  const a = video();
  let id = '';
  act(() => {
    st().addAssets([a]);
    id = st().addClip(a.id, { at: 0 })!;
    st().select([id]);
  });
  return id;
}
const clip = (id: string) => findClip(st().project, id)!.clip as VideoClip;
const tile = (id: string) => screen.getAllByTestId('anim-tile').find((t) => t.getAttribute('data-anim-id') === id)!;
const openAnimation = () => fireEvent.click(screen.getByRole('tab', { name: 'Animation' }));

describe('Animation tab', () => {
  it('video: In | Out | Combo, CapCut chips, None first', () => {
    videoClip();
    render(<Inspector />);
    openAnimation();
    for (const name of ['In', 'Out', 'Combo']) expect(screen.getByRole('tab', { name })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Loop' })).toBeNull();
    for (const name of ['Favourites', 'Trending', 'Basic', 'Light', 'Glitch', 'Mask', '3D', 'Vibration']) expect(screen.getByRole('tab', { name })).toBeTruthy();
    expect(screen.getAllByTestId('anim-tile')[0]!.getAttribute('data-anim-id')).toBe('none');
  });

  it('clicking a tile applies it (In), previews it, None removes it; both undoable', () => {
    const id = videoClip();
    render(<Inspector />);
    openAnimation();
    fireEvent.click(screen.getByRole('tab', { name: 'Basic' }));
    fireEvent.click(within(tile('fade')).getByRole('button', { name: 'Fade In' }));
    expect(clip(id).animationIn).toEqual({ type: 'fade', duration: S(0.5) });
    expect(st().playing).toBe(true); // previewing once in the player
    expect(tile('fade').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('anim-applied').textContent).toContain('Fade In');
    // sub-tab shows a dot when applied
    expect(screen.getByRole('tab', { name: /^In/ }).querySelector('.seg__dot')).toBeTruthy();
    fireEvent.click(within(tile('none')).getByRole('button', { name: 'None' }));
    expect(clip(id).animationIn).toBeNull();
    act(() => st().undo());
    expect(clip(id).animationIn?.type).toBe('fade');
  });

  it('duration slider is clamped to the clip and pushes the other slot', () => {
    const id = videoClip();
    act(() => {
      st().setAnimation(id, 'in', 'fade');
      st().setAnimation(id, 'out', 'fade', S(1));
    });
    render(<Inspector />);
    openAnimation();
    fireEvent.click(screen.getByRole('tab', { name: /^In/ }));
    const slider = within(screen.getByTestId('animation-duration')).getByRole('slider');
    expect(slider.getAttribute('max')).toBe('4');
    act(() => {
      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: '3.5' } });
      fireEvent.pointerUp(window);
    });
    expect(clip(id).animationIn!.duration).toBe(S(3.5));
    expect(clip(id).animationOut!.duration).toBe(S(0.5));
  });

  it('Combo replaces In/Out', () => {
    const id = videoClip();
    act(() => st().setAnimation(id, 'in', 'fade'));
    render(<Inspector />);
    openAnimation();
    fireEvent.click(screen.getByRole('tab', { name: 'Combo' }));
    fireEvent.click(within(tile('zoom-in-out')).getByRole('button', { name: 'Zoom In & Out' }));
    expect(clip(id).animationCombo).toEqual({ type: 'zoom-in-out', duration: S(4) });
    expect(clip(id).animationIn).toBeNull();
  });

  it('search filters across categories', () => {
    videoClip();
    render(<Inspector />);
    openAnimation();
    fireEvent.change(screen.getByTestId('anim-search'), { target: { value: 'wipe' } });
    const ids = screen.getAllByTestId('anim-tile').map((t) => t.getAttribute('data-anim-id'));
    expect(ids).toEqual(['none', 'wipe-right', 'wipe-left', 'wipe-down', 'wipe-up', 'diagonal']);
    fireEvent.change(screen.getByTestId('anim-search'), { target: { value: 'zzz' } });
    expect(screen.getByText('No animations match.')).toBeTruthy();
  });

  it('favourites persist in localStorage', () => {
    videoClip();
    const { unmount } = render(<Inspector />);
    openAnimation();
    fireEvent.click(screen.getByRole('tab', { name: 'Glitch' }));
    fireEvent.click(within(tile('rgb-split')).getByTestId('anim-fav'));
    expect(JSON.parse(localStorage.getItem('our-editor:ui:animation-favorites')!)).toEqual(['in:rgb-split']);
    unmount();
    render(<Inspector />);
    openAnimation();
    fireEvent.click(screen.getByRole('tab', { name: 'Favourites' }));
    const ids = screen.getAllByTestId('anim-tile').map((t) => t.getAttribute('data-anim-id'));
    expect(ids).toEqual(['none', 'rgb-split']);
  });

  it('text: In | Out | Loop with text-only animations; Loop has a Speed slider', () => {
    let t = '';
    act(() => {
      t = st().addTextClip({ at: 0, content: 'Hi' });
      st().select([t]);
    });
    render(<Inspector />);
    openAnimation();
    expect(screen.getByRole('tab', { name: 'Loop' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Combo' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Trending' }));
    expect(tile('typewriter')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Loop' }));
    fireEvent.click(within(tile('pulse')).getByRole('button', { name: 'Pulse' }));
    expect((findClip(st().project, t)!.clip as TextClip).animationLoop).toEqual({ type: 'pulse', duration: S(1) });
    expect(within(screen.getByTestId('animation-duration')).getByText('Speed')).toBeTruthy();
  });
});
