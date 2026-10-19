/**
 * Inspector › Adjust, end to end in real Chromium: the colour pass is checked on the PIXELS of
 * the preview canvas and of the exported MP4 (ffmpeg-decoded), on SMPTE bars with known colours.
 *
 *  - Saturation −50 (the minimum) → every bar is grey (R ≈ G ≈ B).
 *  - Temp +50 → the grey bar gets warmer (R up, B down).
 *  - An identity .cube LUT changes nothing; an R↔B swap LUT turns the red bar blue.
 *  - Curves: dragging the black point to the top and the white point to the bottom inverts.
 *  - The adjustments survive a reload (IndexedDB autosave + migration).
 *  - Export → the same pixels as the preview within a codec tolerance.
 *
 * Store reads use the dev-only handle window.__oe; window.__oeColor() says which colour pass
 * the player uses ('webgl2' expected).
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectConsoleErrors, ffprobe, importMedia, MEDIA, openApp, pressShortcut, screenshot, waitForDownload } from './helpers';

type RGB = [number, number, number];

/** SMPTE bars (ffmpeg smptebars): 7 top bars at 75 %: grey, yellow, cyan, green, magenta, red, blue. */
const BARS = ['grey', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue'] as const;
const POINTS: [number, number][] = BARS.map((_, i) => [(i + 0.5) / 7, 0.3]);
const T_US = 1_000_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(here, 'test-results', 'tab-adjust');

function writeCube(file: string, size: number, fn: (r: number, g: number, b: number) => RGB): string {
  const lines = [`TITLE "${path.basename(file)}"`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) lines.push(fn(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(' '));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

async function samplePreview(page: Page): Promise<RGB[]> {
  return page.evaluate((pts) => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="player-canvas"]')!;
    const ctx = c.getContext('2d')!;
    return pts.map(([fx, fy]) => {
      const x = Math.floor(fx * c.width) - 2;
      const y = Math.floor(fy * c.height) - 2;
      const d = ctx.getImageData(x, y, 5, 5).data;
      const s = [0, 0, 0];
      for (let i = 0; i < 25; i++) for (let k = 0; k < 3; k++) s[k]! += d[i * 4 + k]!;
      return s.map((v) => Math.round(v / 25)) as [number, number, number];
    });
  }, POINTS);
}

/** Decodes one frame of the MP4 with ffmpeg and samples the same points. */
function sampleVideo(file: string, tSec: number): RGB[] {
  const p = ffprobe(file);
  const w = p.width!;
  const h = p.height!;
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(tSec), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return POINTS.map(([fx, fy]) => {
    const cx = Math.floor(fx * w);
    const cy = Math.floor(fy * h);
    const s = [0, 0, 0];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) for (let k = 0; k < 3; k++) s[k]! += buf[((cy + dy) * w + (cx + dx)) * 3 + k]!;
    return s.map((v) => Math.round(v / 25)) as RGB;
  });
}

const maxDiff = (a: RGB[], b: RGB[]) => Math.max(...a.flatMap((c, i) => c.map((v, k) => Math.abs(v - b[i]![k]!))));
const fmt = (s: RGB[]) => s.map((c, i) => `${BARS[i]}=${c.join(',')}`).join('  ');

const st = (page: Page) => ({
  clip: () => page.evaluate(() => (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips)[0]),
});

/** Waits until the preview, after a change, settles on new pixels that pass `ok`. */
async function settle(page: Page, ok: (s: RGB[]) => boolean, label: string): Promise<RGB[]> {
  let last: RGB[] = [];
  await expect
    .poll(
      async () => {
        last = await samplePreview(page);
        return ok(last);
      },
      { timeout: 10_000, message: `${label}: ${fmt(last)}` },
    )
    .toBe(true);
  // one more frame to be sure the canvas is final
  await page.waitForTimeout(150);
  last = await samplePreview(page);
  console.log(`[tab-adjust] ${label}: ${fmt(last)}`);
  return last;
}

async function exportMp4(page: Page): Promise<string> {
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 420_000);
  const probe = ffprobe(file);
  expect(probe.width).toBe(1280);
  expect(probe.height).toBe(720);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  return file;
}

