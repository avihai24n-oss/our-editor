/**
 * Built-in film looks of Adjust › Color › Gallery. Each look is a Color page built from neutral
 * defaults (primaries, log wheels, HSL curves); applying one replaces the clip's Color page
 * (CST, qualifier and Lum Mix are kept) as one undo step. Basic › Adjust, LUT, Curves and the
 * Lift / Gamma / Gain wheels are not touched.
 */
import { defaultColorPage, type ColorPage } from '../../../model/colorPage';
import type { WheelValue } from '../../../model/types';

/** Wheel puck at hue `deg` (0 = red, counter-clockwise) and strength 0..1. */
const puck = (deg: number, r: number, luma = 0): WheelValue => ({
  x: Math.round(Math.cos((deg * Math.PI) / 180) * r * 1000) / 1000,
  y: Math.round(Math.sin((deg * Math.PI) / 180) * r * 1000) / 1000,
  luma,
});

export interface BuiltInLook {
  id: string;
  name: string;
  /** Swatch gradient for the gallery tile. */
  swatch: string;
  build: (base: ColorPage) => ColorPage;
}

const page = (base: ColorPage, fn: (p: ColorPage) => void): ColorPage => {
  const p = defaultColorPage();
  p.cst = { ...base.cst };
  p.qualifier = JSON.parse(JSON.stringify(base.qualifier)) as ColorPage['qualifier'];
  p.primaries.lumMix = base.primaries.lumMix;
  fn(p);
  return p;
};

export const BUILT_IN_LOOKS: BuiltInLook[] = [
  {
    id: 'teal-orange',
    name: 'Teal & orange',
    swatch: 'linear-gradient(135deg, #1d5a6e, #e08a3c)',
    build: (b) =>
      page(b, (p) => {
        Object.assign(p.primaries, { contrast: 1.15, saturation: 56 });
        p.logWheels.shadow = puck(195, 0.45);
        p.logWheels.highlight = puck(32, 0.35);
        p.hslCurves.hueSat = [{ x: 30 / 360, y: 0.6 }, { x: 120 / 360, y: 0.4 }];
      }),
  },
  {
    id: 'bleach-bypass',
    name: 'Bleach bypass',
    swatch: 'linear-gradient(135deg, #2a2d2e, #b9bcb5)',
    build: (b) =>
      page(b, (p) => {
        Object.assign(p.primaries, { contrast: 1.35, saturation: 24, colorBoost: -30, highlights: -10 });
      }),
  },
  {
    id: 'warm-heritage',
    name: 'Warm heritage',
    swatch: 'linear-gradient(135deg, #3b2a1a, #e9c28a)',
    build: (b) =>
      page(b, (p) => {
        Object.assign(p.primaries, { contrast: 1.1, saturation: 44, temp: 900, shadows: 12 });
        p.logWheels.highlight = puck(40, 0.25);
        p.logWheels.shadow = puck(20, 0.12, 4);
      }),
  },
  {
    id: 'cool-night',
    name: 'Cool night',
    swatch: 'linear-gradient(135deg, #0b1630, #5f7fb0)',
    build: (b) =>
      page(b, (p) => {
        Object.assign(p.primaries, { contrast: 1.2, saturation: 40, temp: -1500, tint: 6, highlights: -20 });
        p.logWheels.shadow = puck(225, 0.3, -4);
      }),
  },
  {
    id: 'faded-film',
    name: 'Faded film',
    swatch: 'linear-gradient(135deg, #4a4540, #d8cbb2)',
    build: (b) =>
      page(b, (p) => {
        Object.assign(p.primaries, { contrast: 0.85, saturation: 42 });
        p.logWheels.shadow = puck(200, 0.15, 14);
        p.logWheels.highlight = puck(50, 0.15, -6);
        p.hslCurves.lumSat = [{ x: 0, y: 0.35 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.4 }];
      }),
  },
  {
    id: 'sepia-memory',
    name: 'Sepia memory',
    swatch: 'linear-gradient(135deg, #2b1d10, #d4b48a)',
    build: (b) =>
      page(b, (p) => {
        Object.assign(p.primaries, { contrast: 1.08, saturation: 12, temp: 1400 });
        p.logWheels.midtone = puck(35, 0.3);
      }),
  },
];
