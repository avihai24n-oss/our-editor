import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installAssetCleanup } from './media/cleanup';
import './theme.css';

installAssetCleanup();

// Dev-only handle for e2e checks and debugging (stripped from production builds).
if (import.meta.env.DEV) {
  void import('./store').then(({ useEditor }) => {
    (window as unknown as { __oe?: typeof useEditor }).__oe = useEditor;
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
