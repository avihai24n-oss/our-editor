/**
 * Per-browser UI preferences for the Library / Inspector (active tab, grid/list, sort,
 * collapsed sections). localStorage may be unavailable — every access is guarded and the
 * default is used.
 */
import { useCallback, useState } from 'react';

const PREFIX = 'our-editor:ui:';

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as unknown;
    return typeof v === typeof fallback ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** A remembered UI value. Changing `key` re-reads the stored value for the new key. */
export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: readPref(key, fallback) }));
  const value = state.key === key ? state.value : readPref(key, fallback);
  const set = useCallback(
    (v: T) => {
      setState({ key, value: v });
      writePref(key, v);
    },
    [key],
  );
  return [value, set];
}
