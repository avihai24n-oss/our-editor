/** Non-blocking toast at the bottom of the window (shortcut feedback, "Coming soon: …"). */
import { useEffect, useRef, useState } from 'react';
import { onAppEvent } from './appEvents';
import './shortcuts.css';

export function Toaster() {
  const [msg, setMsg] = useState<{ text: string; n: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const off = onAppEvent('toast', ({ message }) => {
      clearTimeout(timer.current);
      setMsg((m) => ({ text: message, n: (m?.n ?? 0) + 1 }));
      timer.current = setTimeout(() => setMsg(null), 2200);
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, []);
  if (!msg) return null;
  return (
    <div className="toast" role="status" aria-live="polite" data-testid="toast" key={msg.n}>
      {msg.text}
    </div>
  );
}
