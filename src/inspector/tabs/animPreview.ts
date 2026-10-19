/**
 * "Selecting a tile previews it in the player once" (CapCut): play the clip over the window
 * where the chosen animation acts, pause at its end and put the playhead back where it was.
 */
import { DEFAULT_ANIMATION_DURATION } from '../../model/defaults';
import type { AnimationSlot, Us, VisualClip } from '../../model/types';
import { useEditor } from '../../store';

let stop: (() => void) | null = null;

/** Timeline window [start, end) the slot plays in. */
export function animationWindow(clip: VisualClip, slot: AnimationSlot): { start: Us; end: Us } {
  const end = clip.start + clip.duration;
  switch (slot) {
    case 'in':
      return { start: clip.start, end: clip.start + (clip.animationIn?.duration ?? DEFAULT_ANIMATION_DURATION) };
    case 'out':
      return { start: end - (clip.animationOut?.duration ?? DEFAULT_ANIMATION_DURATION), end };
    case 'combo':
      return { start: clip.start, end: clip.start + (clip.animationCombo?.duration ?? clip.duration) };
    case 'loop':
      // two cycles (or the whole clip if shorter)
      return { start: clip.start, end: Math.min(end, clip.start + 2 * (clip.animationLoop?.duration ?? 1_000_000)) };
  }
}

export function stopAnimationPreview(): void {
  stop?.();
}

/** Plays [start, end) once in the player. A new preview, a pause or a seek ends the current one. */
export function previewOnce(start: Us, end: Us): void {
  stop?.();
  const s = useEditor.getState();
  const restore = s.playhead;
  s.pause();
  s.setPlayhead(start);
  s.play();
  let lastPlayhead = start;
  // safety net: a "once" preview always ends, even if the clock stalls (e.g. no audio device)
  const timer = setTimeout(() => finish(true), (end - start) / 1000 + 1500);
  const finish = (back: boolean) => {
    clearTimeout(timer);
    unsub();
    stop = null;
    const st = useEditor.getState();
    if (st.playing) st.pause();
    if (back) st.setPlayhead(restore);
  };
  const unsub = useEditor.subscribe((st) => {
    if (!st.playing) return finish(st.playhead >= end - 50_000); // reached the project end, or the user paused
    if (st.playhead < lastPlayhead - 1000) return finish(false); // the user seeked back
    lastPlayhead = st.playhead;
    if (st.playhead >= end) finish(true);
  });
  stop = () => finish(false);
}
