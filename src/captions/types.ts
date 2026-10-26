/**
 * Captions — data model (added 26 Oct 2026).
 *
 * A caption track is an ordinary `text` track whose `captions` field is set; each caption on it
 * is an ordinary TextClip whose `caption` field holds the words. So captions move, trim, split,
 * delete, copy and undo like every other clip, and draw through the shared render path.
 *
 * Word times are integer µs on the clip's CAPTION AXIS: a word at `start` plays at timeline time
 * `clip.start - caption.offset + start` (see `captionOrigin`). `offset` works like a media clip's
 * in-point: trimming the left edge or splitting adds to it, so the words stay on their sound;
 * moving the clip moves the words with it.
 */
import type { Us } from '../model/types';

export interface CaptionWord {
  text: string;
  /** µs on the caption axis (see file header). */
  start: Us;
  end: Us;
}

/** Look of the words (MakePodcast's caption modes plus a few of our own). */
export type CaptionAnimation =
  /** every word the same colour */
  | 'none'
  /** the spoken word in the highlight colour (MakePodcast Karaoke) */
  | 'highlight'
  /** the spoken word sits on a highlight-colour box (MakePodcast Highlight Box) */
  | 'box'
  /** one word at a time, springing in (MakePodcast Word Pop) */
  | 'word-pop'
  /** spoken word in the highlight colour with a snappy pop (MakePodcast Hormozi) */
  | 'pop-highlight'
  /** the highlight colour sweeps through each word as it is said; said words stay filled */
  | 'karaoke-fill'
  /** the spoken word jumps up and lands */
  | 'bounce'
  /** words appear as they are said */
  | 'reveal';

export interface CaptionStyle {
  /** Preset this style started from (UI only; the fields below are what renders). */
  preset: string;
  animation: CaptionAnimation;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  /** Project px. */
  fontSize: number;
  /** ALL CAPS (Latin; Hebrew has no case). */
  uppercase: boolean;
  color: string;
  highlightColor: string;
  /** MakePodcast "Glow": a soft halo in the word's colour instead of the drop shadow. */
  glow: boolean;
  stroke: { enabled: boolean; color: string; width: number };
  shadow: { enabled: boolean; color: string; blur: number; offsetX: number; offsetY: number };
  /** Box behind the whole caption. */
  background: { enabled: boolean; color: string; opacity: number; radius: number };
  /** Block centre: x as a fraction of the width from the centre (−0.5..0.5), y as a fraction of the height from the top (0..1). */
  x: number;
  y: number;
  /** Keep the block inside the title-safe area (5 % of each side). */
  safeArea: boolean;
  align: 'left' | 'center' | 'right';
  /** Lines wrap at this fraction of the canvas width. */
  maxWidth: number;
  /** At most this many lines; a longer caption shrinks to fit (down to half size). */
  maxLines: number;
  /** Line height, multiple of the font size. */
  lineHeight: number;
  /** Space between words, multiple of the font size. */
  wordSpacing: number;
}

export interface CaptionSegment {
  words: CaptionWord[];
  /** µs: caption-axis time at the clip's left edge (like a media in-point). */
  offset: Us;
  /** Overrides of the track style for this caption only. */
  style?: Partial<CaptionStyle>;
}

/** Set on a text track to make it a caption track. */
export interface CaptionTrackSettings {
  style: CaptionStyle;
  /** Language of the last transcription ('he', 'en', 'auto'…), informational. */
  language?: string;
  /** Draw the captions into the exported video (default true). Off = preview only. */
  burnIn?: boolean;
}
