/**
 * Library preset catalogues owned by the Library: text styles, adjustment presets and the
 * category groupings shown in each tab's sidebar. Model-level catalogues (transitions, filters,
 * animations) stay in src/model/catalog.ts; this file only groups and decorates them.
 */
import type { Adjust, ClipPatch, FilterId, TransitionType } from '../model/types';

// ---------------------------------------------------------------- text

export interface TextPreset {
  id: string;
  label: string;
  content: string;
  /** Applied with updateClip right after addTextClip (same undo step). */
  style: NonNullable<ClipPatch['text']>;
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'default', label: 'Default text', content: 'Default text', style: {} },
  {
    id: 'title',
    label: 'Title',
    content: 'Title',
    style: { fontFamily: 'Impact', fontSize: 140, bold: false, letterSpacing: 2 },
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    content: 'Subtitle',
    style: { fontSize: 54, background: { enabled: true, color: '#000000', opacity: 0.55 } },
  },
  {
    id: 'outline',
    label: 'Outline',
    content: 'Outline',
    style: { fontSize: 110, bold: true, color: '#ffffff', stroke: { enabled: true, color: '#000000', width: 10 } },
  },
  {
    id: 'caption',
    label: 'Caption',
    content: 'Caption',
    style: { fontSize: 72, bold: true, color: '#ffe14d', stroke: { enabled: true, color: '#000000', width: 8 } },
  },
  {
    id: 'shadow',
    label: 'Shadow',
    content: 'Shadow',
    style: { fontSize: 96, bold: true, shadow: { enabled: true, color: '#000000', blur: 12, offsetX: 6, offsetY: 6 } },
  },
  {
    id: 'neon',
    label: 'Neon',
    content: 'Neon',
    style: { fontSize: 100, bold: true, color: '#7df9ff', shadow: { enabled: true, color: '#22d3ee', blur: 28, offsetX: 0, offsetY: 0 } },
  },
  {
    id: 'label',
    label: 'Label',
    content: 'LABEL',
    style: { fontSize: 64, bold: true, color: '#111111', letterSpacing: 4, background: { enabled: true, color: '#ffffff', opacity: 1 } },
  },
  {
    id: 'serif',
    label: 'Serif',
    content: 'Elegant',
    style: { fontFamily: 'Georgia', fontSize: 96, italic: true },
  },
  {
    id: 'mono',
    label: 'Typewriter',
    content: 'Typewriter',
    style: { fontFamily: 'Courier New', fontSize: 72, color: '#f5f5f5' },
  },
];

export const textPreset = (id: string | undefined): TextPreset | undefined => TEXT_PRESETS.find((p) => p.id === id);

// ---------------------------------------------------------------- adjustment presets

export interface AdjustPreset {
  id: string;
  label: string;
  adjust: Partial<Adjust>;
}

/** "Adjustment" tab: one click sets the clip's Adjust › Basic to these values (others neutral). */
export const ADJUST_PRESETS: AdjustPreset[] = [
  { id: 'brighten', label: 'Brighten', adjust: { brightness: 18, exposure: 8 } },
  { id: 'darken', label: 'Darken', adjust: { brightness: -15, exposure: -8 } },
  { id: 'contrast', label: 'High contrast', adjust: { contrast: 30, highlights: -8, shadows: -8 } },
  { id: 'soft', label: 'Soft', adjust: { contrast: -18, highlights: -10, shadows: 12 } },
  { id: 'warm', label: 'Warm up', adjust: { temperature: 25, tint: 4 } },
  { id: 'cool', label: 'Cool down', adjust: { temperature: -25, tint: -3 } },
  { id: 'pop', label: 'Pop color', adjust: { saturation: 30, contrast: 10 } },
  { id: 'desat', label: 'Desaturate', adjust: { saturation: -40 } },
  { id: 'matte', label: 'Matte', adjust: { fade: 40, contrast: -10 } },
  { id: 'vignette', label: 'Vignette', adjust: { vignette: 55 } },
  { id: 'crisp', label: 'Crisp', adjust: { sharpen: 45, contrast: 8 } },
];

// ---------------------------------------------------------------- category groupings

export const TRANSITION_GROUPS: { id: string; label: string; types: TransitionType[] }[] = [
  { id: 'basic', label: 'Basic', types: ['mix', 'fade-black', 'fade-white', 'blur', 'zoom'] },
  { id: 'slide', label: 'Slide', types: ['slide-left', 'slide-right', 'slide-up', 'slide-down'] },
  { id: 'wipe', label: 'Wipe', types: ['wipe-left', 'wipe-right'] },
];

export const FILTER_GROUPS: { id: string; label: string; ids: FilterId[] }[] = [
  { id: 'mono', label: 'Mono', ids: ['mono', 'noir'] },
  { id: 'color', label: 'Color', ids: ['warm', 'cool', 'vivid'] },
  { id: 'retro', label: 'Retro', ids: ['sepia', 'vintage', 'retro'] },
  { id: 'style', label: 'Style', ids: ['fade', 'cinematic'] },
];
