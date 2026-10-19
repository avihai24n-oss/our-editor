// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsset } from '../model/defaults';
import { secToUs } from '../model/time';
import { Inspector } from '../inspector/Inspector';
import { cycleLibraryTab, LeftPanel, LIBRARY_TABS } from '../panels/LeftPanel';
import { useEditor } from '../store';
import { SHORTCUTS } from '../timeline/shortcutDefs';
import { emitAppEvent } from './appEvents';
import { ShortcutsPanel } from './ShortcutsPanel';
import { Toaster } from './Toaster';

afterEach(cleanup);

describe('ShortcutsPanel', () => {
  it('lists every row of the shared table in five groups, with Coming soon tags', () => {
    render(<ShortcutsPanel onClose={() => undefined} platform="mac" />);
    expect(screen.getAllByTestId('shortcuts-group')).toHaveLength(5);
    expect(screen.getAllByTestId('shortcuts-row')).toHaveLength(SHORTCUTS.length);
    const soon = SHORTCUTS.filter((d) => d.status === 'soon').length;
    expect(screen.getAllByText('Coming soon')).toHaveLength(soon);
    expect(screen.getByText('⇧⌘B')).toBeTruthy();
    expect(screen.getByText('⌥X')).toBeTruthy();
  });
  it('uses Ctrl / Shift / Alt words on Windows', () => {
    render(<ShortcutsPanel onClose={() => undefined} platform="win" />);
    expect(screen.getByText('Ctrl+Shift+B')).toBeTruthy();
    expect(screen.getByText('Alt+Shift+Z')).toBeTruthy();
    expect(screen.queryByText('⌘B')).toBeNull();
  });
  it('closes on Esc', () => {
    const onClose = vi.fn();
    render(<ShortcutsPanel onClose={onClose} platform="mac" />);
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('Toaster', () => {
  it('shows a toast message', () => {
    render(<Toaster />);
    act(() => void emitAppEvent('toast', { message: 'Coming soon: Group' }));
    expect(screen.getByTestId('toast').textContent).toBe('Coming soon: Group');
  });
});

describe('library tab cycling (Tab / Shift+Tab)', () => {
  it('wraps around both ways', () => {
    expect(cycleLibraryTab('media', 1)).toBe('audio');
    expect(cycleLibraryTab('media', -1)).toBe('templates');
    expect(cycleLibraryTab('templates', 1)).toBe('media');
  });
  it('the panel follows libraryTab events', () => {
    render(<LeftPanel />);
    const active = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!.textContent;
    const start = active();
    act(() => void emitAppEvent('libraryTab', { dir: 1 }));
    const i = LIBRARY_TABS.findIndex((t) => t.label === start);
    expect(active()).toBe(LIBRARY_TABS[(i + 1) % LIBRARY_TABS.length]!.label);
    act(() => void emitAppEvent('libraryTab', { dir: -1 }));
    expect(active()).toBe(start);
  });
});

describe('inspector Speed requests (⌘R / ⇧B)', () => {
  it('switches to Speed › Standard and Speed › Curve', () => {
    const s = useEditor.getState();
    s.newProject();
    const a = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: secToUs(4), width: 1080, height: 1920, hasAudio: true });
    s.addAssets([a]);
    act(() => void useEditor.getState().addClip(a.id, { at: 0 }));
    render(<Inspector />);
    act(() => void emitAppEvent('inspectorTab', { tab: 'speed', sub: 'standard' }));
    expect(screen.getByTestId('speed-row')).toBeTruthy();
    act(() => void emitAppEvent('inspectorTab', { tab: 'speed', sub: 'curve' }));
    expect(screen.getByTestId('speed-curve')).toBeTruthy();
    expect(screen.queryByTestId('speed-row')).toBeNull();
  });
});
