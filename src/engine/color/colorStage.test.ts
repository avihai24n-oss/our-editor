/**
 * Adjust › Color maths (engine/color/colorStage.ts, hslCurves.ts, scopes.ts, the wheels' Lum Mix)
 * and the ColorPage model / migration. Neutral must be the identity; known transforms land where
 * they must.
 */
import { describe, expect, it } from 'vitest';
import { defaultColorPage, migrateColorPage, normalizeColorPage, type ColorPage } from '../../model/colorPage';
import { createAsset, createClipFromAsset, defaultAdjust, defaultGrade } from '../../model/defaults';
import type { Clip, ColorGrade, VideoClip } from '../../model/types';
import { qualifierFromPick } from '../../player/color/qualifierPick';
import { addPoint } from '../../inspector/tabs/color/HslCurvesSection';
import { BUILT_IN_LOOKS } from '../../inspector/tabs/color/looks';
import {
  applyColorStage,
  applyCst,
  colorStageParams,
  contrastPivot,
  hueMatrix,
  applyMat,
  kelvinRgb,
  logc3Decode,
  logc3Encode,
  qualMatte,
  satMatrix,
  slog3Decode,
  vlogDecode,
  wbGains,
} from './colorStage';
import { bakeHslCurves, hslCurveFn, sampleHueRow } from './hslCurves';
import { gradePixel, luma, rgbToHsv } from './math';
import { gradeParams, type GradeParams, type Vec3 } from './params';
import { computeScopes, lumaCode, vectorPos, VECTOR_SIZE } from './scopes';

const env = { u: 0.5, v: 0.5, aspect: 16 / 9, detail: 0 };
const page = (mut: (p: ColorPage) => void = () => undefined): ColorPage => {
  const p = defaultColorPage();
  mut(p);
  return p;
};
const ops = (mut: (g: ColorGrade) => void = () => undefined) => {
  const g = defaultGrade();
  mut(g);
  return { ...defaultAdjust(), grayscale: 0, sepia: 0, grade: g };
};
const P = (mut: (g: ColorGrade) => void): GradeParams => gradeParams(ops(mut), 0)!;
const stage = (c: Vec3, mut: (p: ColorPage) => void) => applyColorStage(c, colorStageParams(page(mut))!, env);
const close = (a: readonly number[], b: readonly number[], d = 5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, d));

const SAMPLES: Vec3[] = [
  [0, 0, 0],
  [1, 1, 1],
  [0.5, 0.5, 0.5],
  [0.8, 0.2, 0.1],
  [0.1, 0.6, 0.9],
  [0.3, 0.7, 0.2],
];

describe('neutral Color page = identity', () => {
  it('default page → no params, no colour pass at all', () => {
    expect(colorStageParams(defaultColorPage())).toBeNull();
    expect(gradeParams(ops(), 0)).toBeNull();
  });
  it('disabled page / sections are neutral even with values set', () => {
    expect(colorStageParams(page((p) => Object.assign(p, { enabled: false, cst: { input: 'arri-logc3' } })))).toBeNull();
    expect(colorStageParams(page((p) => Object.assign(p.primaries, { enabled: false, contrast: 1.7, saturation: 0 })))).toBeNull();
    expect(colorStageParams(page((p) => Object.assign(p.hslCurves, { enabled: false, hueSat: [{ x: 0.5, y: 0 }] })))).toBeNull();
  });
  it('flat HSL curve points (y = 0.5) and a qualifier with a neutral correction change nothing', () => {
    expect(colorStageParams(page((p) => (p.hslCurves.hueHue = [{ x: 0.2, y: 0.5 }, { x: 0.7, y: 0.5 }])))).toBeNull();
    expect(colorStageParams(page((p) => (p.qualifier.enabled = true)))).toBeNull();
  });
  it('Lum Mix alone changes nothing (only how wheel masters act)', () => {
    expect(gradeParams(ops((g) => (g.color.primaries.lumMix = 0)), 0)).toBeNull();
  });
});

