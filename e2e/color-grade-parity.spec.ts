/**
 * Adjust › Color (DaVinci-style page): the WebGL2 shader matches the CPU reference
 * (engine/color/colorStage.ts via math.ts gradePixel) on a synthetic test card, for every stage of
 * the Color page and for the colour wheels' Lum Mix. Same harness as tab-adjust.spec.ts.
 */
import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

test('Color page: WebGL2 shader = CPU reference, stage by stage', async ({ page }) => {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oeColorLab);
  const result = await page.evaluate(() => {
    const { color, defaults } = (window as any).__oeColorLab;
    const W = 64;
    const H = 32;
    const src = document.createElement('canvas');
    src.width = W;
    src.height = H;
    const sctx = src.getContext('2d')!;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const grey = y >= 28;
        sctx.fillStyle = grey ? `rgb(${(x * 4) | 0},${(x * 4) | 0},${(x * 4) | 0})` : `hsl(${(x / W) * 360} ${30 + (y % 7) * 10}% ${12 + y * 2.6}%)`;
        sctx.fillRect(x, y, 1, 1);
      }
    const ops = (mut: (g: any) => void) => {
      const g = defaults.defaultGrade();
      mut(g);
      return { ...defaults.defaultAdjust(), grayscale: 0, sepia: 0, grade: g };
    };
    const cases: [string, any][] = [
      ['contrast/pivot', ops((g) => Object.assign(g.color.primaries, { contrast: 1.6, pivot: 0.4 }))],
      ['low contrast', ops((g) => Object.assign(g.color.primaries, { contrast: 0.5 }))],
      ['temp/tint', ops((g) => Object.assign(g.color.primaries, { temp: 1500, tint: -40 }))],
      ['sat/hue/boost', ops((g) => Object.assign(g.color.primaries, { saturation: 70, hue: 62, colorBoost: 60 }))],
      ['shadows/highlights', ops((g) => Object.assign(g.color.primaries, { shadows: 60, highlights: -50 }))],
      ['midtone detail', ops((g) => Object.assign(g.color.primaries, { midDetail: 70 }))],
      ['lum mix wheels', ops((g) => { g.wheels.lift = { x: 0.3, y: 0.2, luma: 20 }; g.wheels.gain = { x: -0.2, y: 0.1, luma: -25 }; g.wheels.gamma = { x: 0, y: 0.3, luma: 15 }; g.color.primaries.lumMix = 70; })],
      ['log wheels', ops((g) => { g.color.logWheels.shadow = { x: 0.5, y: -0.3, luma: 10 }; g.color.logWheels.midtone = { x: -0.2, y: 0.4, luma: 0 }; g.color.logWheels.highlight = { x: 0.1, y: 0.6, luma: -20 }; })],
      ['hsl curves', ops((g) => Object.assign(g.color.hslCurves, {
        hueHue: [{ x: 0, y: 0.5 }, { x: 0.33, y: 0.62 }, { x: 0.66, y: 0.45 }],
        hueSat: [{ x: 0.05, y: 0.9 }, { x: 0.5, y: 0.2 }],
        hueLum: [{ x: 0.6, y: 0.3 }, { x: 0.9, y: 0.6 }],
        lumSat: [{ x: 0, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.7 }],
        satSat: [{ x: 0.2, y: 0.7 }, { x: 0.8, y: 0.4 }],
      }))],
      ['qualifier', ops((g) => Object.assign(g.color.qualifier, { enabled: true, hue: { on: true, center: 200, width: 60, soft: 30 }, correction: { exposure: 0.6, contrast: 1.2, saturation: 160, hue: 30, temp: -800, tint: 10 } }))],
      ['qualifier matte + window', ops((g) => Object.assign(g.color.qualifier, { enabled: true, showMatte: true, sat: { on: true, low: 30, high: 80, soft: 15 }, lum: { on: true, low: 20, high: 70, soft: 10 }, cleanBlack: 10, window: { ...g.color.qualifier.window, shape: 'circle', width: 0.6, height: 0.8, feather: 40 } }))],
      ['cst logc3', ops((g) => (g.color.cst.input = 'arri-logc3'))],
      ['cst slog3', ops((g) => (g.color.cst.input = 'sony-slog3'))],
      ['cst vlog', ops((g) => (g.color.cst.input = 'pana-vlog'))],
      ['cst 709→log', ops((g) => (g.color.cst.input = 'rec709-to-log'))],
    ];
    const gl = color.createColorGrader();
    const cpu = new color.CpuGrader();
    const read = (img: CanvasImageSource) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const x = c.getContext('2d')!;
      x.drawImage(img, 0, 0, W, H);
      return x.getImageData(0, 0, W, H).data;
    };
    const base = read(src);
    const out: { name: string; max: number; mean: number; changed: number }[] = [];
    for (const [name, o] of cases) {
      const params = color.gradeParams(o, 3);
      if (!params) {
        out.push({ name, max: -1, mean: -1, changed: 0 });
        continue;
      }
      const req = { source: src, sourceWidth: W, sourceHeight: H, crop: { x: 0, y: 0, w: 1, h: 1 }, outWidth: W, outHeight: H, aspect: W / H, params };
      const a = read(gl.grade(req));
      const b = read(cpu.grade(req));
      let max = 0;
      let sum = 0;
      let changed = 0;
      for (let i = 0; i < a.length; i += 4)
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(a[i + k]! - b[i + k]!);
          max = Math.max(max, d);
          sum += d;
          changed = Math.max(changed, Math.abs(a[i + k]! - base[i + k]!));
        }
      out.push({ name, max, mean: sum / ((a.length / 4) * 3), changed });
    }
    // neutral Color page → no pass at all
    const neutral = color.gradeParams(ops(() => undefined), 0);
    const kind = gl.kind;
    gl.dispose();
    return { kind, out, neutral };
  });
  console.log(`[color-parity] GPU (${result.kind}) vs CPU:\n${result.out.map((r) => `  ${r.name}: max=${r.max} mean=${r.mean.toFixed(3)} (changes the card by up to ${r.changed})`).join('\n')}`);
  expect(result.kind).toBe('webgl2');
  expect(result.neutral).toBeNull();
  for (const r of result.out) {
    expect(r.max, `${r.name} produced params`).toBeGreaterThanOrEqual(0);
    expect(r.changed, `${r.name} changes pixels`).toBeGreaterThan(4);
    expect(r.mean, r.name).toBeLessThan(0.6);
    expect(r.max, r.name).toBeLessThanOrEqual(3);
  }
});
