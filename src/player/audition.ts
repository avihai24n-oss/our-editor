/**
 * Audition: hear one clip with the voice change you just picked (Audio › Voice changer).
 *
 * Picking a voice filter tile (None too), resetting the filters, a Mixer preset or the Mixer
 * on/off box calls `auditionClip(id)`: the playhead jumps to the audition start and the preview
 * plays — or, already playing, re-seeks — and playback stops by itself at the clip's end.
 *
 * Start point (`auditionRange`):
 * - a clip up to AUDITION_LONG_US (20 s) always starts at its first frame;
 * - a longer clip starts where the playhead is when it's inside the clip (at least 1 s before
 *   the end), else at the clip start;
 * - consecutive auditions of the same clip reuse the first one's start (the anchor) while that
 *   audition is still playing, or when it stopped (clip end, Space) and the playhead was not
 *   moved since — so tile after tile restarts at the same word. Moving the playhead makes a new
 *   anchor.
 * The stop point is the clip's end. Normal playback (Space / Play) has no stop point: every pause
 * ends the audition (PreviewEngine calls `endAudition`), and a seek outside the clip cancels it.
 * Slider drags (Strength, Mixer) never restart — the preview graph follows them live.
 */
import { findClip } from '../model/project';
import type { Id, Us } from '../model/types';
import { useEditor } from '../store';

/** Clips longer than this start at the playhead (when it's inside them), not at their start. */
export const AUDITION_LONG_US = 20_000_000;
/** A playhead this close to the end of a long clip starts the audition from the clip start. */
export const AUDITION_END_MARGIN_US = 1_000_000;

export interface AuditionClip {
  start: Us;
  duration: Us;
}

/** Where an audition of `clip` plays: [from, to). `anchor` = the previous audition's start to reuse. */
export function auditionRange(clip: AuditionClip, playhead: Us, anchor: Us | null = null): { from: Us; to: Us } {
  const to = clip.start + clip.duration;
  if (anchor !== null && anchor >= clip.start && anchor < to) return { from: anchor, to };
  const long = clip.duration > AUDITION_LONG_US;
  const inside = playhead >= clip.start && playhead < to - AUDITION_END_MARGIN_US;
  return { from: long && inside ? playhead : clip.start, to };
}

interface Active {
  clipId: Id;
  from: Us;
  to: Us;
  clipStart: Us;
}

let active: Active | null = null;
/** The last finished audition: its start is reused while the playhead stays where it stopped. */
let last: { clipId: Id; from: Us; endedAt: Us } | null = null;

/** Playback stops here (µs) while an audition runs; null = normal playback. */
export const auditionStopAt = (): Us | null => active?.to ?? null;

/** The running audition (e2e / debug). */
export const auditionState = (): Readonly<Active> | null => active;

/** Playback stopped (any reason): remember where, for the anchor. */
export function endAudition(playhead: Us): void {
  if (!active) return;
  last = { clipId: active.clipId, from: active.from, endedAt: playhead };
  active = null;
}

/** A seek while playing: leaving the clip turns the audition into normal playback. */
export function auditionSeek(playhead: Us): void {
  if (active && (playhead < active.clipStart || playhead >= active.to)) {
    active = null;
    last = null;
  }
}

/** Jump to the audition start of clip `clipId` and play it to its end (restart if playing). */
export function auditionClip(clipId: Id): void {
  const s = useEditor.getState();
  const hit = findClip(s.project, clipId);
  if (!hit) return;
  const clip = hit.clip;
  const resume = (s.playing && active?.clipId === clipId) || (!s.playing && last?.clipId === clipId && last.endedAt === s.playhead);
  const anchor = resume ? (s.playing ? active!.from : last!.from) : null;
  const { from, to } = auditionRange(clip, s.playhead, anchor);
  if (to <= from) return;
  active = { clipId, from, to, clipStart: clip.start };
  last = null;
  s.setPlayhead(from); // playing: the engine re-seeks; the new graph is built on the same tick
  if (!s.playing) s.play();
  if (!useEditor.getState().playing) active = null;
}

/** Tests: forget every audition. */
export function resetAudition(): void {
  active = null;
  last = null;
}