describe('primaries', () => {
  it('contrast/pivot power curve keeps 0, pivot and 1, slope c at the pivot', () => {
    for (const c of [0.5, 1, 1.6]) {
      expect(contrastPivot(0, c, 0.435)).toBe(0);
      expect(contrastPivot(1, c, 0.435)).toBeCloseTo(1, 9);
      expect(contrastPivot(0.435, c, 0.435)).toBeCloseTo(0.435, 9);
      const e = 1e-4;
      expect((contrastPivot(0.435 + e, c, 0.435) - contrastPivot(0.435 - e, c, 0.435)) / (2 * e)).toBeCloseTo(c, 3);
    }
    for (let v = 0; v <= 1; v += 0.1) expect(contrastPivot(v, 1, 0.3)).toBeCloseTo(v, 9);
    // more contrast: darks darker, brights brighter
    const o = stage([0.2, 0.2, 0.2], (p) => (p.primaries.contrast = 1.5));
    expect(o[0]).toBeLessThan(0.2);
    expect(stage([0.8, 0.8, 0.8], (p) => (p.primaries.contrast = 1.5))[0]).toBeGreaterThan(0.8);
  });
  it('temp: Planckian whites; +K warms (R up, B down) and keeps mid grey luma', () => {
    const w65 = kelvinRgb(6500);
    expect(Math.max(...w65) / Math.min(...w65)).toBeLessThan(1.08); // 6500 K ≈ D65 white
    const warm = kelvinRgb(3200);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(wbGains(0, 0)).toBeNull();
    const g = wbGains(2000, 0)!;
    expect(g[0]).toBeGreaterThan(1);
    expect(g[2]).toBeLessThan(1);
    expect(luma(g)).toBeCloseTo(1, 9);
    const t = wbGains(0, 60)!; // + tint = magenta: G down
    expect(t[1]).toBeLessThan(1);
    expect(t[0]).toBeCloseTo(t[2], 9);
    const o = stage([0.5, 0.5, 0.5], (p) => (p.primaries.temp = 2000));
    expect(o[0]).toBeGreaterThan(0.5);
    expect(o[2]).toBeLessThan(0.5);
  });
  it('saturation 0 → Rec.709 grey; 100 doubles chroma; hue matrix keeps luma and grey', () => {
    for (const c of SAMPLES) {
      const o = stage(c, (p) => (p.primaries.saturation = 0));
      close(o, [luma(c), luma(c), luma(c)], 4);
    }
    const c: Vec3 = [0.5, 0.4, 0.45];
    const o = stage(c, (p) => (p.primaries.saturation = 100));
    const Y = luma(c);
    close(o, c.map((v) => Y + (v - Y) * 2), 4);
    close(applyMat(hueMatrix(0), [0.3, 0.6, 0.9]), [0.3, 0.6, 0.9], 9);
    close(applyMat(hueMatrix(77), [0.4, 0.4, 0.4]), [0.4, 0.4, 0.4], 3);
    close(applyMat(satMatrix(1), [0.3, 0.6, 0.9]), [0.3, 0.6, 0.9], 9);
    // hue +120°: red → green-ish
    const r = stage([0.8, 0.1, 0.1], (p) => (p.primaries.hue = 50 + 120 / 3.6));
    expect(r[1]).toBeGreaterThan(r[0]);
    expect(Math.abs(rgbToHsv(r)[0] - 120)).toBeLessThan(12);
  });
  it('color boost raises low-saturation colours more than saturated ones', () => {
    const lo: Vec3 = [0.55, 0.5, 0.45];
    const hi: Vec3 = [0.9, 0.1, 0.1];
    const ch = (c: Vec3) => Math.max(...c) - Math.min(...c);
    const lo2 = stage(lo, (p) => (p.primaries.colorBoost = 80));
    const hi2 = stage(hi, (p) => (p.primaries.colorBoost = 80));
    expect(ch(lo2) / ch(lo)).toBeGreaterThan(ch(hi2) / ch(hi) + 0.3);
  });
  it('shadows lift the darks more than the brights; highlights the reverse', () => {
    const d = (c: number, mut: (p: ColorPage) => void) => stage([c, c, c], mut)[0] - c;
    expect(d(0.25, (p) => (p.primaries.shadows = 100))).toBeGreaterThan(d(0.8, (p) => (p.primaries.shadows = 100)) + 0.1);
    expect(d(0.75, (p) => (p.primaries.highlights = 100))).toBeGreaterThan(d(0.2, (p) => (p.primaries.highlights = 100)) + 0.1);
    expect(d(0, (p) => (p.primaries.shadows = 100))).toBe(0);
  });
  it('midtone detail adds the source high-pass in the mid-tones only', () => {
    const p = colorStageParams(page((x) => (x.primaries.midDetail = 100)))!;
    const o = applyColorStage([0.5, 0.5, 0.5], p, { ...env, detail: 0.05 });
    expect(o[0]).toBeCloseTo(0.55, 5);
    expect(applyColorStage([0, 0, 0], p, { ...env, detail: 0.05 })[0]).toBe(0);
  });
});

