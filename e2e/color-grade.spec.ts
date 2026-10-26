/**
 * Adjust › Color (DaVinci Resolve–style colour page) end to end in real Chromium, on the SMPTE
 * colour bars (test-media/v-landscape-4s.mp4, 75 % bars: grey, yellow, cyan, green, magenta,
 * red, blue on the top two thirds):
 *  - Scopes (player bar › Scopes): waveform / parade / vectorscope / histogram are computed from
 *    the graded frame on screen and land where the bars must (numeric checks via __oeScopes).
 *  - Primaries: saturation 0 collapses the vectorscope to its centre while the waveform keeps the
 *    luma; contrast / temp move the pixels to what the CPU reference (colorStage.ts) predicts.
 *  - HSL curves (Hue vs Sat dragged in the UI), qualifier (eyedropper on the red bar + hue
 *    correction, Show matte), before / after split, copy / paste grade (also to a multi
 *    selection), gallery still, undo, reload, and the export carrying the same look as preview.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { collectConsoleErrors, ffprobe, importMedia, MEDIA, openApp, pressShortcut, screenshot, SCREENS_DIR, waitForDownload } from './helpers';

type RGB = [number, number, number];
const BARS = ['grey', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue'] as const;
const POINTS: [number, number][] = BARS.map((_, i) => [(i + 0.5) / 7, 0.3]);
const T_US = 1_000_000;

const fmt = (s: RGB[]) => s.map((c, i) => `${BARS[i]}=${c.join(',')}`).join('  ');
const maxDiff = (a: RGB[], b: RGB[]) => Math.max(...a.flatMap((c, i) => c.map((v, k) => Math.abs(v - b[i]![k]!))));
const spread = (c: RGB) => Math.max(...c) - Math.min(...c);

async function samplePreview(page: Page, pts: [number, number][] = POINTS): Promise<RGB[]> {
  return page.evaluate((pts) => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="player-canvas"]')!;
    const ctx = c.getContext('2d')!;
    return pts.map(([fx, fy]) => {
      const x = Math.floor(fx * c.width) - 2;
      const y = Math.floor(fy * c.height) - 2;
      const d = ctx.getImageData(x, y, 5, 5).data;
      const s = [0, 0, 0];
      for (let i = 0; i < 25; i++) for (let k = 0; k < 3; k++) s[k]! += d[i * 4 + k]!;
      return s.map((v) => Math.round(v / 25)) as RGB;
    });
  }, pts);
}

function sampleVideo(file: string, tSec: number): RGB[] {
  const p = ffprobe(file);
  const w = p.width!;
  const h = p.height!;
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(tSec), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return POINTS.map(([fx, fy]) => {
    const cx = Math.floor(fx * w);
    const cy = Math.floor(fy * h);
    const s = [0, 0, 0];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let k = 0; k < 3; k++) s[k]! += buf[((cy + dy) * w + (cx + dx)) * 3 + k]!;
    return s.map((v) => Math.round(v / 25)) as RGB;
  });
}

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
  await page.waitForTimeout(150);
  last = await samplePreview(page);
  console.log(`[color-grade] ${label}: ${fmt(last)}`);
  return last;
}

const clips = (page: Page) => page.evaluate(() => (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips));
const clip0 = async (page: Page) => (await clips(page))[0];

/** Sets part of clip 0's Color page through the store (one undoable updateClip). */
async function setColor(page: Page, mut: string) {
  await page.evaluate((mut) => {
    const s = (window as any).__oe.getState();
    const c = s.project.tracks.flatMap((t: any) => t.clips)[0];
    const color = JSON.parse(JSON.stringify(c.grade.color));
    new Function('color', mut)(color);
    s.updateClip(c.id, { grade: { color } });
  }, mut);
}

