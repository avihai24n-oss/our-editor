/**
 * Caption presets, fonts and highlight swatches.
 *
 * Ported from MakePodcast (podcastor: lib/captions.ts, remotion/PodcastReel.tsx,
 * components/app/CaptionsPicker.tsx): the five caption modes (Karaoke, Word Pop, Clean, Hormozi,
 * Highlight Box), the Glow option, the ten bilingual Hebrew + Latin fonts with the weight each is
 * rendered at, the 92 px size at 1080 px, the soft drop shadow, the 82 % caption box, one-line fit
 * and the highlight swatches (coral #FF5A3C first). The rest are our own additions for films.
 */
import type { CaptionStyle } from './types';

/** MakePodcast's ten caption fonts (all bilingual He/Latin) at the weight MakePodcast renders them. */
export const CAPTION_FONTS: { id: string; family: string; weight: number }[] = [
  { id: 'secular-one', family: 'Secular One', weight: 400 },
  { id: 'heebo', family: 'Heebo', weight: 900 },
  { id: 'rubik', family: 'Rubik', weight: 800 },
  { id: 'assistant', family: 'Assistant', weight: 800 },
  { id: 'suez-one', family: 'Suez One', weight: 400 },
  { id: 'varela-round', family: 'Varela Round', weight: 400 },
  { id: 'frank-ruhl', family: 'Frank Ruhl Libre', weight: 900 },
  { id: 'karantina', family: 'Karantina', weight: 700 },
  { id: 'alef', family: 'Alef', weight: 700 },
  { id: 'miriam-libre', family: 'Miriam Libre', weight: 700 },
];

