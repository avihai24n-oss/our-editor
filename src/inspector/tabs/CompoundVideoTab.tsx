/**
 * Video tab of a compound clip (⌥G): Transform and Blend only. They act on the nested picture as
 * one layer (the compositor draws the sequence offscreen, then draws that layer with these).
 */
import type { CompoundClip } from '../../model/types';
import { BlendSection, TransformSection } from './TransformSection';

export function CompoundVideoTab({ clip }: { clip: CompoundClip }) {
  return (
    <div data-testid="compound-video-tab">
      <TransformSection clip={clip} />
      <BlendSection clip={clip} />
    </div>
  );
}
