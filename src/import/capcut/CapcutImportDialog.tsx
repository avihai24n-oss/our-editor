/**
 * "Import CapCut project…" (top bar) and `/?importCapcut=<draft folder>`: confirm when the open
 * project has clips, show progress while the media loads, then the import report.
 */
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../../store';
import { formatReport, reportSummary } from './convert';
import { importCapcutProject, projectHasContent, type CapcutImportOutcome, type CapcutImportProgress } from './runImport';
import './capcut.css';

export const DEFAULT_CAPCUT_DRAFT = '1018';

type Phase = { kind: 'confirm' } | { kind: 'running'; progress: CapcutImportProgress | null } | { kind: 'done'; outcome: CapcutImportOutcome } | { kind: 'error'; message: string };

export function CapcutImportDialog({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>(() => (projectHasContent(useEditor.getState().project) ? { kind: 'confirm' } : { kind: 'running', progress: null }));
  const started = useRef(false);

  useEffect(() => {
    if (phase.kind !== 'running' || started.current) return;
    started.current = true;
    importCapcutProject(draftId, (p) => setPhase({ kind: 'running', progress: p }))
      .then((outcome) => setPhase({ kind: 'done', outcome }))
      .catch((e: unknown) => setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
  }, [phase.kind, draftId]);

  const running = phase.kind === 'running';
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal capcut-import" role="dialog" aria-modal="true" aria-label="Import CapCut project" data-testid="capcut-import-dialog" data-phase={phase.kind}>
        <div className="modal__head">Import CapCut project “{draftId}”</div>
        <div className="capcut-import__body">
          {phase.kind === 'confirm' && (
            <p data-testid="capcut-confirm-replace">
              The open project has clips. Importing replaces it in the editor (it stays saved in this browser, but there is no project switcher yet). Continue?
            </p>
          )}
          {phase.kind === 'running' && (
            <div data-testid="capcut-import-progress">
              <p>{phase.progress ? `Loading media ${phase.progress.done} / ${phase.progress.total}${phase.progress.file ? ` — ${phase.progress.file}` : ''}` : 'Reading the CapCut draft…'}</p>
              <div className="capcut-import__bar">
                <div style={{ width: `${phase.progress && phase.progress.total ? (100 * phase.progress.done) / phase.progress.total : 0}%` }} />
              </div>
            </div>
          )}
          {phase.kind === 'error' && <p className="capcut-import__error" data-testid="capcut-import-error">{phase.message}</p>}
          {phase.kind === 'done' && (
            <div data-testid="capcut-import-report">
              <p className="capcut-import__summary">{reportSummary(phase.outcome.report)}</p>
              {phase.outcome.violations.length > 0 && <p className="capcut-import__error">Model check: {phase.outcome.violations.join('; ')}</p>}
              <pre className="capcut-import__report">{formatReport(phase.outcome.report).slice(1).join('\n')}</pre>
            </div>
          )}
        </div>
        <div className="modal__foot capcut-import__foot">
          {phase.kind === 'confirm' && (
            <>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn--primary" data-testid="capcut-confirm" onClick={() => setPhase({ kind: 'running', progress: null })}>
                Replace and import
              </button>
            </>
          )}
          {(phase.kind === 'done' || phase.kind === 'error') && (
            <button className="btn btn--primary" data-testid="capcut-import-close" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
