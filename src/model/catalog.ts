/**
 * Static catalogues: aspect ratios, animation / transition / filter / blend / font lists,
 * slider ranges. UI lists read from here so labels and ids never drift.
 */
import type {
  Adjust,
  AdjustMaskShape,
  HslColor,
  WheelId,
  AnimationType,
  AspectRatio,
  BlendMode,
  FilterId,
  MaskShape,
  TransitionType,
} from './types';

export const ASPECTS: { id: AspectRatio; label: string; width: number; height: number }[] = [
  { id: '9:16', label: '9:16', width: 1080, height: 1920 },
  { id: '16:9', label: '16:9', width: 1920, height: 1080 },
  { id: '1:1', label: '1:1', width: 1080, height: 1080 },
  { id: '4:5', label: '4:5', width: 1080, height: 1350 },
  { id: '3:4', label: '3:4', width: 1080, height: 1440 },
];

export function aspectSize(aspect: AspectRatio): { width: number; height: number } {
  const a = ASPECTS.find((x) => x.id === aspect) ?? ASPECTS[0]!;
  return { width: a.width, height: a.height };
}

export const ANIMATIONS: { id: AnimationType; label: string }[] = [
  { id: 'fade', label: 'Fade' },
  { id: 'zoom-in', label: 'Zoom In' },
  { id: 'zoom-out', label: 'Zoom Out' },
  { id: 'slide-left', label: 'Slide Left' },
  { id: 'slide-right', label: 'Slide Right' },
  { id: 'slide-up', label: 'Slide Up' },
  { id: 'slide-down', label: 'Slide Down' },
  { id: 'rotate', label: 'Rotate' },
  { id: 'blur', label: 'Blur' },
];

export const TRANSITIONS: { id: TransitionType; label: string }[] = [
  { id: 'mix', label: 'Mix' },
  { id: 'fade-black', label: 'Black Fade' },
  { id: 'fade-white', label: 'White Flash' },
  { id: 'slide-left', label: 'Slide Left' },
  { id: 'slide-right', label: 'Slide Right' },
  { id: 'slide-up', label: 'Slide Up' },
  { id: 'slide-down', label: 'Slide Down' },
  { id: 'wipe-left', label: 'Wipe Left' },
  { id: 'wipe-right', label: 'Wipe Right' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'blur', label: 'Blur' },
];

export const BLEND_MODES: { id: BlendMode; label: string; composite: GlobalCompositeOperation }[] = [
  { id: 'normal', label: 'Normal', composite: 'source-over' },
  { id: 'darken', label: 'Darken', composite: 'darken' },
  { id: 'screen', label: 'Screen', composite: 'screen' },
  { id: 'overlay', label: 'Overlay', composite: 'overlay' },
  { id: 'multiply', label: 'Multiply', composite: 'multiply' },
  { id: 'lighten', label: 'Lighten', composite: 'lighten' },
  { id: 'hard-light', label: 'Hard light', composite: 'hard-light' },
  { id: 'soft-light', label: 'Soft light', composite: 'soft-light' },
  // Canvas 2D has no linear burn: the compositor builds it from difference + lighter passes.
  { id: 'linear-burn', label: 'Linear burn', composite: 'source-over' },
  { id: 'color-burn', label: 'Color burn', composite: 'color-burn' },
  { id: 'color-dodge', label: 'Color dodge', composite: 'color-dodge' },
];

/**
 * A filter = a look expressed as an Adjust delta plus optional grayscale/sepia amounts.
 * Applied at `intensity` (0..1) on top of the clip's own Adjust (see engine/frameState.ts).
 */
export interface FilterDef {
  id: FilterId;
  label: string;
  adjust: Partial<Adjust>;
  grayscale?: number; // 0..1
  sepia?: number; // 0..1
  /** Swatch colour for the tile in the Filters grid until real thumbnails exist. */
  swatch: string;
}

export const FILTERS: FilterDef[] = [
  { id: 'mono', label: 'B&W', adjust: {}, grayscale: 1, swatch: '#9a9a9a' },
  { id: 'noir', label: 'Noir', adjust: { contrast: 35, brightness: -8 }, grayscale: 1, swatch: '#3a3a3a' },
  { id: 'sepia', label: 'Sepia', adjust: { contrast: 5 }, sepia: 0.85, swatch: '#a07a4f' },
  { id: 'vintage', label: 'Vintage', adjust: { fade: 35, saturation: -20, temperature: 15 }, sepia: 0.25, swatch: '#b59a7a' },
  { id: 'warm', label: 'Warm', adjust: { temperature: 30, saturation: 8 }, swatch: '#e0a050' },
  { id: 'cool', label: 'Cool', adjust: { temperature: -30, tint: -5 }, swatch: '#5090d0' },
  { id: 'vivid', label: 'Vivid', adjust: { saturation: 35, contrast: 15 }, swatch: '#e04a8a' },
  { id: 'fade', label: 'Matte', adjust: { fade: 45, contrast: -15 }, swatch: '#8c8c9a' },
  { id: 'cinematic', label: 'Cinematic', adjust: { contrast: 20, saturation: -10, temperature: -12, tint: 6, vignette: 30 }, swatch: '#2f6f73' },
  { id: 'retro', label: 'Retro', adjust: { saturation: -15, fade: 25, temperature: 20, tint: 10 }, sepia: 0.15, swatch: '#c08a60' },
];