/** CPU reference: clip 0's current grade applied to RGB samples (math.ts gradePixel). */
async function gradeSamples(page: Page, samples: RGB[]): Promise<RGB[]> {
  return page.evaluate(
    ({ samples, pts }) => {
      const { color, frame } = (window as any).__oeColorLab;
      const clip = (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips)[0];
      const params = color.gradeParams(frame.colorOps(clip), 0);
      if (!params) return samples;
      return samples.map((c: number[], i: number) => color.gradePixel(c.map((v) => v / 255), params, { u: pts[i]![0], v: pts[i]![1], aspect: 16 / 9 }).map((v: number) => Math.round(v * 255)));
    },
    { samples, pts: POINTS },
  );
}

interface ScopeSummary {
  frames: number;
  pixels: number;
  y: { min: number; max: number; mean: number };
  /** Share of all pixels within radius 5 cells of each 75 % target / of the centre. */
  targets: Record<string, number>;
  centre: number;
  /** Histogram-Y peak code values (top 8 bins, by count). */
  yPeaks: number[];
  /** Parade: in the columns of bar i, the most common R / G / B code value. */
  barModes: RGB[];
}

async function scopes(page: Page): Promise<ScopeSummary | null> {
  return page.evaluate(() => {
    const sc = (window as any).__oeScopes;
    sc.refresh();
    const d = sc.last();
    if (!d) return null;
    const { color } = (window as any).__oeColorLab;
    void color;
    const V = 192;
    const near = (cx: number, cy: number, r: number) => {
      let n = 0;
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(V - 1, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(V - 1, Math.ceil(cx + r)); x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) n += d.vector[y * V + x];
      return n / d.stats.pixels;
    };
    const pos = (r: number, g: number, b: number) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [((b - y) / 1.8556 + 0.5) * V, (0.5 - (r - y) / 1.5748) * V];
    };
    const T: Record<string, number[]> = { R: [0.75, 0, 0], Mg: [0.75, 0, 0.75], B: [0, 0, 0.75], Cy: [0, 0.75, 0.75], G: [0, 0.75, 0], Yl: [0.75, 0.75, 0] };
    const targets: Record<string, number> = {};
    for (const [k, v] of Object.entries(T)) {
      const [x, y] = pos(v[0]!, v[1]!, v[2]!);
      targets[k] = near(x!, y!, 6);
    }
    const peaks = Array.from(d.histY as Uint32Array)
      .map((n, i) => [n, i])
      .sort((a, b) => b[0]! - a[0]!)
      .slice(0, 8)
      .map((p) => p[1]!);
    const L = 256;
    const mode = (wave: Uint32Array, c0: number, c1: number) => {
      const h = new Array(L).fill(0);
      for (let c = c0; c < c1; c++) for (let l = 0; l < L; l++) h[l] += wave[c * L + l]!;
      // only the top two thirds of the frame hold the bars, but the columns include the rows
      // below: take the most common value
      return h.indexOf(Math.max(...h));
    };
    const barModes = Array.from({ length: 7 }, (_, i) => {
      const c0 = Math.floor(((i + 0.2) / 7) * d.cols);
      const c1 = Math.ceil(((i + 0.8) / 7) * d.cols);
      return [mode(d.waveR, c0, c1), mode(d.waveG, c0, c1), mode(d.waveB, c0, c1)];
    });
    return { frames: sc.frames(), pixels: d.stats.pixels, y: d.stats.y, targets, centre: near(V / 2, V / 2, 4), yPeaks: peaks, barModes };
  }) as Promise<ScopeSummary | null>;
}