describe('Lum Mix (wheel masters)', () => {
  const lift = (lm: number) => P((g) => {
    g.wheels.lift = { x: 0, y: 0, luma: 60 };
    g.color.primaries.lumMix = lm;
  });
  it('0 = the original per-channel behaviour', () => {
    const p = lift(0);
    const c: Vec3 = [0.6, 0.2, 0.1];
    const want = c.map((v) => v + p.wheels!.lift[0] * (1 - v));
    close(gradePixel(c, p, { u: 0.5, v: 0.5, aspect: 1 }), want, 6);
  });
  it('100 = Y-only: the luma rises, the chroma differences stay', () => {
    const c: Vec3 = [0.6, 0.2, 0.1];
    const o = gradePixel(c, lift(100), { u: 0.5, v: 0.5, aspect: 1 });
    expect(luma(o)).toBeGreaterThan(luma(c) + 0.05);
    close([o[0] - o[1], o[1] - o[2]], [c[0] - c[1], c[1] - c[2]], 6);
    // greys: both modes agree
    const g: Vec3 = [0.3, 0.3, 0.3];
    close(gradePixel(g, lift(100), { u: 0.5, v: 0.5, aspect: 1 }), gradePixel(g, lift(0), { u: 0.5, v: 0.5, aspect: 1 }), 6);
  });
});

describe('log wheels', () => {
  it('a shadow wheel moves darks, leaves brights; a highlight wheel the reverse', () => {
    const sh = (c: number) => stage([c, c, c], (p) => (p.logWheels.shadow = { x: 0, y: 0, luma: 50 }))[0] - c;
    expect(sh(0.1)).toBeGreaterThan(0.1);
    expect(sh(0.9)).toBeCloseTo(0, 6);
    const hl = (c: number) => stage([c, c, c], (p) => (p.logWheels.highlight = { x: 1, y: 0, luma: 0 }));
    const b = hl(0.9);
    expect(b[0]).toBeGreaterThan(b[2] + 0.1); // pushed to red
    const d = hl(0.1);
    close(d, [0.1, 0.1, 0.1], 6);
  });
});

