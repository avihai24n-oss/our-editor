import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installAssetCleanup } from './media/cleanup';
import './theme.css';
// clip right-click menu slots (registered on import)

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
  void Promise.all([import('./timeline/contextMenu/registry'), import('./audio/noiseProfile')]).then(([registry, np]) => {
    // e2e: the clip menu's slot registry (src/timeline/contextMenu/registry.ts) — register or run a
    // slot without the menu UI — plus the cached noise profiles of Isolate voice
    (window as unknown as { __oeMenu?: unknown }).__oeMenu = {
      ...registry,
      getSlot: (name: keyof typeof registry.slots) => registry.slots[name] ?? undefined,
      noiseProfileReady: np.noiseProfileReady,
    };
  });
  void import('./player/sourcePreview').then((sp) => {
    (window as unknown as { __oeSource?: unknown }).__oeSource = { getState: sp.useSourcePreview.getState, elements: sp.sourcePreviewElements };
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
