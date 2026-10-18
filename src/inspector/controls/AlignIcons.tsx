/** The six CapCut align icons (left, centre-h, right, top, centre-v, bottom). Line style like ui/icons. */
import type { AlignKind } from '../inspectorLogic';

const P: Record<AlignKind, string> = {
  left: 'M4 4v16 M7 8h10 M7 16h6',
  'center-h': 'M12 4v16 M6 8h12 M8 16h8',
  right: 'M20 4v16 M7 8h10 M11 16h6',
  top: 'M4 4h16 M8 7v10 M16 7v6',
  'center-v': 'M4 12h16 M8 6v12 M16 8v8',
  bottom: 'M4 20h16 M8 7v10 M16 11v6',
};

export function AlignIcon({ kind, size = 16 }: { kind: AlignKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={(1.5 * 24) / size} strokeLinecap="round" aria-hidden>
      <path d={P[kind]} />
    </svg>
  );
}

export const ALIGN_ITEMS: { kind: AlignKind; label: string }[] = [
  { kind: 'left', label: 'Align left' },
  { kind: 'center-h', label: 'Center horizontally' },
  { kind: 'right', label: 'Align right' },
  { kind: 'top', label: 'Align top' },
  { kind: 'center-v', label: 'Center vertically' },
  { kind: 'bottom', label: 'Align bottom' },
];