export const filterDef = (id: FilterId): FilterDef | undefined => FILTERS.find((f) => f.id === id);

export type AdjustGroup = 'Color' | 'Lightness' | 'Effects';

/** Slider ranges for Adjust › Basic › Adjust, in CapCut's UI order and grouping. */
export const ADJUST_RANGES: { key: keyof Adjust; label: string; group: AdjustGroup; min: number; max: number; hint?: string }[] = [
  { key: 'temperature', label: 'Temp', group: 'Color', min: -50, max: 50 },
  { key: 'tint', label: 'Tint', group: 'Color', min: -50, max: 50 },
  { key: 'saturation', label: 'Saturation', group: 'Color', min: -50, max: 50 },
  { key: 'exposure', label: 'Exposure', group: 'Lightness', min: -50, max: 50 },
  { key: 'brightness', label: 'Brightness', group: 'Lightness', min: -50, max: 50 },
  { key: 'contrast', label: 'Contrast', group: 'Lightness', min: -50, max: 50 },
  { key: 'highlights', label: 'Highlights', group: 'Lightness', min: -50, max: 50 },
  { key: 'shadows', label: 'Shadows', group: 'Lightness', min: -50, max: 50 },
  { key: 'whites', label: 'Whites', group: 'Lightness', min: -50, max: 50 },
  { key: 'blacks', label: 'Blacks', group: 'Lightness', min: -50, max: 50 },
  { key: 'brilliance', label: 'Brilliance', group: 'Lightness', min: -50, max: 50 },
  { key: 'sharpen', label: 'Sharpen', group: 'Effects', min: 0, max: 100 },
  { key: 'clarity', label: 'Clarity', group: 'Effects', min: 0, max: 100 },
  { key: 'grain', label: 'Particles', group: 'Effects', min: 0, max: 100, hint: 'Film grain' },
  { key: 'fade', label: 'Fade', group: 'Effects', min: 0, max: 100 },
  { key: 'vignette', label: 'Vignette', group: 'Effects', min: 0, max: 100 },
];

/** HSL colour ranges: centre hue (degrees) and swatch, in CapCut's order. */
export const HSL_RANGES: { id: HslColor; label: string; hue: number; swatch: string }[] = [
  { id: 'red', label: 'Red', hue: 0, swatch: '#ff3b30' },
  { id: 'orange', label: 'Orange', hue: 30, swatch: '#ff9500' },
  { id: 'yellow', label: 'Yellow', hue: 60, swatch: '#ffd60a' },
  { id: 'green', label: 'Green', hue: 120, swatch: '#34c759' },
  { id: 'cyan', label: 'Cyan', hue: 180, swatch: '#32d7e6' },
  { id: 'blue', label: 'Blue', hue: 240, swatch: '#2f6bff' },
  { id: 'purple', label: 'Purple', hue: 270, swatch: '#9b5cff' },
  { id: 'magenta', label: 'Magenta', hue: 300, swatch: '#ff3bd4' },
];

export const WHEELS: { id: WheelId; label: string; hint: string }[] = [
  { id: 'lift', label: 'Lift', hint: 'Shadows' },
  { id: 'gamma', label: 'Gamma', hint: 'Midtones' },
  { id: 'gain', label: 'Gain', hint: 'Highlights' },
  { id: 'offset', label: 'Offset', hint: 'All tones' },
];

/** Adjust › Mask shapes (the mask that limits the grade). */
export const ADJUST_MASK_SHAPES: { id: AdjustMaskShape; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'linear', label: 'Linear' },
  { id: 'mirror', label: 'Mirror' },
  { id: 'circle', label: 'Circle' },
  { id: 'rectangle', label: 'Rectangle' },
];

/** System fonts only in v1 (no network). */
export const FONTS: string[] = [
  'system-ui',
  'Arial',
  'Helvetica',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Impact',
  'Trebuchet MS',
  'Verdana',
];

export const LIMITS = {
  speedMin: 0.1,
  speedMax: 100,
  scaleMin: 0.01,
  scaleMax: 4,
  volumeDbMin: -60,
  volumeDbMax: 20,
  zoomMin: 2, // px per second
  zoomMax: 600,
  zoomDefault: 60,
  undoCap: 200,
} as const;

/** Video › Mask shape tiles, in CapCut's order. */
export const MASK_SHAPES: { id: MaskShape; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'linear', label: 'Linear' },
  { id: 'mirror', label: 'Mirror' },
  { id: 'circle', label: 'Circle' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'heart', label: 'Heart' },
  { id: 'star', label: 'Star' },
];

/** Video › Basic › Canvas › Blur: the four levels as a gaussian blur radius in project px. */
export const CANVAS_BLUR_PX = [12, 30, 60, 100] as const;

/** Video › Basic › Canvas › Color: CapCut-like swatches. */
export const CANVAS_COLORS = ['#000000', '#ffffff', '#7f7f7f', '#e94b3c', '#f39c33', '#f4d03f', '#58d68d', '#1fc4d6', '#3b7ddd', '#9b59b6', '#f1948a', '#1c2833'];
