// @vitest-environment jsdom
/** Home screen: the gallery lists what is stored, and its commands reach IndexedDB. */
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../model/defaults';
import { resetAutosaveState } from '../store/autosave';
import { useEditor } from '../store';
import { loadProject, projectSummaries, saveProject, setLastProjectId } from '../store/persistence';
import { resetViewState } from '../store/viewState';
import { HomeScreen, relativeTime } from './HomeScreen';
import { useAppRoute } from './route';

const cards = () => screen.queryAllByTestId('project-card');
const cardNamed = (name: string) => cards().find((c) => c.getAttribute('data-project-name') === name)!;

async function wipe() {
  for (const p of await projectSummaries()) {
    const { deleteProject } = await import('../store/persistence');
    await deleteProject(p.id);
  }
  await setLastProjectId(null);
}

beforeEach(async () => {
  localStorage.clear();
  await wipe();
  act(() => {
    useEditor.getState().newProject({ name: 'In the editor' });
    useAppRoute.setState({ route: 'home', busy: false });
  });
  resetAutosaveState();
  resetViewState();
});
afterEach(cleanup);

describe('HomeScreen', () => {
  it('invites you to make the first project when there is none', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText('No projects yet.')).toBeTruthy());
    expect(cards()).toHaveLength(0);
    expect(screen.getAllByTestId('home-new-project')).toHaveLength(1);
  });

  it('creates a project and goes to the editor', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText('No projects yet.')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('home-new-project'));
    });
    await waitFor(() => expect(useAppRoute.getState().route).toBe('editor'));
    const stored = await projectSummaries();
    expect(stored).toHaveLength(1);
    expect(useEditor.getState().project.id).toBe(stored[0]!.id);
  });

  it('lists stored projects newest first, with their ratio and clip count', async () => {
    const old = { ...createProject({ name: 'Older', aspect: '16:9' }), updatedAt: Date.now() - 60 * 60_000 };
    const recent = createProject({ name: 'Newer' });
    await saveProject(old);
    await saveProject(recent);
    render(<HomeScreen />);
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards().map((c) => c.getAttribute('data-project-name'))).toEqual(['Newer', 'Older']);
    expect(within(cardNamed('Older')).getByText('16:9')).toBeTruthy();
    expect(within(cardNamed('Older')).getByText('0 clips')).toBeTruthy();
    expect(within(cardNamed('Older')).getByText('1 h ago')).toBeTruthy();
  });

  it('opens the project you click', async () => {
    const p = createProject({ name: 'Click me' });
    await saveProject(p);
    render(<HomeScreen />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    await act(async () => {
      fireEvent.click(within(cardNamed('Click me')).getByTestId('project-open'));
    });
    await waitFor(() => expect(useAppRoute.getState().route).toBe('editor'));
    expect(useEditor.getState().project.id).toBe(p.id);
  });

  it('renames a project in place', async () => {
    const p = createProject({ name: 'Before' });
    await saveProject(p);
    render(<HomeScreen />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    fireEvent.click(within(cardNamed('Before')).getByTestId('project-name'));
    const input = screen.getByTestId('project-rename-input');
    fireEvent.change(input, { target: { value: 'After' } });
    await act(async () => {
      fireEvent.blur(input);
    });
    await waitFor(() => expect(cardNamed('After')).toBeTruthy());
    expect((await loadProject(p.id))?.name).toBe('After');
  });

  it('duplicates a project from the ⋯ menu', async () => {
    await saveProject(createProject({ name: 'Original' }));
    render(<HomeScreen />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    fireEvent.click(within(cardNamed('Original')).getByTestId('project-menu'));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }));
    });
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cardNamed('Original copy')).toBeTruthy();
  });

  it('deletes a project only after the confirmation', async () => {
    const p = createProject({ name: 'Doomed' });
    await saveProject(p);
    render(<HomeScreen />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    fireEvent.click(within(cardNamed('Doomed')).getByTestId('project-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(screen.getByRole('dialog', { name: 'Delete project' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-delete'));
    });
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(await loadProject(p.id)).toBeNull();
  });

  it('filters by name once there are enough projects to search', async () => {
    for (const n of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) await saveProject(createProject({ name: n }));
    render(<HomeScreen />);
    await waitFor(() => expect(cards()).toHaveLength(7));
    fireEvent.change(screen.getByTestId('home-search'), { target: { value: 'thr' } });
    expect(cards().map((c) => c.getAttribute('data-project-name'))).toEqual(['three']);
    fireEvent.change(screen.getByTestId('home-search'), { target: { value: 'zzz' } });
    expect(screen.getByText('No project matches that name.')).toBeTruthy();
  });
});

describe('relativeTime', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  it('reads like a person would say it', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now');
    expect(relativeTime(now - 60_000, now)).toBe('a minute ago');
    expect(relativeTime(now - 14 * 60_000, now)).toBe('14 min ago');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 26 * 3600_000, now)).toBe('yesterday');
    expect(relativeTime(now - 3 * 24 * 3600_000, now)).toBe('3 days ago');
    expect(relativeTime(now - 40 * 24 * 3600_000, now)).toMatch(/Sep/);
  });
});
