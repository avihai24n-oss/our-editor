/** Shared helpers of the Adjust › Color sections. */
import type { ColorPage } from '../../../model/colorPage';
import type { VisualClip } from '../../../model/types';
import { useEditor } from '../../../store';

/** Replaces part of the clip's Color page (one undo step per call / per slider drag). */
export function useSetColorPage(clip: VisualClip): (patch: Partial<ColorPage>) => void {
  const updateClip = useEditor((s) => s.updateClip);
  return (patch) => updateClip(clip.id, { grade: { color: { ...clip.grade.color, ...patch } } });
}

export const round = (v: number, digits = 0) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