test('Color page: scopes, primaries, HSL curves, qualifier, split, copy/paste, stills, export', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = collectConsoleErrors(page);
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe && !!(window as any).__oeColorLab && !!(window as any).__oeScopes);

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
  await page.getByRole('tab', { name: 'Color', exact: true }).click();
  await expect(page.getByTestId('adjust-sub-color')).toBeVisible();
  const base = await settle(page, (s) => s[0]![0] > 120 && s[6]![2] > 120 && s[5]![0] > 120, 'baseline');

  // ---- scopes on, all four
  await page.getByTestId('player-scopes').click();
  await expect(page.getByTestId('scopes-panel')).toBeVisible();
  for (const k of ['parade', 'histogram']) await page.getByTestId(`scope-toggle-${k}`).click();
  for (const k of ['waveform', 'parade', 'vector', 'histogram']) await expect(page.getByTestId(`scope-${k}`)).toBeVisible();
  let sc: ScopeSummary | null = null;
  await expect.poll(async () => (sc = await scopes(page)) !== null && sc.pixels > 1000, { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(400);
  sc = (await scopes(page))!;
  console.log(`[color-grade] scopes baseline: ${JSON.stringify(sc)}`);
  // every 75 % bar lands in its vectorscope target box (each bar is ~1/7 of the top 2/3 of the frame)
  for (const k of ['R', 'Mg', 'B', 'Cy', 'G', 'Yl']) expect(sc.targets[k], `vectorscope target ${k}`).toBeGreaterThan(0.03);
  // parade: the red bar column is R high / G, B low; the blue bar column is B high
  expect(sc.barModes[5]![0]).toBeGreaterThan(150);
  expect(sc.barModes[5]![2]).toBeLessThan(40);
  expect(sc.barModes[6]![2]).toBeGreaterThan(150);
  // the parade agrees with the canvas pixels of the bars
  for (let i = 0; i < 7; i++) for (let k = 0; k < 3; k++) expect(Math.abs(sc.barModes[i]![k]! - base[i]![k]!), `parade bar ${BARS[i]} ch ${k}`).toBeLessThanOrEqual(6);
  // histogram / waveform luma: the grey bar's luma (≈ 191) is one of the big peaks
  expect(sc.yPeaks.some((p) => Math.abs(p - Math.round(0.2126 * base[0]![0] + 0.7152 * base[0]![1] + 0.0722 * base[0]![2])) <= 2)).toBe(true);
  await screenshot(page, 'color-01-scopes');
  await page.getByTestId('scopes-panel').screenshot({ path: SCREENS_DIR + '/color-01b-scopes-panel.png' });
  await page.getByTestId('inspector').screenshot({ path: SCREENS_DIR + '/color-01c-inspector.png' });
  for (const [sec, name] of [['color-wheels', 'color-01d-primaries'], ['color-primaries', 'color-01e-primaries-bar'], ['color-log', 'color-01f-log'], ['color-qualifier', 'color-01g-qualifier']] as const) {
    await page.getByTestId(`section-${sec}`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.getByTestId('inspector').screenshot({ path: `${SCREENS_DIR}/${name}.png` });
  }
  const baseY = sc.y;

  // ---- Primaries: Saturation 0 → vectorscope collapses to the centre, luma unchanged
  await page.getByTestId('cp-saturation').locator('input[type=range]').fill('0');
  expect((await clip0(page)).grade.color.primaries.saturation).toBe(0);
  const grey = await settle(page, (s) => s.every((c) => spread(c) <= 3), 'saturation 0');
  for (const c of grey) expect(spread(c)).toBeLessThanOrEqual(3);
  await expect.poll(async () => (await scopes(page))!.centre, { timeout: 5000 }).toBeGreaterThan(0.97);
  sc = (await scopes(page))!;
  expect(Math.abs(sc.y.mean - baseY.mean)).toBeLessThan(2.5); // Rec.709 luma kept by the saturation matrix
  await screenshot(page, 'color-02-saturation-0');

  // ---- before / after split: left half = original, right = graded; scopes still graded
  await page.getByTestId('player-split').click();
  await expect(page.getByTestId('color-split')).toBeVisible();
  const split = await settle(page, (s) => spread(s[1]!) > 60 && spread(s[5]!) <= 3, 'split (yellow left original, red right graded)');
  expect(maxDiff([split[0]!, split[1]!, split[2]!], [base[0]!, base[1]!, base[2]!])).toBeLessThanOrEqual(2);
  for (const i of [4, 5, 6]) expect(spread(split[i]!)).toBeLessThanOrEqual(3);
  expect((await scopes(page))!.centre).toBeGreaterThan(0.97);
  await screenshot(page, 'color-03-split');
  // drag the divider to the right edge → everything original
  const frame = (await page.getByTestId('player-canvas').boundingBox())!;
  const handle = (await page.getByTestId('color-split-handle').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.97, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  await settle(page, (s) => maxDiff(s, base) <= 2, 'split moved right: all before');
  await page.getByTestId('player-split').click();
  await expect(page.getByTestId('color-split')).toBeHidden();

  // undo the saturation (one step per slider gesture)
  await pressShortcut(page, 'Mod+Z');
  expect((await clip0(page)).grade.color.primaries.saturation).toBe(50);
  await settle(page, (s) => maxDiff(s, base) <= 2, 'undo saturation');

  // ---- Contrast 1.5 / Temp +2000 K → the CPU reference's pixels
  await page.getByTestId('cp-contrast').locator('input[type=range]').fill('1.5');
  await page.getByTestId('cp-temp').locator('input[type=range]').fill('2000');
  const want = await gradeSamples(page, base);
  const prim = await settle(page, (s) => maxDiff(s, want) <= 3, 'contrast 1.5 + temp 2000');
  expect(maxDiff(prim, want)).toBeLessThanOrEqual(3);
  expect(prim[0]![0]).toBeGreaterThan(prim[0]![2]! + 15); // warmer grey
  await page.getByRole('button', { name: 'Reset Primaries · Adjust' }).click();
  await settle(page, (s) => maxDiff(s, base) <= 2, 'reset primaries');

  // ---- HSL curves: Hue vs Sat, a point on blue dragged to the bottom → blue bar goes grey
  await page.getByRole('tab', { name: 'Hue·Sat' }).click();
  await page.getByTestId('hslcurve-swatch-240').click();
  expect((await clip0(page)).grade.color.hslCurves.hueSat).toEqual([{ x: 0.584, y: 0.5 }, { x: 0.667, y: 0.5 }, { x: 0.75, y: 0.5 }]); // + two 30° anchors
  const ed = page.getByTestId('hslcurve-editor');
  await ed.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const eb = (await ed.boundingBox())!;
  const pastBefore = await page.evaluate(() => (window as any).__oe.getState().past.length);
  await page.mouse.move(eb.x + eb.width * 0.667, eb.y + eb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(eb.x + eb.width * 0.667, eb.y + eb.height * 0.8, { steps: 4 });
  await page.mouse.move(eb.x + eb.width * 0.667, eb.y + eb.height - 1, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).__oe.getState().past.length)).toBe(pastBefore + 1);
  const hs = (await clip0(page)).grade.color.hslCurves.hueSat;
  expect(hs).toHaveLength(3);
  expect(hs[1].y).toBeLessThan(0.03);
  const blueGrey = await settle(page, (s) => spread(s[6]!) <= 12 && spread(s[5]!) > 120, 'hue vs sat: blue → grey');
  expect(maxDiff([blueGrey[0]!, blueGrey[1]!, blueGrey[5]!], [base[0]!, base[1]!, base[5]!])).toBeLessThanOrEqual(3); // red / grey / yellow untouched
  await screenshot(page, 'color-04-hsl-curve');
  await page.getByTestId('hslcurve-reset').click();
  await settle(page, (s) => maxDiff(s, base) <= 2, 'hsl curve reset');

  // ---- Qualifier: eyedropper on the red bar, hue +120° inside the matte → red bar turns green
  const qsec = page.getByTestId('section-color-qualifier');
  await qsec.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.getByTestId('qual-pick').click();
  await expect(page.getByTestId('color-pick-overlay')).toBeVisible();
  await page.mouse.click(frame.x + frame.width * POINTS[5]![0], frame.y + frame.height * POINTS[5]![1]);
  await expect(page.getByTestId('color-pick-overlay')).toBeHidden();
  const q = (await clip0(page)).grade.color.qualifier;
  console.log(`[color-grade] picked qualifier: ${JSON.stringify({ hue: q.hue, sat: q.sat, lum: q.lum })}`);
  expect(q.enabled).toBe(true);
  expect(q.hue.on).toBe(true);
  expect(Math.min(q.hue.center, 360 - q.hue.center)).toBeLessThan(6); // red
  await page.getByTestId('qual-c-hue').locator('input[type=range]').fill('120');
  const qual = await settle(page, (s) => s[5]![1] > s[5]![0] + 60, 'qualifier: red → green');
  for (const i of [0, 1, 2, 3, 6]) expect(maxDiff([qual[i]!], [base[i]!]), `${BARS[i]} outside the key`).toBeLessThanOrEqual(3);
  // magenta (hue 300°) is outside the 30° + soft window
  expect(maxDiff([qual[4]!], [base[4]!])).toBeLessThanOrEqual(3);
  await page.getByTestId('qual-show-matte').check();
  const matte = await settle(page, (s) => s[5]!.every((v) => v > 240) && s[0]!.every((v) => v < 15), 'show matte');
  for (const i of [0, 1, 2, 3, 6]) expect(Math.max(...matte[i]!)).toBeLessThan(15);
  await screenshot(page, 'color-05-matte');
  await page.getByTestId('qual-show-matte').uncheck();
  await settle(page, (s) => s[5]![1] > s[5]![0] + 60, 'matte off');
  await screenshot(page, 'color-06-qualifier');

  // ---- log wheels + primaries through the store, then the export check below carries them
  await setColor(page, `color.logWheels.shadow = { x: -0.4, y: -0.2, luma: 0 }; color.logWheels.highlight = { x: 0.3, y: 0.15, luma: 0 }; color.primaries.contrast = 1.2;`);
  const graded = await settle(page, (s) => maxDiff(s, qual) > 6, 'log wheels + contrast + qualifier');
  const wantGraded = await gradeSamples(page, base);
  expect(maxDiff(graded, wantGraded)).toBeLessThanOrEqual(3);

  // ---- copy / paste: a second clip of the same media gets the grade; then a multi-select paste
  await page.getByTestId('grade-copy').click();
  const ids = await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const asset = Object.values(s.project.assets)[0] as any;
    const a = s.addClip(asset.id, { at: 4_000_000 });
    const b = s.addClip(asset.id, { at: 8_000_000 });
    return [a, b];
  });
  await page.evaluate((id) => (window as any).__oe.getState().select([id]), ids[0]);
  await page.getByRole('tab', { name: 'Color', exact: true }).click();
  await page.getByTestId('grade-paste').click();
  const all = await clips(page);
  const c0 = all.find((c: any) => c.start === 0);
  expect(all.find((c: any) => c.id === ids[0]).grade).toEqual(c0.grade);
  await page.evaluate((ids) => (window as any).__oe.getState().select(ids), [ids[1], c0.id]);
  await expect(page.getByTestId('grade-paste-selected')).toBeVisible();
  // make clip 0 different first, then paste the clipboard (the earlier grade) onto both
  await page.evaluate((id) => (window as any).__oe.getState().updateClip(id, { adjust: { exposure: 20 } }), c0.id);
  await page.getByTestId('grade-paste-selected').click();
  const all2 = await clips(page);
  expect(all2.find((c: any) => c.id === ids[1]).grade).toEqual(c0.grade);
  expect(all2.find((c: any) => c.id === c0.id).adjust.exposure).toBe(0);
  await pressShortcut(page, 'Mod+Z'); // one undo step for the whole paste
  expect((await clips(page)).find((c: any) => c.id === c0.id).adjust.exposure).toBe(20);
  await pressShortcut(page, 'Mod+Shift+Z');
  expect((await clips(page)).find((c: any) => c.id === c0.id).adjust.exposure).toBe(0);

  // ---- gallery: grab a still, reset the page, apply the still → the grade is back
  await page.evaluate((id) => (window as any).__oe.getState().select([id]), c0.id);
  await page.getByRole('tab', { name: 'Color', exact: true }).click();
  await page.getByTestId('grade-grab-still').click();
  await expect(page.getByTestId('grade-still')).toHaveCount(1);
  await screenshot(page, 'color-07-gallery');
  await page.getByTestId('color-reset-all').click();
  await settle(page, (s) => maxDiff(s, base) <= 2, 'color page reset');
  await page.getByTestId('grade-still').locator('.icolor-still__thumb').click();
  await settle(page, (s) => maxDiff(s, graded) <= 2, 'still applied');

  // ---- persists after reload
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oe && (window as any).__oe.getState().project.tracks.some((t: any) => t.clips.length));
  await page.evaluate((t) => (window as any).__oe.getState().setPlayhead(t), T_US);
  const reloaded = await settle(page, (s) => maxDiff(s, graded) <= 3, 'after reload');
  expect((await clip0(page)).grade.color.qualifier.correction.hue).toBe(120);

  // ---- export: the MP4 carries the same look (vs the CPU grade of an ungraded export)
  const exportMp4 = async () => {
    await page.getByTestId('export-button').click();
    await expect(page.getByTestId('export-dialog')).toBeVisible();
    await page.getByTestId('export-resolution').selectOption('720p');
    const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 420_000);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-dialog')).toBeHidden();
    return file;
  };
  const gradedFile = await exportMp4();
  const out = sampleVideo(gradedFile, T_US / 1e6 + 1 / 60);
  // ungraded export of the same frame: switch the whole grade off on the first clip
  const savedGrade = (await clip0(page)).grade;
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const c = s.project.tracks.flatMap((t: any) => t.clips)[0];
    s.updateClip(c.id, { grade: { color: { ...c.grade.color, enabled: false } } });
  });
  await settle(page, (s) => maxDiff(s, base) <= 2, 'color page bypassed');
  const plainFile = await exportMp4();
  const plain = sampleVideo(plainFile, T_US / 1e6 + 1 / 60);
  await page.evaluate((g) => {
    const s = (window as any).__oe.getState();
    const c = s.project.tracks.flatMap((t: any) => t.clips)[0];
    s.updateClip(c.id, { grade: g });
  }, savedGrade);
  const wantOut = await gradeSamples(page, plain);
  console.log(`[color-grade] export graded       : ${fmt(out)}`);
  console.log(`[color-grade] CPU grade of plain  : ${fmt(wantOut)}`);
  console.log(`[color-grade] preview graded      : ${fmt(reloaded)}`);
  console.log(`[color-grade] max |export − CPU(plain)| = ${maxDiff(out, wantOut)}; |plain export − preview| = ${maxDiff(plain, base)}; |export − preview| = ${maxDiff(out, reloaded)}`);
  expect(maxDiff(out, wantOut)).toBeLessThanOrEqual(10);
  expect(maxDiff(out, reloaded)).toBeLessThanOrEqual(maxDiff(plain, base) + 12);
  expect(out[5]![1]).toBeGreaterThan(out[5]![0]! + 40); // the qualifier's red → green reached the file

  expect(errors.real()).toEqual([]);
});

