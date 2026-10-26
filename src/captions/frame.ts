/**
 * Captions in the render contract: what a caption clip contributes to its TextDrawOp at time t.
 * Pure (called from getFrameState), so the player and the exporter draw the same words with the
 * same timing. The drawing itself is ./render.ts.
 */
import type { Project, TextClip, Track, Us } from '../model/types';
import { isCaptionClip, isRTLText, joinWords, resolveStyle, visibleWords } from './model';
import type { CaptionStyle, CaptionWord } from './types';

export interface CaptionFrame {
  style: CaptionStyle;
  /** Visible words, timeline µs. */
  words: CaptionWord[];
  /** Timeline time of this frame (the words animate against it). */
  now: Us;
  /** The caption reads right to left (Hebrew / Arabic). */
  rtl: boolean;
}

/** Caption data + base position for a caption clip's op; `op` unchanged for other clips. */
export function withCaption<T extends { transform: { x: number; y: number } }>(op: T, project: Project, track: Track | undefined, clip: TextClip, t: Us): T & { caption?: CaptionFrame } {
  if (!isCaptionClip(clip)) return op;
  const style = resolveStyle(track, clip, project);
  const words = visibleWords(clip);
  const { width: W, height: H } = project.settings;
  const caption: CaptionFrame = { style, words, now: t, rtl: isRTLText(joinWords(words)) };
  return { ...op, caption, transform: { ...op.transform, x: op.transform.x + style.x * W, y: op.transform.y + (style.y - 0.5) * H } };
}

export type WordPhase = 'future' | 'active' | 'past';

export interface WordState {
  phase: WordPhase;
  /** 0..1 through the word (active), 0 before, 1 after. */
  progress: number;
  /** Seconds since the word started (negative before). */
  since: number;
}

export function wordState(w: CaptionWord, now: Us): WordState {
  if (now < w.start) return { phase: 'future', progress: 0, since: (now - w.start) / 1e6 };
  if (now >= w.end) return { phase: 'past', progress: 1, since: (now - w.start) / 1e6 };
  return { phase: 'active', progress: (now - w.start) / Math.max(1, w.end - w.start), since: (now - w.start) / 1e6 };
}

/**
 * Damped spring 0 → 1 (Remotion's `spring` with zero initial velocity), t in seconds.
 * MakePodcast: Word Pop {damping 12, stiffness 200, mass 0.5}, Hormozi {14, 240, 0.5}.
 */
export function spring(t: number, cfg: { damping: number; stiffness: number; mass: number }): number {
  if (t <= 0) return 0;
  const w0 = Math.sqrt(cfg.stiffness / cfg.mass);
  const zeta = cfg.damping / (2 * Math.sqrt(cfg.stiffness * cfg.mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

export const WORD_POP_SPRING = { damping: 12, stiffness: 200, mass: 0.5 };
export const HORMOZI_SPRING = { damping: 14, stiffness: 240, mass: 0.5 };

/** Which word Word Pop shows: the spoken one (MakePodcast shows nothing between words). */
export const activeWordIndex = (words: readonly CaptionWord[], now: Us): number => words.findIndex((w) => now >= w.start && now < w.end);
