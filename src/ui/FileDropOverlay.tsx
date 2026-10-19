/**
 * Window-wide OS file drop (CapCut): while files from Finder / the desktop are dragged over the
 * app, the window dims with "Drop files to import". Dropping anywhere imports them into the Media
 * pool; dropping on the timeline keeps its own behaviour (import + place at the drop point).
 *
 * Listeners sit on `window` in the CAPTURE phase, so every file dragover / drop is
 * preventDefault-ed before anything else sees it: the browser never navigates to the file or opens
 * it in a tab, wherever it lands (inputs, the player canvas, the top bar…). Internal drags (asset
 * tiles, presets) are ignored — see isOsFileDrag.
 *
 * The overlay is pointer-events: none, so the timeline under it still gets dragover (drop guide)
 * and drop. Flicker-free: a dragenter / dragleave depth counter, a relatedTarget === null check
 * for leaving the window, and a watchdog that hides the overlay when dragover stops arriving
 * (Esc, or a drag that ends outside the window).
 */
import { useEffect, useRef, useState } from 'react';
import { isOsFileDrag } from '../media/dropFiles';
import { importToMediaPool } from '../media/dropImport';
import { Icon } from './Icon';
import './primitives.css';

const STALE_MS = 450;

export function FileDropOverlay() {
  const [state, setState] = useState<'off' | 'app' | 'timeline'>('off');
  const depth = useRef(0);
  const stale = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const hide = () => {
      depth.current = 0;
      clearTimeout(stale.current);
      setState('off');
    };
    const zoneOf = (t: EventTarget | null): 'app' | 'timeline' =>
      t instanceof Element && t.closest('[data-drop-zone="timeline"]') ? 'timeline' : 'app';
    const arm = () => {
      clearTimeout(stale.current);
      stale.current = setTimeout(hide, STALE_MS);
    };

    const onEnter = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer?.types)) return;
      e.preventDefault();
      depth.current++;
      setState(zoneOf(e.target));
      arm();
    };
    const onOver = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer?.types)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const z = zoneOf(e.target);
      setState((s) => (s === z ? s : z));
      arm();
    };
    const onLeave = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer?.types)) return;
      depth.current = Math.max(0, depth.current - 1);
      // relatedTarget is null only when the pointer leaves the window
      if (depth.current === 0 || e.relatedTarget === null) hide();
    };
    const onDrop = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer?.types)) return;
      e.preventDefault(); // never navigate to the file
      const onTimeline = zoneOf(e.target) === 'timeline';
      hide();
      if (onTimeline) return; // the timeline's own drop imports and places the files
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void importToMediaPool(files);
    };

    window.addEventListener('dragenter', onEnter, true);
    window.addEventListener('dragover', onOver, true);
    window.addEventListener('dragleave', onLeave, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragenter', onEnter, true);
      window.removeEventListener('dragover', onOver, true);
      window.removeEventListener('dragleave', onLeave, true);
      window.removeEventListener('drop', onDrop, true);
      clearTimeout(stale.current);
    };
  }, []);

  if (state === 'off') return null;
  return (
    <div className={`file-drop${state === 'timeline' ? ' is-timeline' : ''}`} data-testid="file-drop-overlay" data-zone={state} aria-hidden>
      <div className="file-drop__card">
        <Icon name="import" size={32} />
        <div className="file-drop__title">{state === 'timeline' ? 'Drop to add to the timeline' : 'Drop files to import'}</div>
        <div className="file-drop__note">
          {state === 'timeline' ? 'The files are imported and placed at the drop point' : 'Videos, audio and images go to the Media library'}
        </div>
      </div>
    </div>
  );
}
