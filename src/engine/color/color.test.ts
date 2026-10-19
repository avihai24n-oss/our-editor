import { describe, expect, it } from 'vitest';
import { defaultAdjust, defaultGrade } from '../../model/defaults';
import type { ColorGrade, CurvePoint } from '../../model/types';
import type { ColorOps } from '../frameState';
import { bakeCurve, bakeCurvesTable, monotoneCurve, normalizeCurve } from './curves';
import { CubeParseError, identityCube, parseCube, sampleLut, writeCube } from './cube';
import { gradeImageData } from './grader';
import {
  applyBrightnessContrast,
  applyWhiteBalanceExposure,
  gradePixel,
  hash3,
  hslWeights,
  luma,
  maskAlpha,
  srgbToLinear,
  vignetteFactor,
} from './math';
import { gradeParams, K, maskParams, wheelChroma, type GradeParams } from './params';

const ops = (adj: Partial<ColorOps> = {}, grade?: (g: ColorGrade) => void): ColorOps => {
  const g = defaultGrade();
  grade?.(g);
  return { ...defaultAdjust(), grayscale: 0, sepia: 0, ...adj, grade: g };
};
const P = (adj: Partial<ColorOps> = {}, grade?: (g: ColorGrade) => void): GradeParams => {
  const p = gradeParams(ops(adj, grade));
  if (!p) throw new Error('expected non-neutral params');
  return p;
};
const env = { u: 0.5, v: 0.5, aspect: 1 };
const px = (c: [number, number, number], p: GradeParams, e = env) => gradePixel(c, p, e);

describe('params', () => {
  it('neutral settings skip the colour pass', () => {
    expect(gradeParams(ops())).toBeNull();
    // a mask alone changes nothing
    expect(gradeParams(ops({}, (g) => (g.mask.shape = 'circle')))).toBeNull();
    // disabled sections are ignored
    expect(
      gradeParams(
        ops({}, (g) => {
          g.hsl.enabled = false;
          g.hsl.bands.red.saturation = -100;
          g.curves.enabled = false;
          g.curves.master = [{ x: 0, y: 1 }, { x: 1, y: 0 }];
        }),
      ),
    ).toBeNull();
    // a LUT that is not loaded is skipped
    expect(gradeParams(ops({}, (g) => (g.lut.lutId = 'x')), 0, () => false)).toBeNull();
  });

  it('maps slider units to -1..1 / 0..1 and clamps filter+adjust sums', () => {
    const p = P({ temperature: 25, saturation: -90, vignette: 160 });
    expect(p.temp).toBeCloseTo(0.5);
    expect(p.saturation).toBe(-1);
    expect(p.vignette).toBe(1);
  });
});