/** The CPU reference (math.ts) applied, in the page, to RGB samples with the clip's current colour ops. */
async function gradeSamples(page: Page, samples: RGB[]): Promise<RGB[]> {
  return page.evaluate(
    ({ samples, pts }) => {
      const { color, frame } = (window as any).__oeColorLab;
      const clip = (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips)[0];
      const params = color.gradeParams(frame.colorOps(clip), 0);
      if (!params) return samples;
      return samples.map((c: number[], i: number) => {
        const o = color.gradePixel(c.map((v) => v / 255), params, { u: pts[i]![0], v: pts[i]![1], aspect: 16 / 9 });
        return o.map((v: number) => Math.round(v * 255));
      });
    },
    { samples, pts: POINTS },
  );
}

test('Adjust tab: colour pass on preview and export pixels', async ({ page }) => {
  test.setTimeout(900_000); // two exports; the shared test machine can be heavily loaded
  const errors = collectConsoleErrors(page);
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe && !!(window as any).__oeColor);

  // ---- a 16:9 project with the SMPTE bars clip, paused at 1 s, clip selected, Adjust tab open
  await importMedia(page, [MEDIA.landscape]);
  await page.evaluate((t) => {
    const s = (window as any).__oe.getState();
    s.setAspectRatio('16:9');
    const asset = Object.values(s.project.assets)[0] as any;
    const id = s.addClip(asset.id, { at: 0 });
    s.select([id]);
    s.setPlayhead(t);
  }, T_US);
  await page.getByTestId('inspector').getByRole('tab', { name: 'Adjust' }).click();
  await expect(page.getByTestId('adjust-sub-basic')).toBeVisible();

  const base = await settle(page, (s) => s[0]![0] > 120 && s[6]![2] > 120 && s[5]![0] > 120, 'baseline');
  expect(await page.evaluate(() => (window as any).__oeColor())).toBe('webgl2');
  // sanity: the bars are what we think they are
  expect(base[5]![0]).toBeGreaterThan(base[5]![2] + 80); // red
  expect(base[6]![2]).toBeGreaterThan(base[6]![0] + 80); // blue
  await screenshot(page, 'adjust-01-baseline');

  // ungraded export: the reference for "the export applies the same colour pass"
  const plainFile = await exportMp4(page);
  const plainOut = sampleVideo(plainFile, T_US / 1e6 + 1 / 60);
  console.log(`[tab-adjust] export (no adjust): ${fmt(plainOut)}  — max |export − preview| = ${maxDiff(plainOut, base)} (decoder/encoder colour, no grade involved)`);

  // ---- AI rows are disabled
  for (const r of ['auto-adjust', 'color-match', 'color-correction']) {
    await expect(page.getByTestId(`adjust-ai-${r}`).locator('input[type=checkbox]')).toBeDisabled();
  }

  // ---- Saturation −50 → grey bars
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('-50');
  expect((await st(page).clip()).adjust.saturation).toBe(-50);
  const grey = await settle(page, (s) => s.every((c) => Math.max(...c) - Math.min(...c) <= 3), 'saturation -50');
  for (const c of grey) expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(3);
  await screenshot(page, 'adjust-02-saturation');
  // undo brings the colour back
  await pressShortcut(page, 'Mod+Z');
  expect((await st(page).clip()).adjust.saturation).toBe(0);
  await settle(page, (s) => maxDiff(s, base) <= 2, 'undo saturation');

  // ---- Temp +50 → warmer
  await page.getByRole('slider', { name: 'Temp', exact: true }).fill('50');
  const warm = await settle(page, (s) => s[0]![0] > base[0]![0] + 8 && s[0]![2] < base[0]![2] - 8, 'temp +50');
  expect(warm[0]![0]).toBeGreaterThan(base[0]![0] + 8);
  expect(warm[0]![2]).toBeLessThan(base[0]![2] - 8);
  await page.getByRole('button', { name: 'Reset Adjust' }).click();
  await settle(page, (s) => maxDiff(s, base) <= 2, 'reset adjust');

  // ---- LUT: identity changes nothing, R↔B swap really applies
  const identity = writeCube(path.join(TMP, 'identity.cube'), 17, (r, g, b) => [r, g, b]);
  await page.getByTestId('lut-import-input').setInputFiles(identity);
  await expect.poll(async () => (await st(page).clip()).grade.lut.name).toBe('identity.cube');
  await page.waitForTimeout(300);
  const idLut = await settle(page, (s) => maxDiff(s, base) <= 3, 'identity LUT');
  expect(maxDiff(idLut, base)).toBeLessThanOrEqual(3);
  const swap = writeCube(path.join(TMP, 'swap-rb.cube'), 17, (r, g, b) => [b, g, r]);
  await page.getByTestId('lut-import-input').setInputFiles(swap);
  await expect.poll(async () => (await st(page).clip()).grade.lut.name).toBe('swap-rb.cube');
  const swapped = await settle(page, (s) => s[5]![2] > s[5]![0] + 60, 'swap R/B LUT');
  expect(Math.abs(swapped[5]![2] - base[5]![0])).toBeLessThanOrEqual(4); // red bar's R is now in B
  await page.getByTestId('lut-intensity').locator('input[type=range]').fill('50');
  await settle(page, (s) => Math.abs(s[5]![0] - s[5]![2]) <= 6, 'swap LUT at 50 %');
  await expect(page.getByTestId('lut-select').locator('option')).toHaveCount(4); // None, identity, swap, Import…
  await page.getByTestId('lut-select').selectOption('');
  await settle(page, (s) => maxDiff(s, base) <= 2, 'LUT none');

  // ---- Curves: drag black to the top and white to the bottom → inverted picture
  await page.getByRole('tab', { name: 'Curves' }).click();
  const svg = page.getByTestId('curve-editor');
  // keep the whole graph clear of the sticky footer
  await svg.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const box = (await svg.boundingBox())!;
  const pastBefore = await page.evaluate(() => (window as any).__oe.getState().past.length);
  await page.mouse.move(box.x + 2, box.y + box.height - 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + 2, box.y - 4, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.width - 2, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height + 6, { steps: 6 });
  await page.mouse.up();
  expect((await st(page).clip()).grade.curves.master).toEqual([
    { x: 0, y: 1 },
    { x: 1, y: 0 },
  ]);
  expect(await page.evaluate(() => (window as any).__oe.getState().past.length)).toBe(pastBefore + 2); // one undo step per drag
  const inv = await settle(page, (s) => s.every((c, i) => c.every((v, k) => Math.abs(v - (255 - base[i]![k]!)) <= 4)), 'inverted curve');
  for (let i = 0; i < 7; i++) for (let k = 0; k < 3; k++) expect(Math.abs(inv[i]![k]! - (255 - base[i]![k]!))).toBeLessThanOrEqual(4);
  await screenshot(page, 'adjust-03-inverted');

  // ---- a few more sections so the export carries a mixed grade: HSL blue → green-ish, vignette
  await page.getByRole('tab', { name: 'HSL' }).click();
  await page.getByTestId('hsl-blue').click();
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('-100');
  await page.getByRole('tab', { name: 'Basic' }).click();
  await page.getByRole('slider', { name: 'Temp', exact: true }).fill('30');
  const graded = await settle(page, (s) => maxDiff(s, inv) > 10, 'curve + HSL + temp');

  // ---- persists after reload
  await expect.poll(() => page.evaluate(() => { const s = (window as any).__oe.getState(); return !s.saveStatus.saving && !!s.saveStatus.lastSavedAt && JSON.stringify(s.project).length > 0; })).toBe(true);
  await page.waitForTimeout(2500); // autosave debounce
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oe && (window as any).__oe.getState().project.tracks.some((t: any) => t.clips.length));
  const after = await st(page).clip();
  expect(after.grade.curves.master).toEqual([
    { x: 0, y: 1 },
    { x: 1, y: 0 },
  ]);
  expect(after.grade.hsl.bands.blue.saturation).toBe(-100);
  expect(after.adjust.temperature).toBe(30);
  await page.evaluate((t) => (window as any).__oe.getState().setPlayhead(t), T_US);
  const reloaded = await settle(page, (s) => maxDiff(s, graded) <= 3, 'after reload');
  expect(maxDiff(reloaded, graded)).toBeLessThanOrEqual(3);

  // ---- export and compare the same pixels in the MP4
  const file = await exportMp4(page);
  const out = sampleVideo(file, T_US / 1e6 + 1 / 60);
  const want = await gradeSamples(page, plainOut);
  console.log(`[tab-adjust] export graded         : ${fmt(out)}`);
  console.log(`[tab-adjust] CPU grade of plain MP4 : ${fmt(want)}`);
  console.log(`[tab-adjust] preview graded         : ${fmt(reloaded)}`);
  console.log(`[tab-adjust] max |export − CPU(plain export)| = ${maxDiff(out, want)}; max |export − preview| = ${maxDiff(out, reloaded)}`);
  // the export runs the same colour pass on its own decoded frame
  expect(maxDiff(out, want)).toBeLessThanOrEqual(10);
  // and lands on the preview's pixels within codec tolerance + the ungraded decoder difference
  expect(maxDiff(out, reloaded)).toBeLessThanOrEqual(maxDiff(plainOut, base) + 12);
  // neutral (grey) bar: no decoder matrix involved → tight
  for (let k = 0; k < 3; k++) expect(Math.abs(out[0]![k]! - reloaded[0]![k]!)).toBeLessThanOrEqual(4);
  expect(maxDiff(out, inv)).toBeGreaterThan(10); // graded, not the plain inversion

  expect(errors.real()).toEqual([]);
});

