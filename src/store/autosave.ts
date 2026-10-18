/**
 * Autosave + boot. `startAutosave()` saves the project 800 ms after the last change and on
 * page hide. `bootProject()` loads the last project (and its media URLs) or keeps a new one.
 */
import { restoreAssetUrls } from '../media/import';
import { useEditor } from './index';
import { loadLastProject, saveProject } from './persistence';

const DEBOUNCE_MS = 800;

export async function saveNow(): Promise<void> {
  const { project, setSaveStatus } = useEditor.getState();
  setSaveStatus({ saving: true });
  try {
    await saveProject(project);
    setSaveStatus({ saving: false, lastSavedAt: Date.now(), error: null });
  } catch (e) {
    setSaveStatus({ saving: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      void saveNow();
    }
  };
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void saveNow();
    }, DEBOUNCE_MS);
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHide);
  }
  return () => {
    unsub();
    flush();
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onHide);
    }
  };
}

let booting: Promise<boolean> | null = null;

/**
 * Loads the last saved project into the store. Returns true when one was found.
 * Single-flight: React StrictMode runs the boot effect twice in dev, and a second boot would
 * re-register every asset URL and revoke the first ones while media elements still load them.
 */
export function bootProject(): Promise<boolean> {
  booting ??= doBoot();
  return booting;
}

async function doBoot(): Promise<boolean> {
  try {
    const p = await loadLastProject();
    if (!p) return false;
    useEditor.getState().setProject(p);
    const missing = await restoreAssetUrls(p);
    useEditor.getState().setAssetsMissing(missing);
    useEditor.getState().setSaveStatus({ lastSavedAt: p.updatedAt });
    return true;
  } catch (e) {
    console.warn('Could not load the last project', e);
    return false;
  }
}