test('scopes follow playback live at a sane rate', async ({ page }) => {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe && !!(window as any).__oeScopes);
  await importMedia(page, [MEDIA.landscape]);
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    s.setAspectRatio('16:9');
    const asset = Object.values(s.project.assets)[0] as any;
    s.select([s.addClip(asset.id, { at: 0 })]);
    s.setPlayhead(0);
  });
  if (!(await page.getByTestId('scopes-panel').isVisible())) await page.getByTestId('player-scopes').click();
  await expect(page.getByTestId('scopes-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__oeScopes.computes().count), { timeout: 10_000 }).toBeGreaterThan(0);
  const before = await page.evaluate(() => ({ c: (window as any).__oeScopes.computes().count, f: (window as any).__oeScopes.frames() }));
  await page.getByTestId('play-button').click();
  await page.waitForTimeout(2000);
  await page.getByTestId('play-button').click();
  const after = await page.evaluate(() => ({ c: (window as any).__oeScopes.computes(), f: (window as any).__oeScopes.frames() }));
  const frames = after.f - before.f;
  const computes = after.c.count - before.c;
  console.log(`[color-grade] playback 2 s: ${frames} frames rendered, ${computes} scope analyses, last analysis ${after.c.ms.toFixed(1)} ms`);
  expect(frames).toBeGreaterThan(20);
  expect(computes).toBeGreaterThan(8); // ≈ 12 / s
  expect(computes).toBeLessThan(60); // throttled, never per pixel per frame
  expect(after.c.ms).toBeLessThan(40);
  await page.getByTestId('player-scopes').click(); // leave the pref off for other specs
  await expect(page.getByTestId('scopes-panel')).toBeHidden();
});
