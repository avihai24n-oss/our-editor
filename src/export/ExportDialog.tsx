/**
 * Export dialog. PLACEHOLDER from the skeleton; Builder C implements MP4 export
 * (WebCodecs + Mediabunny, rendering every frame from engine/getFrameState).
 * Final interface: { open, onClose } — App mounts it when the top-bar Export button is pressed.
 */
import { useEditor } from '../store';
import { Modal } from '../ui/controls';

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const name = useEditor((s) => s.project.name);
  const settings = useEditor((s) => s.project.settings);
  if (!open) return null;
  return (
    <Modal
      title="Export"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled>
            Export
          </button>
        </>
      }
    >
      <p>
        {name} — {settings.width}×{settings.height}, {settings.fps} fps, MP4
      </p>
      <p style={{ color: 'var(--text-dim)' }}>Export is not implemented yet.</p>
    </Modal>
  );
}
