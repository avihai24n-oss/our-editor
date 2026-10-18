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
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