test('the WebGL2 shader matches the CPU reference (math.ts) pixel for pixel', async ({ page }) => {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oeColorLab);
  const result = await page.evaluate(() => {
    const { color, defaults } = (window as any).__oeColorLab;
    // 64×32 test card: hue sweep × lightness ramp, plus a grey ramp row band
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
    const ops = (adj: any = {}, mut?: (g: any) => void) => {
      const g = defaults.defaultGrade();
      mut?.(g);
      return { ...defaults.defaultAdjust(), grayscale: 0, sepia: 0, ...adj, grade: g };
    };
    const cases: [string, any][] = [
      ['temp/tint/sat', ops({ temperature: 40, tint: -20, saturation: 25 })],
      ['exposure/contrast/brightness', ops({ exposure: -20, contrast: 35, brightness: 15 })],
      ['tone', ops({ highlights: -40, shadows: 30, whites: 20, blacks: -25, brilliance: 30 })],
      ['fade/vignette/grain', ops({ fade: 40, vignette: 70, grain: 60 })],
      ['look', ops({ grayscale: 0.5, sepia: 0.6 })],
      ['hsl', ops({}, (g) => { g.hsl.bands.red.hue = 80; g.hsl.bands.green.saturation = -70; g.hsl.bands.blue.lightness = 60; g.hsl.bands.yellow.lightness = -50; })],
      ['curves', ops({}, (g) => { g.curves.master = [{ x: 0, y: 0.1 }, { x: 0.3, y: 0.2 }, { x: 0.7, y: 0.9 }, { x: 1, y: 1 }]; g.curves.blue = [{ x: 0, y: 0 }, { x: 0.5, y: 0.35 }, { x: 1, y: 1 }]; })],
      ['wheels', ops({}, (g) => { g.wheels.lift = { x: 0.4, y: 0.2, luma: 10 }; g.wheels.gamma = { x: -0.3, y: 0.5, luma: -20 }; g.wheels.gain = { x: 0, y: -0.6, luma: 15 }; g.wheels.offset = { x: 0.2, y: 0, luma: 0 }; })],
      ['mask', ops({ saturation: -50, exposure: 30 }, (g) => { Object.assign(g.mask, { shape: 'rectangle', width: 0.5, height: 0.6, rotation: 20, feather: 30, roundness: 40, x: 0.1 }); })],
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
    const out: { name: string; max: number; mean: number }[] = [];
    for (const [name, o] of cases) {
      const params = color.gradeParams(o, 7);
      const req = { source: src, sourceWidth: W, sourceHeight: H, crop: { x: 0, y: 0, w: 1, h: 1 }, outWidth: W, outHeight: H, aspect: W / H, params };
      const a = read(gl.grade(req));
      const b = read(cpu.grade(req));
      let max = 0;
      let sum = 0;
      for (let i = 0; i < a.length; i += 4)
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(a[i + k]! - b[i + k]!);
          max = Math.max(max, d);
          sum += d;
        }
      out.push({ name, max, mean: sum / ((a.length / 4) * 3) });
    }
    const kind = gl.kind;
    gl.dispose();
    return { kind, out };
  });
  console.log(`[tab-adjust] GPU (${result.kind}) vs CPU: ${result.out.map((r) => `${r.name} max=${r.max} mean=${r.mean.toFixed(2)}`).join(' | ')}`);
  expect(result.kind).toBe('webgl2');
  for (const r of result.out) {
    expect(r.mean, r.name).toBeLessThan(0.6);
    expect(r.max, r.name).toBeLessThanOrEqual(3);
  }
});