/** Font menu of the caption lab: the bundled families first, then system fonts. */
export const CAPTION_FONT_FAMILIES: string[] = [...CAPTION_FONTS.map((f) => f.family), 'system-ui', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Impact', 'Verdana'];

/** MakePodcast's highlight palette. */
export const HIGHLIGHT_SWATCHES: { hex: string; name: string }[] = [
  { hex: '#FF5A3C', name: 'Coral' },
  { hex: '#FF8100', name: 'Orange' },
  { hex: '#FFD400', name: 'Yellow' },
  { hex: '#00E5A0', name: 'Green' },
  { hex: '#3DA5FF', name: 'Blue' },
  { hex: '#FF3D7F', name: 'Pink' },
  { hex: '#B388FF', name: 'Purple' },
  { hex: '#FFFFFF', name: 'White' },
];

/** Sizes in presets are MakePodcast px at a 1080 px short side; `presetStyle` scales them to the canvas. */
const REF = 1080;

const BASE: CaptionStyle = {
  preset: 'karaoke',
  animation: 'highlight',
  fontFamily: 'Secular One',
  fontWeight: 400,
  italic: false,
  fontSize: 92,
  uppercase: false,
  color: '#FFFFFF',
  highlightColor: '#FF5A3C',
  glow: false,
  stroke: { enabled: false, color: '#000000', width: 6 },
  // MakePodcast DEFAULT_EFFECT: textShadow 0 4px 18px rgba(0,0,0,0.9)
  shadow: { enabled: true, color: 'rgba(0,0,0,0.9)', blur: 18, offsetX: 0, offsetY: 4 },
  background: { enabled: false, color: '#000000', opacity: 0.6, radius: 12 },
  x: 0,
  y: 0.8,
  safeArea: true,
  align: 'center',
  maxWidth: 0.82,
  maxLines: 1,
  lineHeight: 1.15,
  // margin 0 10px per word at 92 px = 20 px between words
  wordSpacing: 0.22,
};

export interface CaptionPreset {
  id: string;
  label: string;
  desc: string;
  /** Ported from MakePodcast (vs. added here). */
  makepodcast: boolean;
  /** Max words per caption when transcribing with this preset. */
  maxWords: number;
  maxChars: number;
  style: Partial<CaptionStyle>;
}

export const CAPTION_PRESETS: CaptionPreset[] = [
  { id: 'karaoke', label: 'Karaoke', desc: 'A few words on screen, the spoken one highlighted.', makepodcast: true, maxWords: 4, maxChars: 26, style: { animation: 'highlight' } },
  { id: 'word-pop', label: 'Word Pop', desc: "One word at a time, popping in as it's said.", makepodcast: true, maxWords: 4, maxChars: 26, style: { animation: 'word-pop' } },
  { id: 'plain', label: 'Clean', desc: 'A few words on screen, no highlight — clean and readable.', makepodcast: true, maxWords: 4, maxChars: 26, style: { animation: 'none' } },
  {
    id: 'hormozi',
    label: 'Hormozi',
    desc: 'ALL-CAPS words; the spoken one pops in your accent color, the rest stay white.',
    makepodcast: true,
    maxWords: 4,
    maxChars: 26,
    style: { animation: 'pop-highlight', uppercase: true },
  },
  { id: 'box', label: 'Highlight Box', desc: 'The spoken word sits on a colored box.', makepodcast: true, maxWords: 4, maxChars: 26, style: { animation: 'box', wordSpacing: 0.04 } },
  {
    id: 'karaoke-glow',
    label: 'Karaoke Glow',
    desc: 'Karaoke with a soft glow around each word instead of the shadow.',
    makepodcast: true,
    maxWords: 4,
    maxChars: 26,
    style: { animation: 'highlight', glow: true, shadow: { ...BASE.shadow, enabled: false } },
  },
  {
    id: 'word-pop-glow',
    label: 'Word Pop Glow',
    desc: 'One glowing word at a time in the highlight colour.',
    makepodcast: true,
    maxWords: 4,
    maxChars: 26,
    style: { animation: 'word-pop', glow: true, shadow: { ...BASE.shadow, enabled: false } },
  },
  { id: 'karaoke-fill', label: 'Karaoke Fill', desc: 'The colour sweeps through each word as it is said.', makepodcast: false, maxWords: 5, maxChars: 30, style: { animation: 'karaoke-fill', fontFamily: 'Heebo', fontWeight: 900 } },
  { id: 'bounce', label: 'Bounce', desc: 'The spoken word jumps up in the highlight colour.', makepodcast: false, maxWords: 4, maxChars: 26, style: { animation: 'bounce', fontFamily: 'Rubik', fontWeight: 800, highlightColor: '#FFD400' } },
  { id: 'reveal', label: 'Word Reveal', desc: 'Words appear one by one as they are said.', makepodcast: false, maxWords: 6, maxChars: 34, style: { animation: 'reveal', fontFamily: 'Assistant', fontWeight: 800, maxLines: 2 } },
  {
    id: 'outline',
    label: 'Outline',
    desc: 'Bold white words with a black outline, the spoken one in yellow.',
    makepodcast: false,
    maxWords: 3,
    maxChars: 22,
    style: { animation: 'highlight', fontFamily: 'Heebo', fontWeight: 900, highlightColor: '#FFD400', stroke: { enabled: true, color: '#000000', width: 7 }, shadow: { ...BASE.shadow, enabled: false } },
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    desc: 'Classic film subtitles: two lines on a soft dark box, no animation.',
    makepodcast: false,
    maxWords: 14,
    maxChars: 84,
    style: {
      animation: 'none',
      fontFamily: 'Heebo',
      fontWeight: 500,
      fontSize: 50,
      y: 0.88,
      maxWidth: 0.86,
      maxLines: 2,
      lineHeight: 1.25,
      wordSpacing: 0.26,
      shadow: { enabled: false, color: 'rgba(0,0,0,0.9)', blur: 6, offsetX: 0, offsetY: 2 },
      background: { enabled: true, color: '#000000', opacity: 0.55, radius: 10 },
    },
  },
];

export const presetById = (id: string): CaptionPreset | undefined => CAPTION_PRESETS.find((p) => p.id === id);

/** Default preset for a canvas: Karaoke on vertical / square, Subtitle on landscape. */
export const defaultPresetId = (width: number, height: number): string => (width > height ? 'subtitle' : 'karaoke');

/** The full style of a preset, sizes scaled to a W×H canvas (`keep` = fields kept from an earlier style, e.g. colours). */
export function presetStyle(id: string, width: number, height: number, keep?: Partial<CaptionStyle>): CaptionStyle {
  const p = presetById(id) ?? CAPTION_PRESETS[0]!;
  const s: CaptionStyle = structuredClone({ ...BASE, ...p.style, preset: p.id });
  const k = Math.min(width, height) / REF;
  s.fontSize = Math.round(s.fontSize * k);
  s.stroke.width = Math.round(s.stroke.width * k * 10) / 10;
  s.shadow.blur = Math.round(s.shadow.blur * k * 10) / 10;
  s.shadow.offsetX = Math.round(s.shadow.offsetX * k * 10) / 10;
  s.shadow.offsetY = Math.round(s.shadow.offsetY * k * 10) / 10;
  s.background.radius = Math.round(s.background.radius * k);
  if (width > height && s.y === BASE.y) s.y = 0.84; // landscape: lower, clear of faces
  return keep ? { ...s, ...structuredClone(keep), preset: p.id, animation: s.animation } : s;
}

/** Track default when a caption track is created. */
export const defaultCaptionStyle = (width: number, height: number): CaptionStyle => presetStyle(defaultPresetId(width, height), width, height);