describe('HSL curves', () => {
  it('periodic curves wrap; one point is a constant; non-periodic are flat outside', () => {
    const f = hslCurveFn([{ x: 0.9, y: 0.8 }, { x: 0.1, y: 0.2 }], true);
    expect(f(0)).toBeCloseTo(f(1), 9);
    expect(f(0.9)).toBeCloseTo(0.8, 9);
    expect(hslCurveFn([{ x: 0.3, y: 0.7 }], true)(0.8)).toBe(0.7);
    const g = hslCurveFn([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.9 }], false);
    expect(g(0)).toBe(0.3);
    expect(g(1)).toBe(0.9);
    expect(hslCurveFn([], true)(0.4)).toBe(0.5);
  });
  it('the editor anchors new points 30° either side (hue) or at the ends (lum / sat)', () => {
    expect(addPoint([], 0.5, 0.5, true).map((p) => p.x)).toEqual([0.417, 0.5, 0.583]);
    expect(addPoint([], 0.02, 0.5, true).map((p) => p.x)).toEqual([0.02, 0.103, 0.937]);
    expect(addPoint([], 0.5, 0.4, false)).toEqual([{ x: 0, y: 0.5 }, { x: 0.5, y: 0.4 }, { x: 1, y: 0.5 }]);
  });
  it('Hue vs Sat at blue → blue goes grey, red untouched; Hue vs Hue shifts the hue', () => {
    const blueDown = (p: ColorPage) => (p.hslCurves.hueSat = addPoint([], 240 / 360, 0, true));
    const blue = stage([0.1, 0.1, 0.8], blueDown);
    expect(Math.max(...blue) - Math.min(...blue)).toBeLessThan(0.01);
    close(stage([0.8, 0.1, 0.1], blueDown), [0.8, 0.1, 0.1], 5);
    const t = bakeHslCurves({ ...defaultColorPage().hslCurves, hueHue: addPoint([], 0, 0.5 + 30 / 360, true) });
    expect(sampleHueRow(t, 0)[0]).toBeCloseTo(0.5 + 30 / 360, 3);
    const r = stage([0.8, 0.1, 0.1], (p) => (p.hslCurves.hueHue = addPoint([], 0, 0.5 + 30 / 360, true)));
    expect(rgbToHsv(r)[0]).toBeGreaterThan(20);
    expect(rgbToHsv(r)[0]).toBeLessThan(40);
  });
  it('Lum vs Sat 0 at the bottom desaturates darks only', () => {
    const mut = (p: ColorPage) => (p.hslCurves.lumSat = [{ x: 0, y: 0 }, { x: 0.4, y: 0.5 }, { x: 1, y: 0.5 }]);
    const dark = stage([0.12, 0.02, 0.02], mut);
    expect(Math.max(...dark) - Math.min(...dark)).toBeLessThan(0.02);
    close(stage([0.9, 0.6, 0.6], mut), [0.9, 0.6, 0.6], 4);
  });
});

describe('qualifier', () => {
  const q = (mut: (p: ColorPage) => void) => colorStageParams(page((p) => {
    p.qualifier.enabled = true;
    p.qualifier.correction.saturation = 0;
    mut(p);
  }))!.qual!;
  it('hue key: red in, blue out, greys out; invert flips', () => {
    const k = q((p) => Object.assign(p.qualifier, { hue: { on: true, center: 0, width: 40, soft: 10 }, sat: { ...p.qualifier.sat, on: false }, lum: { ...p.qualifier.lum, on: false } }));
    expect(qualMatte([0.8, 0.1, 0.1], k, 0.5, 0.5, 1)).toBeCloseTo(1, 6);
    expect(qualMatte([0.8, 0.1, 0.25], k, 0.5, 0.5, 1)).toBeCloseTo(1, 6); // hue ≈ 349°: inside (wraps)
    expect(qualMatte([0.1, 0.1, 0.8], k, 0.5, 0.5, 1)).toBe(0);
    expect(qualMatte([0.5, 0.5, 0.5], k, 0.5, 0.5, 1)).toBe(0);
    const inv = { ...k, invert: true };
    expect(qualMatte([0.1, 0.1, 0.8], inv, 0.5, 0.5, 1)).toBe(1);
  });
  it('luminance band and power window', () => {
    const k = q((p) => Object.assign(p.qualifier, { hue: { ...p.qualifier.hue, on: false }, sat: { ...p.qualifier.sat, on: false }, lum: { on: true, low: 40, high: 60, soft: 0 } }));
    expect(qualMatte([0.5, 0.5, 0.5], k, 0.5, 0.5, 1)).toBe(1);
    expect(qualMatte([0.2, 0.2, 0.2], k, 0.5, 0.5, 1)).toBe(0);
    const w = q((p) => Object.assign(p.qualifier, { hue: { ...p.qualifier.hue, on: false }, sat: { ...p.qualifier.sat, on: false }, lum: { ...p.qualifier.lum, on: false }, window: { ...p.qualifier.window, shape: 'circle', width: 0.4, height: 0.4, feather: 0 } }));
    expect(qualMatte([0.5, 0.2, 0.2], w, 0.5, 0.5, 1)).toBe(1);
    expect(qualMatte([0.5, 0.2, 0.2], w, 0.05, 0.05, 1)).toBe(0);
  });
  it('the correction applies inside the matte only; Show matte outputs the key', () => {
    const mut = (p: ColorPage) => Object.assign(p.qualifier, { enabled: true, hue: { on: true, center: 0, width: 40, soft: 10 }, sat: { ...p.qualifier.sat, low: 0 }, correction: { ...p.qualifier.correction, saturation: 0 } });
    const red = stage([0.8, 0.1, 0.1], mut);
    expect(Math.max(...red) - Math.min(...red)).toBeLessThan(1e-6);
    close(stage([0.1, 0.1, 0.8], mut), [0.1, 0.1, 0.8], 9);
    const m = stage([0.8, 0.1, 0.1], (p) => {
      mut(p);
      p.qualifier.showMatte = true;
    });
    close(m, [1, 1, 1], 6);
  });
  it('eyedropper: picks hue / sat / lum around the colour; Shift widens to include a second one', () => {
    const base = defaultColorPage().qualifier;
    const a = qualifierFromPick([0.8, 0.1, 0.1], base, false);
    expect(a.enabled).toBe(true);
    expect(a.hue.center).toBeCloseTo(0, 1);
    const k = colorStageParams({ ...defaultColorPage(), qualifier: { ...a, correction: { ...a.correction, saturation: 0 } } })!.qual!;
    expect(qualMatte([0.8, 0.1, 0.1], k, 0.5, 0.5, 1)).toBeCloseTo(1, 6);
    const b = qualifierFromPick([0.8, 0.5, 0.1], a, true); // orange ≈ 35°
    expect(b.hue.width).toBeGreaterThan(a.hue.width);
    const kb = colorStageParams({ ...defaultColorPage(), qualifier: { ...b, correction: { ...b.correction, saturation: 0 } } })!.qual!;
    expect(qualMatte([0.8, 0.5, 0.1], kb, 0.5, 0.5, 1)).toBeGreaterThan(0.9);
    expect(qualMatte([0.8, 0.1, 0.1], kb, 0.5, 0.5, 1)).toBeGreaterThan(0.9);
    const grey = qualifierFromPick([0.5, 0.5, 0.5], base, false);
    expect(grey.hue.on).toBe(false);
  });
});

