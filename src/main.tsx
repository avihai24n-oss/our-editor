import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installAssetCleanup } from './media/cleanup';
import './theme.css';

installAssetCleanup();

// Dev-only handle for e2e checks and debugging (stripped from production builds).
if (import.meta.env.DEV) {
  void Promise.all([import('./store'), import('./store/invariants'), import('./timeline/uiStore')]).then(([{ useEditor }, { projectViolations }, { useTimelineUi }]) => {
    const w = window as unknown as Record<string, unknown>;
    w.__oe = useEditor;
    w.__oeUi = useTimelineUi;
    // model invariants of the current document (empty = healthy), for the e2e audit
    w.__oeCheck = () => {
      const s = useEditor.getState();
      return projectViolations(s.project, { magnet: s.magnet, selection: s.selection.clipIds });
    };
  });
  void Promise.all([import('./player/PreviewEngine'), import('./audio/measure')]).then(([pe, measure]) => {
    (window as unknown as { __oeAudio?: unknown }).__oeAudio = {
      voices: () => pe.activePreviewEngine()?.audioDebug() ?? [],
      measureSpan: measure.measureSpan,
      loudnessReady: measure.loudnessReady,
      spanKey: measure.spanKey,
    };
  });
  void Promise.all([import('./ui/MemoryReadout'), import('./media/memory')]).then(([readout, memory]) => {
    (window as unknown as { __oeMem?: unknown }).__oeMem = { snapshot: readout.memorySnapshot, flush: memory.flushAllCaches };
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
