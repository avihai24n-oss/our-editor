/**
 * Tiny synchronous event bus between the keyboard shortcuts and the components that own the UI
 * they open (export dialog, file picker, full-screen player, inspector tab, library tab, toast).
 *
 * Synchronous on purpose: a listener runs inside the keydown handler, so APIs that need a user
 * gesture (requestFullscreen, <input type=file>.click()) still work.
 */

export type InspectorRequest = { tab: 'speed'; sub?: 'standard' | 'curve' };

export interface AppEvents {
  toast: { message: string };
  export: undefined;
  import: undefined;
  fullscreenPreview: undefined;
  fitPreview: undefined;
  inspectorTab: InspectorRequest;
  libraryTab: { dir: 1 | -1 };
  /** Show one library tab (an OS file drop outside the timeline shows the Media pool). */
  libraryShow: { tab: 'media' };
  /** Asset tiles to highlight briefly (just imported by a drop). */
  assetHighlight: { ids: string[] };
}

type Listener<K extends keyof AppEvents> = (payload: AppEvents[K]) => void;

const listeners = new Map<keyof AppEvents, Set<Listener<never>>>();

export function onAppEvent<K extends keyof AppEvents>(type: K, fn: Listener<K>): () => void {
  let set = listeners.get(type);
  if (!set) listeners.set(type, (set = new Set()));
  set.add(fn as Listener<never>);
  return () => void set!.delete(fn as Listener<never>);
}

/** Dispatches to every listener; returns how many there were. */
export function emitAppEvent<K extends keyof AppEvents>(type: K, ...payload: AppEvents[K] extends undefined ? [] : [AppEvents[K]]): number {
  const set = listeners.get(type);
  if (!set) return 0;
  for (const fn of [...set]) (fn as Listener<K>)(payload[0] as AppEvents[K]);
  return set.size;
}

export const showToast = (message: string): void => void emitAppEvent('toast', { message });

/**
 * ⌘I asks for the import picker. When the Media tab is not mounted yet, the library switches to
 * it and the freshly mounted Media tab opens the picker by consuming this flag.
 */
let importPending = false;
export function requestImport(): void {
  importPending = true;
  emitAppEvent('import');
}
export function consumeImportRequest(): boolean {
  const v = importPending;
  importPending = false;
  return v;
}

/**
 * New tiles to highlight. Kept until the Media tab consumes it, because the tab may only mount
 * after the drop switched the library to it.
 */
let highlightPending: string[] = [];
export function requestAssetHighlight(ids: string[]): void {
  highlightPending = ids;
  emitAppEvent('assetHighlight', { ids });
}
export function consumeAssetHighlight(): string[] {
  const v = highlightPending;
  highlightPending = [];
  return v;
}