describe('colour space transform', () => {
  it('log curves: 18 % grey code values and round trips', () => {
    expect(logc3Encode(0.18)).toBeCloseTo(0.391, 3);
    expect(logc3Decode(logc3Encode(0.18))).toBeCloseTo(0.18, 6);
    expect(logc3Decode(logc3Encode(0.001))).toBeCloseTo(0.001, 6);
    expect(slog3Decode(420 / 1023)).toBeCloseTo(0.18, 4);
    expect(vlogDecode(0.423)).toBeCloseTo(0.18, 2);
  });
  it('LogC3 grey decodes to a mid grey; 709 → log flattens contrast', () => {
    const g = applyCst([0.391, 0.391, 0.391], 1);
    expect(g[0]).toBeGreaterThan(0.4);
    expect(g[0]).toBeLessThan(0.5);
    close(g, [g[0], g[0], g[0]], 3); // neutral stays neutral through the gamut matrix
    const dark = applyCst([0.05, 0.05, 0.05], 4)[0];
    const bright = applyCst([0.95, 0.95, 0.95], 4)[0];
    expect(dark).toBeGreaterThan(0.05);
    expect(bright).toBeLessThan(0.95);
  });
});

describe('built-in looks', () => {
  it('every look changes the picture and keeps the CST / qualifier / Lum Mix of the clip', () => {
    const base = page((p) => {
      p.cst.input = 'sony-slog3';
      p.primaries.lumMix = 0;
    });
    for (const l of BUILT_IN_LOOKS) {
      const p = l.build(base);
      expect(p.cst.input).toBe('sony-slog3');
      expect(p.primaries.lumMix).toBe(0);
      const sp = colorStageParams({ ...p, cst: { input: 'none' } });
      expect(sp, l.id).not.toBeNull();
    }
  });
});

