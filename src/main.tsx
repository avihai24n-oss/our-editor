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
    // the clip menu's slot registry (src/timeline/contextMenu/registry.ts), for e2e checks
    void import('./timeline/contextMenu/registry').then((r) => (w.__oeMenu = r));
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
  void Promise.all([import('./player/PreviewEngine'), import('./engine/color'), import('./model/defaults'), import('./engine/frameState')]).then(([pe, color, defaults, frame]) => {
    (window as unknown as { __oeColor?: unknown }).__oeColor = () => pe.activePreviewEngine()?.colorPass ?? 'none';
    // colour lab for e2e: GPU vs CPU parity checks
    (window as unknown as { __oeColorLab?: unknown }).__oeColorLab = { color, defaults, frame };
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