describe('basic adjust reference values (sRGB in → sRGB out)', () => {
  it('saturation −50 → grey: R = G = B = Rec.709 luma', () => {
    const p = P({ saturation: -50 });
    for (const c of [
      [1, 0, 0],
      [0, 0.8, 0.2],
      [0.75, 0.75, 0],
    ] as [number, number, number][]) {
      const o = px(c, p);
      expect(o[0]).toBeCloseTo(luma(c), 6);
      expect(o[1]).toBeCloseTo(o[0], 6);
      expect(o[2]).toBeCloseTo(o[0], 6);
    }
    expect(px([1, 0, 0], p)[0]).toBeCloseTo(0.2126, 6);
  });

  it('saturation +50 doubles the distance from luma', () => {
    const o = px([0.6, 0.5, 0.4], P({ saturation: 50 }));
    const Y = luma([0.6, 0.5, 0.4]);
    expect(o[0]).toBeCloseTo(Y + (0.6 - Y) * 2, 6);
    expect(o[2]).toBeCloseTo(Y + (0.4 - Y) * 2, 6);
  });

  it('temp +50 on mid grey → warmer (R up, B down), luminance kept in linear light', () => {
    const o = px([0.5, 0.5, 0.5], P({ temperature: 50 }));
    expect(o[0]).toBeCloseTo(0.5536, 3);
    expect(o[1]).toBeCloseTo(0.4905, 3);
    expect(o[2]).toBeCloseTo(0.4152, 3);
    const linY = (c: number[]) => 0.2126 * srgbToLinear(c[0]!) + 0.7152 * srgbToLinear(c[1]!) + 0.0722 * srgbToLinear(c[2]!);
    expect(linY(o)).toBeCloseTo(srgbToLinear(0.5), 3);
  });

  it('temp −50 → cooler (B up, R down); tint +50 → magenta (G down)', () => {
    const cool = px([0.5, 0.5, 0.5], P({ temperature: -50 }));
    expect(cool).toEqual([expect.closeTo(0.432, 3), expect.closeTo(0.51, 3), expect.closeTo(0.5753, 3)]);
    const mag = px([0.5, 0.5, 0.5], P({ tint: 50 }));
    expect(mag).toEqual([expect.closeTo(0.5525, 3), expect.closeTo(0.477, 3), expect.closeTo(0.5525, 3)]);
  });

  it('exposure +50 = +1.5 EV in linear light', () => {
    expect(applyWhiteBalanceExposure([0.5, 0.5, 0.5], 0, 0, 1)[0]).toBeCloseTo(0.8009, 3);
    expect(applyWhiteBalanceExposure([0.2, 0.2, 0.2], 0, 0, -1)[0]).toBeLessThan(0.2);
  });

  it('contrast pivots on 0.5: +50 → slope 1.5, −50 → slope 0.5', () => {
    expect(px([0.75, 0.25, 0.5], P({ contrast: 50 }))).toEqual([expect.closeTo(0.875, 6), expect.closeTo(0.125, 6), expect.closeTo(0.5, 6)]);
    expect(px([0.75, 0.25, 0.5], P({ contrast: -50 }))).toEqual([expect.closeTo(0.625, 6), expect.closeTo(0.375, 6), expect.closeTo(0.5, 6)]);
  });

  it('brightness is a mid-tone gamma: black and white stay, 0.5 → 0.633 at +50', () => {
    const o = applyBrightnessContrast([0, 0.5, 1], 1, 0);
    expect(o).toEqual([0, expect.closeTo(0.633, 3), 1]);
  });

  it('shadows lift the darks more than the brights; highlights the opposite', () => {
    const sh = P({ shadows: 50 });
    expect(px([0.3, 0.3, 0.3], sh)[0] - 0.3).toBeGreaterThan(px([0.8, 0.8, 0.8], sh)[0] - 0.8);
    const hi = P({ highlights: -50 });
    expect(0.8 - px([0.8, 0.8, 0.8], hi)[0]).toBeGreaterThan(0.3 - px([0.3, 0.3, 0.3], hi)[0]);
    // whites move white, blacks move black
    expect(px([1, 1, 1], P({ whites: -50 }))[0]).toBeCloseTo(1 - K.WHITES, 6);
    expect(px([0, 0, 0], P({ blacks: 50 }))[0]).toBeCloseTo(K.BLACKS, 6);
  });

  it('fade lifts black to 0.2 and pulls white to 0.9 at 100', () => {
    const p = P({ fade: 100 });
    expect(px([0, 0, 0], p)[0]).toBeCloseTo(0.2, 6);
    expect(px([1, 1, 1], p)[0]).toBeCloseTo(0.9, 6);
  });

  it('look grayscale (Filters) uses the CSS matrix', () => {
    const o = px([1, 0, 0], P({ grayscale: 1 }));
    expect(o).toEqual([expect.closeTo(0.2126, 6), expect.closeTo(0.2126, 6), expect.closeTo(0.2126, 6)]);
  });

  it('vignette darkens corners only; grain is deterministic', () => {
    expect(vignetteFactor(0.5, 0.5, 1)).toBe(1);
    expect(vignetteFactor(0, 0, 1)).toBeCloseTo(1 - K.VIGNETTE, 6);
    expect(hash3(1, 2, 3)).toBe(hash3(1, 2, 3));
    expect(hash3(1, 2, 3)).not.toBe(hash3(1, 2, 4));
    for (let i = 0; i < 100; i++) {
      const h = hash3(i, i * 7, 99);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});

describe('HSL', () => {
  it('range weights partition unity and are exact on the centres', () => {
    for (let h = 0; h < 360; h += 7) expect(hslWeights(h).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(hslWeights(0)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(hslWeights(240)[5]).toBe(1);
    expect(hslWeights(15)[0]).toBeCloseTo(0.5);
    expect(hslWeights(330)[7]).toBeCloseTo(0.5);
    expect(hslWeights(330)[0]).toBeCloseTo(0.5);
  });

  it('red saturation −100 greys red but leaves blue and grey alone', () => {
    const p = P({}, (g) => (g.hsl.bands.red.saturation = -100));
    const r = px([0.9, 0.1, 0.1], p);
    expect(Math.max(...r) - Math.min(...r)).toBeLessThan(1e-6);
    expect(px([0.1, 0.2, 0.9], p)).toEqual([expect.closeTo(0.1, 6), expect.closeTo(0.2, 6), expect.closeTo(0.9, 6)]);
    expect(px([0.4, 0.4, 0.4], p)).toEqual([0.4, 0.4, 0.4]);
  });

  it('red hue +100 rotates red 30° towards orange', () => {
    const o = px([1, 0, 0], P({}, (g) => (g.hsl.bands.red.hue = 100)));
    expect(o[0]).toBeCloseTo(1, 4);
    expect(o[1]).toBeCloseTo(0.5, 4);
    expect(o[2]).toBeCloseTo(0, 4);
  });
});

describe('curves', () => {
  const isMonotone = (t: Float32Array, dir: 1 | -1) => t.every((v, i) => i === 0 || (v - t[i - 1]!) * dir >= -1e-7);

  it('identity points give the identity', () => {
    const t = bakeCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    t.forEach((v, i) => expect(v).toBeCloseTo(i / 255, 6));
  });

  it('interpolates through every point and stays monotone (no overshoot)', () => {
    const pts: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.2, y: 0.05 },
      { x: 0.25, y: 0.6 },
      { x: 0.6, y: 0.62 },
      { x: 0.9, y: 0.99 },
      { x: 1, y: 1 },
    ];
    const f = monotoneCurve(pts);
    for (const p of pts) expect(f(p.x)).toBeCloseTo(p.y, 9);
    const t = bakeCurve(pts);
    expect(isMonotone(t, 1)).toBe(true);
    // flat segment stays flat-ish and never exceeds its neighbours
    for (let i = Math.ceil(0.25 * 255); i <= Math.floor(0.6 * 255); i++) {
      expect(t[i]!).toBeGreaterThanOrEqual(0.6 - 1e-6);
      expect(t[i]!).toBeLessThanOrEqual(0.62 + 1e-6);
    }
  });

  it('random monotone point sets always bake monotone tables', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 50; n++) {
      const xs = [0, ...Array.from({ length: 4 }, rnd).sort(), 1];
      const ys = [0, ...Array.from({ length: 4 }, rnd).sort(), 1];
      expect(isMonotone(bakeCurve(xs.map((x, i) => ({ x, y: ys[i]! }))), 1)).toBe(true);
      const down = bakeCurve(xs.map((x, i) => ({ x, y: 1 - ys[i]! })));
      expect(isMonotone(down, -1)).toBe(true);
    }
  });

  it('normalizes unsorted / out-of-range points and adds the ends', () => {
    expect(normalizeCurve([{ x: 0.5, y: 2 }, { x: -1, y: 0.2 }])).toEqual([
      { x: 0, y: 0.2 },
      { x: 0.5, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it('an inverting master curve inverts; R/G/B run after the master', () => {
    const g = defaultGrade().curves;
    g.master = [{ x: 0, y: 1 }, { x: 1, y: 0 }];
    const p = P({}, (gr) => (gr.curves = g));
    const o = px([0.2, 0.5, 0.9], p);
    expect(o[0]).toBeCloseTo(0.8, 2);
    expect(o[1]).toBeCloseTo(0.5, 2);
    expect(o[2]).toBeCloseTo(0.1, 2);
    g.red = [{ x: 0, y: 0 }, { x: 1, y: 0.5 }];
    const t = bakeCurvesTable(g);
    expect(t[0]).toBe(128); // red: master(0)=1 → red(1)=0.5
    expect(t[1]).toBe(255);
  });
});

describe('.cube LUTs', () => {
  it('a generated identity LUT parses to the identity', () => {
    const lut = parseCube(identityCube(17));
    expect(lut.size).toBe(17);
    expect(lut.title).toBe('Identity');
    expect(lut.data.length).toBe(17 ** 3 * 3);
    // the grid itself, red fastest
    expect([lut.data[3], lut.data[4], lut.data[5]]).toEqual([1 / 16, 0, 0].map((v) => expect.closeTo(v, 6)));
    expect(lut.data[17 * 3 + 1]).toBeCloseTo(1 / 16, 6);
    for (const c of [
      [0, 0, 0],
      [1, 1, 1],
      [0.123, 0.456, 0.789],
      [0.5, 0.25, 1],
    ] as [number, number, number][]) {
      const o = sampleLut(lut, ...c);
      o.forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 5));
    }
  });

  it('trilinear interpolation is exact for an affine LUT', () => {
    const lut = parseCube(writeCube(5, (r, g, b) => [1 - r, (g + b) / 2, 0.25 + 0.5 * b]));
    const o = sampleLut(lut, 0.33, 0.71, 0.18);
    expect(o[0]).toBeCloseTo(0.67, 5);
    expect(o[1]).toBeCloseTo(0.445, 5);
    expect(o[2]).toBeCloseTo(0.34, 5);
  });

  it('honours comments, DOMAIN_MIN/MAX and 1D LUTs', () => {
    const t = '# hi\nTITLE "x"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1 # end\n';
    const lut = parseCube(t);
    expect(sampleLut(lut, 1, 1, 1)).toEqual([0.5, 0.5, 0.5]);
    const one = parseCube('LUT_1D_SIZE 2\n0 0 0\n0.5 1 1\n');
    expect(one.size).toBe(33);
    const o = sampleLut(one, 1, 0.5, 0);
    expect(o).toEqual([expect.closeTo(0.5, 5), expect.closeTo(0.5, 5), expect.closeTo(0, 5)]);
  });

  it('rejects broken files', () => {
    expect(() => parseCube('hello')).toThrow(CubeParseError);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/Expected 8/);
    expect(() => parseCube('LUT_3D_SIZE 2\n' + '0 x 0\n'.repeat(8))).toThrow(/not a number/);
  });

  it('an identity LUT at full intensity changes no pixel; intensity mixes', () => {
    const lut = parseCube(identityCube(9));
    const p = P({}, (g) => (g.lut.lutId = 'id'));
    const c: [number, number, number] = [0.3, 0.6, 0.9];
    gradePixel(c, p, { ...env, lut }).forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 5));
    const inv = parseCube(writeCube(3, (r, g, b) => [1 - r, 1 - g, 1 - b]));
    const half = P({}, (g) => {
      g.lut.lutId = 'inv';
      g.lut.intensity = 0.5;
    });
    gradePixel(c, half, { ...env, lut: inv }).forEach((v) => expect(v).toBeCloseTo(0.5, 5));
  });

  it('protect skin tone keeps skin closer to the original', () => {
    const inv = parseCube(writeCube(3, (r, g, b) => [1 - r, 1 - g, 1 - b]));
    const skin: [number, number, number] = [0.85, 0.62, 0.5];
    const on = gradePixel(skin, P({}, (g) => Object.assign(g.lut, { lutId: 'i', protectSkin: true })), { ...env, lut: inv });
    const off = gradePixel(skin, P({}, (g) => Object.assign(g.lut, { lutId: 'i' })), { ...env, lut: inv });
    expect(Math.abs(on[0] - skin[0])).toBeLessThan(Math.abs(off[0] - skin[0]) / 2);
  });
});

describe('colour wheels', () => {
  it('neutral wheels → no pass; chroma vectors have zero luma', () => {
    expect(gradeParams(ops())).toBeNull();
    const v = wheelChroma({ x: 0.3, y: -0.8 });
    expect(luma(v)).toBeCloseTo(0, 9);
    expect(wheelChroma({ x: 1, y: 0 })[0]).toBeGreaterThan(0); // 0° = red
  });

  it('lift luma raises black, keeps white; gain luma scales white; offset shifts all', () => {
    const lift = P({}, (g) => (g.wheels.lift.luma = 100));
    expect(px([0, 0, 0], lift)[0]).toBeCloseTo(K.WHEEL_LIFT_LUMA, 6);
    expect(px([1, 1, 1], lift)[0]).toBeCloseTo(1, 6);
    const gain = P({}, (g) => (g.wheels.gain.luma = -100));
    expect(px([1, 1, 1], gain)[0]).toBeCloseTo(1 - K.WHEEL_GAIN_LUMA, 6);
    expect(px([0, 0, 0], gain)[0]).toBe(0);
    const gamma = P({}, (g) => (g.wheels.gamma.luma = 100));
    expect(px([0.5, 0.5, 0.5], gamma)[0]).toBeCloseTo(Math.pow(0.5, Math.pow(2, -K.WHEEL_GAMMA_LUMA)), 6);
    const off = P({}, (g) => (g.wheels.offset = { x: 1, y: 0, luma: 0 }));
    const o = px([0.5, 0.5, 0.5], off);
    expect(o[0]).toBeGreaterThan(0.5);
    expect(o[1]).toBeLessThan(0.5);
  });
});

describe('mask', () => {
  const m = (patch: Partial<ColorGrade['mask']>) => maskParams({ ...defaultGrade().mask, feather: 0, ...patch })!;

  it('circle: inside 1, outside 0, invert swaps; feather is soft', () => {
    const c = m({ shape: 'circle', width: 0.5, height: 0.5 });
    expect(maskAlpha(c, 0.5, 0.5, 1)).toBe(1);
    expect(maskAlpha(c, 0.95, 0.5, 1)).toBe(0);
    expect(maskAlpha(m({ shape: 'circle', invert: true }), 0.5, 0.5, 1)).toBe(0);
    const soft = m({ shape: 'circle', width: 0.5, height: 0.5, feather: 40 });
    const edge = maskAlpha(soft, 0.75, 0.5, 1);
    expect(edge).toBeGreaterThan(0.2);
    expect(edge).toBeLessThan(0.8);
  });

  it('linear keeps the top half, mirror a band, rectangle a box, rotation turns them', () => {
    const lin = m({ shape: 'linear' });
    expect(maskAlpha(lin, 0.5, 0.2, 1)).toBe(1);
    expect(maskAlpha(lin, 0.5, 0.8, 1)).toBe(0);
    const mir = m({ shape: 'mirror', height: 0.2 });
    expect(maskAlpha(mir, 0.1, 0.5, 1)).toBe(1);
    expect(maskAlpha(mir, 0.1, 0.8, 1)).toBe(0);
    const rect = m({ shape: 'rectangle', width: 0.4, height: 0.2 });
    expect(maskAlpha(rect, 0.65, 0.5, 2)).toBe(1);
    expect(maskAlpha(rect, 0.5, 0.65, 2)).toBe(0);
    const rot = m({ shape: 'linear', rotation: 90 });
    expect(maskAlpha(rot, 0.2, 0.5, 1)).not.toBe(maskAlpha(rot, 0.8, 0.5, 1));
  });

  it('the mask limits the whole adjustment', () => {
    const p = P({ saturation: -50 }, (g) => Object.assign(g.mask, { shape: 'circle', width: 0.4, height: 0.4, feather: 0 }));
    const red: [number, number, number] = [1, 0, 0];
    expect(gradePixel(red, p, { u: 0.5, v: 0.5, aspect: 1 })[1]).toBeCloseTo(0.2126, 5);
    expect(gradePixel(red, p, { u: 0.05, v: 0.05, aspect: 1 })).toEqual(red);
  });
});

describe('gradeImageData (CPU path)', () => {
  it('matches gradePixel pixel for pixel', () => {
    const w = 4;
    const h = 2;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([i * 30, 255 - i * 20, (i * 70) % 256, 255], i * 4);
    const src = data.slice();
    const p = P({ temperature: 20, contrast: 10, vignette: 50 });
    gradeImageData(data, w, h, p);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const want = gradePixel([src[o]! / 255, src[o + 1]! / 255, src[o + 2]! / 255], p, { u: (x + 0.5) / w, v: (y + 0.5) / h, aspect: w / h });
        expect(data[o]).toBe(Math.round(want[0] * 255));
        expect(data[o + 2]).toBe(Math.round(want[2] * 255));
        expect(data[o + 3]).toBe(255);
      }
  });
});
