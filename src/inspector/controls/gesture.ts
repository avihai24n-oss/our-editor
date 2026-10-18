/**
 * Undo grouping for inspector gestures (SPEC: every slider gesture = one undo step).
 *
 *  - startPointerGesture(): call on pointer-down of a slider / dial. Opens a store transaction
 *    and closes it on the next pointer-up (commit) or Escape (cancel), wherever they happen.
 *  - beginSession() / endSession(): for edits without a pointer (typing in a textarea, a
 *    native colour picker). Call begin on focus / first input and end on blur / change.
 */
import { useEditor } from '../../store';

let pointerOpen = false;
let sessionOpen = false;

export function startPointerGesture(): void {
  if (pointerOpen || sessionOpen) return;
  pointerOpen = true;
  useEditor.getState().beginTx();
  const finish = (cancel: boolean) => {
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    pointerOpen = false;
    const s = useEditor.getState();
    if (cancel) s.cancelTx();
    else s.commitTx();
  };
  const onUp = () => finish(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(true);
    }
  };
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('keydown', onKey, true);
}

export function beginSession(): void {
  if (sessionOpen || pointerOpen) return;
  sessionOpen = true;
  useEditor.getState().beginTx();
}

export function endSession(): void {
  if (!sessionOpen) return;
  sessionOpen = false;
  useEditor.getState().commitTx();
}

/** Test helper. */
export const gestureState = () => ({ pointerOpen, sessionOpen });
