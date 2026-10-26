/**
 * Which screen the app shows: the editor or the home screen (project gallery).
 *
 * The app always opens in the editor, on the project the user left (a first visit opens an empty
 * one), and the home screen is a click away on the top bar — a refresh must never cost you your
 * place. `busy` is set while a project is loading, saving or being created, which disables both
 * screens' navigation. Every transition saves the project being left (src/store/projects.ts), so
 * leaving for the gallery is exactly as safe as refreshing the tab.
 */
import { create } from 'zustand';
import type { AspectRatio, Id } from '../model/types';
import { createAndOpenProject, openProject, saveAndFlush } from '../store/projects';

export type Route = 'home' | 'editor';

interface RouteState {
  route: Route;
  /** A project is being saved, loaded or created: the screen shows a spinner and ignores clicks. */
  busy: boolean;
  show: (route: Route) => void;
  setBusy: (busy: boolean) => void;
  /** Saves the open project, then shows the gallery. */
  goHome: () => Promise<void>;
  /** Opens a stored project in the editor. False = it is gone. */
  open: (id: Id) => Promise<boolean>;
  create: (opts?: { name?: string; aspect?: AspectRatio }) => Promise<Id>;
}

export const useAppRoute = create<RouteState>()((set, get) => ({
  route: 'editor',
  /** true until the boot load finishes (src/App.tsx) */
  busy: true,
  show: (route) => set({ route }),
  setBusy: (busy) => set({ busy }),
  goHome: async () => {
    if (get().route !== 'editor' || get().busy) return;
    set({ busy: true });
    try {
      await saveAndFlush();
      set({ route: 'home' });
    } finally {
      set({ busy: false });
    }
  },
  open: async (id) => {
    if (get().busy) return false;
    set({ busy: true });
    try {
      const ok = await openProject(id);
      if (ok) set({ route: 'editor' });
      return ok;
    } finally {
      set({ busy: false });
    }
  },
  create: async (opts) => {
    set({ busy: true });
    try {
      const id = await createAndOpenProject(opts ?? {});
      set({ route: 'editor' });
      return id;
    } finally {
      set({ busy: false });
    }
  },
}));