describe('ColorPage model + migration', () => {
  const clip = (): VideoClip => {
    const a = createAsset({ kind: 'video', name: 'v', mime: 'video/mp4', size: 1, duration: 1e6, width: 2, height: 2, hasAudio: false });
    return createClipFromAsset(a, 't', 0) as VideoClip;
  };
  it('new clips: neutral page, Lum Mix 100', () => {
    const c = clip();
    expect(c.grade.color).toEqual(defaultColorPage());
    expect(c.grade.color.primaries.lumMix).toBe(100);
    expect(migrateColorPage(c)).toBe(c);
  });
  it('a clip saved before the Color page gets it with Lum Mix 0 (its wheels render as before)', () => {
    const c = clip();
    const { color: _c, ...old } = c.grade;
    const legacy = { ...c, grade: old } as unknown as Clip;
    const m = migrateColorPage(legacy) as VideoClip;
    expect(m.grade.color.primaries.lumMix).toBe(0);
    expect({ ...m.grade.color, primaries: { ...m.grade.color.primaries, lumMix: 100 } }).toEqual(defaultColorPage());
    expect(migrateColorPage(m)).toBe(m);
    // same pixels as before for a legacy wheel grade
    const g = { ...m.grade, wheels: { ...m.grade.wheels, gain: { x: 0.3, y: 0.1, luma: 40 } } };
    const p = gradeParams({ ...defaultAdjust(), grayscale: 0, sepia: 0, grade: g }, 0)!;
    expect(p.wheels!.lumMix).toBe(0);
  });
  it('normalize clamps garbage and fills partial pages', () => {
    const n = normalizeColorPage({ primaries: { contrast: 9, saturation: 'x' }, hslCurves: { hueSat: [{ x: 2, y: -1 }, null, { x: 0.5 }] }, cst: { input: 'nope' }, qualifier: { window: { shape: 'heart' } } });
    expect(n.primaries.contrast).toBe(2);
    expect(n.primaries.saturation).toBe(50);
    expect(n.hslCurves.hueSat).toEqual([{ x: 1, y: 0 }]);
    expect(n.cst.input).toBe('none');
    expect(n.qualifier.window.shape).toBe('none');
    expect(n.primaries.lumMix).toBe(100);
    const partial = migrateColorPage({ ...clip(), grade: { ...clip().grade, color: { primaries: { contrast: 1.4 } } } } as unknown as Clip) as VideoClip;
    expect(partial.grade.color.primaries.contrast).toBe(1.4);
    expect(partial.grade.color.qualifier).toEqual(defaultColorPage().qualifier);
  });
});

describe('scopes', () => {
  it('waveform / parade / histogram / vectorscope of a known picture', () => {
    // 4 × 2: grey 128, red, green, blue / black, white, yellow, 75 % grey
    const px: number[][] = [
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255],
      [0, 0, 0], [255, 255, 255], [255, 255, 0], [191, 191, 191],
    ];
    const data = new Uint8ClampedArray(px.flatMap((p) => [...p, 255]));
    const d = computeScopes(data, 4, 2);
    expect(d.cols).toBe(4);
    expect(d.stats.pixels).toBe(8);
    expect(d.stats.y.min).toBe(0);
    expect(d.stats.y.max).toBe(255);
    // column 1 holds red (Y 54) and white (Y 255)
    expect(d.waveY[1 * 256 + lumaCode(255, 0, 0)]).toBe(1);
    expect(d.waveY[1 * 256 + 255]).toBe(1);
    expect(d.waveR[1 * 256 + 255]).toBe(2);
    expect(d.waveB[1 * 256 + 0]).toBe(1);
    expect(d.histY[128]).toBe(1);
    expect(d.histR[255]).toBe(3);
    // neutral colours sit in the vectorscope centre; red at its target
    const V = VECTOR_SIZE;
    const centre = d.vector[Math.floor(V / 2) * V + Math.floor(V / 2)]!;
    expect(centre).toBe(4); // grey, black, white, 75 % grey
    const [rx, ry] = vectorPos(1, 0, 0);
    expect(d.vector[Math.min(V - 1, Math.floor(ry)) * V + Math.min(V - 1, Math.floor(rx))]).toBe(1);
    // reuse: same buffers, cleared
    const again = computeScopes(data, 4, 2, d);
    expect(again.waveY).toBe(d.waveY);
    expect(again.histR[255]).toBe(3);
  });
});
