/**
 * Export watchdog: an export must either finish, fail with a message, or be canceled — never sit
 * silently. (Seen once in the Speed-tab QA run: a 0.5× export stopped at video frame 125 / 300 with
 * no error and no download, under heavy load. Every await in the frame loop can block forever when
 * WebCodecs stops answering: a decoder that never outputs the next frame, an encoder whose queue
 * never drains, a seek that never fires `seeked`.)
 *
 * - `guard(promise, what)` rejects with ExportStalled when the promise has not settled within the
 *   stall timeout. The frame loop guards each frame (render + encode) and the finalize step.
 * - The video readers (frameSource.ts) additionally recover from a stalled decoder once by
 *   reopening it, before this watchdog gives up.
 */

/** No frame progress for this long = the export is stalled (fails with a visible error). */
export const EXPORT_STALL_MS = 20_000;
/** A single decoder read waiting this long is restarted once (frameSource.ts). */
export const DECODE_STALL_MS = 8_000;

export class ExportStalled extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportStalled';
  }
}

/** Rejects with `onTimeout()` when `p` has not settled after `ms`. The timer never outlives `p`. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export interface Watchdog {
  /** Guards one step of the export; `what` names it in the error ("frame 125 / 300"). */
  guard<T>(p: Promise<T>, what: string): Promise<T>;
}

/**
 * `detail()` adds what the export was waiting for when it stalled (e.g. the frame source's
 * current decode), so the message says where it hung.
 */
export function createWatchdog(timeoutMs: number = EXPORT_STALL_MS, detail?: () => string | null): Watchdog {
  return {
    guard: (p, what) =>
      withTimeout(p, timeoutMs, () => {
        const d = detail?.();
        return new ExportStalled(
          `Export stopped responding at ${what}: no progress for ${Math.round(timeoutMs / 1000)} s${d ? ` (${d})` : ''}. ` +
            'The browser’s video decoder or encoder stopped answering — close other heavy tabs and try again.',
        );
      }),
  };
}

/** Dev / e2e fault injection (window.__oeExportFault): make frame N hang, shorten the timeouts. */
export interface ExportFault {
  /** The render of this frame index never resolves. */
  hangAtFrame?: number;
  /** Overrides EXPORT_STALL_MS. */
  stallMs?: number;
}

export function exportFault(): ExportFault | null {
  if (!import.meta.env?.DEV || typeof window === 'undefined') return null;
  return ((window as unknown as { __oeExportFault?: ExportFault }).__oeExportFault ?? null) || null;
}
