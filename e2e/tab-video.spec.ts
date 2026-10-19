/**
 * Video tab (inspector › Video): every non-AI control changes the PREVIEW pixels as expected,
 * is undoable, survives a reload, and the exported MP4 shows the same pixels.
 *
 * Media is generated with ffmpeg so colours are known exactly:
 *   white.mp4  2 s 1080×1920 white video (main track — fills the 9:16 canvas at 100 %)
 *   blue.png   1080×1920 #4080c0 (overlay image, for blend modes)
 *   keyed.png  1080×1920 left half pure green, right half pure red (overlay image, chroma key)
 * The player canvas is sampled with getImageData at fractions of its size.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectConsoleErrors, expectMediaFile, importMedia, openApp, screenshot, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type RGB = [number, number, number];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-tab-video-'));
const WHITE = path.join(dir, 'white.mp4');
const BLUE = path.join(dir, 'blue.png');
const KEYED = path.join(dir, 'keyed.png');

test.beforeAll(() => {
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=1080x1920:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', WHITE]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x4080c0:s=1080x1920', '-frames:v', '1', BLUE]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=540x1920', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=540x1920', '-filter_complex', 'hstack', '-frames:v', '1', KEYED]);
});

test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------- helpers

async function px(page: Page, fx: number, fy: number): Promise<RGB> {
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(Math.round(x! * (c.width - 1)), Math.round(y! * (c.height - 1)), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    [fx, fy],
  );
}

const near = (a: RGB, b: RGB, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const luma = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const WHITE_RGB: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/** Waits until the preview pixel at (fx, fy) is within `tol` of `want`. */
async function expectPx(page: Page, fx: number, fy: number, want: RGB, tol = 12, note = '') {
  await expect
    .poll(async () => {
      const got = await px(page, fx, fy);
      return near(got, want, tol) ? 'ok' : `got ${got.join(',')} want ${want.join(',')} ±${tol} ${note}`;
    }, { timeout: 8_000 })
    .toBe('ok');
}

async function expectLuma(page: Page, fx: number, fy: number, lo: number, hi: number) {
  await expect
    .poll(async () => {
      const l = luma(await px(page, fx, fy));
      return l >= lo && l <= hi ? 'ok' : `luma ${l.toFixed(1)} not in [${lo}, ${hi}]`;
    }, { timeout: 8_000 })
    .toBe('ok');
}

const store = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__oe.getState()[f as string](...(a as unknown[])), [fn, args] as const);

const clip = (page: Page, id: string) =>
  page.evaluate((cid) => {
    const p = (window as any).__oe.getState().project;
    return JSON.parse(JSON.stringify(p.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === cid)));
  }, id);

async function assetId(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const a = Object.values((window as any).__oe.getState().project.assets).find((x: any) => x.name === n) as any;
    return a.id as string;
  }, name);
}

async function setNumber(page: Page, label: string, value: number) {
  const box = page.locator('.insp').getByLabel(label, { exact: true });
  await box.click();
  await box.fill(String(value));
  await box.press('Enter');
}

async function undo(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
}

const subTab = (page: Page, name: string) => page.locator('.insp').getByRole('tab', { name, exact: true }).click();

// ---------------------------------------------------------------- the walk

test('Video tab: preview pixels, undo, reload, export', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectConsoleErrors(page);
  await openApp(page);
  await importMedia(page, [WHITE, BLUE, KEYED]);
  const white = await assetId(page, 'white.mp4');
  const main: string = await store(page, 'addClip', white, { at: 0 });
  await store(page, 'select', [main], 'replace');
  await store(page, 'setPlayhead', 1_000_000);
  await expect(page.locator('.insp')).toBeVisible();
  await subTab(page, 'Basic');
  const log: string[] = [];
  const note = async (what: string, pts: [number, number][]) => {
    const vals = await Promise.all(pts.map(([x, y]) => px(page, x, y)));
    log.push(`${what}: ${pts.map(([x, y], i) => `(${x},${y})=${vals[i]!.join(',')}`).join('  ')}`);
  };

  // baseline: the white clip fills the canvas
  await expectPx(page, 0.5, 0.5, WHITE_RGB);
  await expectPx(page, 0.03, 0.03, WHITE_RGB);
  await note('baseline', [[0.5, 0.5], [0.03, 0.03]]);

  // ---- Transform: scale 50 % → the corners show the black canvas
  await setNumber(page, 'Scale value', 50);
  await expectPx(page, 0.1, 0.1, BLACK);
  await expectPx(page, 0.5, 0.5, WHITE_RGB);
  await expectPx(page, 0.3, 0.3, WHITE_RGB); // inside the 25..75 % box
  await note('scale 50%', [[0.1, 0.1], [0.3, 0.3], [0.5, 0.5]]);
  expect((await clip(page, main)).transform.scale).toBe(0.5);
  await undo(page);
  await expectPx(page, 0.1, 0.1, WHITE_RGB);
  expect((await clip(page, main)).transform.scale).toBe(1);

  // ---- Uniform scale off: width 50 %, height 100 %
  await page.locator('.insp').getByRole('switch', { name: 'Uniform scale' }).click();
  await setNumber(page, 'Scale width value', 50);
  await expectPx(page, 0.1, 0.5, BLACK);
  await expectPx(page, 0.5, 0.05, WHITE_RGB);
  await expectPx(page, 0.5, 0.95, WHITE_RGB);
  await note('scale W50 H100', [[0.1, 0.5], [0.5, 0.05], [0.5, 0.95]]);
  expect((await clip(page, main)).transform).toMatchObject({ uniformScale: false, scaleX: 0.5, scaleY: 1 });
  await page.getByRole('button', { name: 'Reset Transform' }).click();
  await expectPx(page, 0.1, 0.5, WHITE_RGB);

  // ---- Position X +540 → left half black
  await setNumber(page, 'Position X', 540);
  await expectPx(page, 0.25, 0.5, BLACK);
  await expectPx(page, 0.75, 0.5, WHITE_RGB);
  await note('x=540', [[0.25, 0.5], [0.75, 0.5]]);
  await page.getByRole('button', { name: 'Reset Transform' }).click();

  // ---- Rotate 90° → a 1920×1080 landscape box: top / bottom black, centre white
  await setNumber(page, 'Rotate', 90);
  await expectPx(page, 0.5, 0.1, BLACK);
  await expectPx(page, 0.5, 0.5, WHITE_RGB);
  await note('rotate 90', [[0.5, 0.1], [0.5, 0.5]]);
  await page.getByRole('button', { name: 'Reset Transform' }).click();
  await expectPx(page, 0.5, 0.1, WHITE_RGB);

  // ---- Blend: opacity 50 % halves the luma
  await setNumber(page, 'Opacity value', 50);
  await expectLuma(page, 0.5, 0.5, 120, 136);
  await note('opacity 50', [[0.5, 0.5]]);

  // blend modes of an image overlay (#4080c0) over the 50 % grey
  const blue = await assetId(page, 'blue.png');
  const over: string = await store(page, 'addClip', blue, { at: 0, kind: 'overlay' });
  await store(page, 'select', [over], 'replace');
  await expectPx(page, 0.5, 0.5, [64, 128, 192], 6, 'normal');
  const mode = page.locator('.insp').getByLabel('Blend mode');
  const blends: [string, RGB][] = [
    ['multiply', [32, 64, 96]],
    ['screen', [160, 191, 223]],
    ['linear-burn', [0, 1, 65]],
    ['darken', [64, 128, 128]],
    ['lighten', [128, 128, 192]],
  ];
  for (const [m, want] of blends) {
    await mode.selectOption(m);
    await expectPx(page, 0.5, 0.5, want, 8, m);
    await note(`blend ${m}`, [[0.5, 0.5]]);
  }
  await store(page, 'deleteClips', [over]);
  await store(page, 'select', [main], 'replace');
  await page.getByRole('button', { name: 'Reset Blend' }).click();
  await expectPx(page, 0.5, 0.5, WHITE_RGB);

  // ---- Mask on the video clip
  await subTab(page, 'Mask');
  await page.getByTestId('mask-circle').click();
  // 540 px circle at the centre: x 270..810 of 1080 → 25..75 %
  await expectPx(page, 0.5, 0.5, WHITE_RGB);
  await expectPx(page, 0.7, 0.5, WHITE_RGB);
  await expectPx(page, 0.8, 0.5, BLACK);
  await expectPx(page, 0.05, 0.05, BLACK);
  await note('mask circle', [[0.5, 0.5], [0.7, 0.5], [0.8, 0.5], [0.05, 0.05]]);
  await setNumber(page, 'Feather value', 100);
  await expectLuma(page, 0.75, 0.5, 40, 215); // on the edge: half way
  await expectPx(page, 0.5, 0.5, WHITE_RGB, 20);
  await note('mask circle feather 100', [[0.75, 0.5], [0.5, 0.5]]);
  await setNumber(page, 'Feather value', 0);
  await page.getByRole('button', { name: 'Invert mask' }).click();
  await expectPx(page, 0.5, 0.5, BLACK);
  await expectPx(page, 0.05, 0.05, WHITE_RGB);
  await note('mask circle inverted', [[0.5, 0.5], [0.05, 0.05]]);
  await page.getByRole('button', { name: 'Invert mask' }).click();

  // on-canvas handle: drag the centre dot 100 css px to the right
  const dot = page.locator('.player__mask-move');
  await expect(dot).toBeVisible();
  const before = (await clip(page, main)).mask.x;
  const b = (await dot.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 50, b.y + b.height / 2, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2 + 100, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = (await clip(page, main)).mask.x;
  expect(after).toBeGreaterThan(before + 0.1);
  await expectPx(page, 0.8, 0.5, WHITE_RGB); // the circle moved right
  await note('mask dragged right', [[0.8, 0.5], [0.3, 0.5]]);
  await undo(page);
  await expect.poll(async () => (await clip(page, main)).mask.x).toBe(before);

  await page.getByTestId('mask-linear').click();
  await expectPx(page, 0.5, 0.25, WHITE_RGB);
  await expectPx(page, 0.5, 0.75, BLACK);
  await note('mask linear', [[0.5, 0.25], [0.5, 0.75]]);
  await page.getByTestId('mask-mirror').click();
  await expectPx(page, 0.5, 0.5, WHITE_RGB);
  await expectPx(page, 0.5, 0.25, BLACK);
  await note('mask mirror', [[0.5, 0.5], [0.5, 0.25]]);
  await page.getByTestId('mask-rectangle').click();
  await expectPx(page, 0.25, 0.5, WHITE_RGB);
  await expectPx(page, 0.5, 0.25, BLACK);
  await note('mask rectangle', [[0.25, 0.5], [0.5, 0.25]]);
  await page.getByTestId('mask-heart').click();
  await expectPx(page, 0.5, 0.5, WHITE_RGB);
  await expectPx(page, 0.5, 0.3, BLACK);
  await expectPx(page, 0.2, 0.5, BLACK);
  await note('mask heart', [[0.5, 0.5], [0.5, 0.3], [0.2, 0.5]]);
  await page.getByTestId('mask-star').click();
  await expectPx(page, 0.5, 0.5, WHITE_RGB);
  await expectPx(page, 0.5, 0.375, WHITE_RGB); // along the top arm
  await expectPx(page, 0.639, 0.402, BLACK); // between the top and right arms
  await note('mask star', [[0.5, 0.5], [0.5, 0.375], [0.639, 0.402]]);
  await page.getByTestId('mask-none').click();
  await expectPx(page, 0.05, 0.05, WHITE_RGB);
  await screenshot(page, 'tab-video-01-mask');

  // ---- Remove BG › Chroma key on an image clip
  const keyed = await assetId(page, 'keyed.png');
  const img: string = await store(page, 'addClip', keyed, { at: 0, kind: 'overlay' });
  await store(page, 'select', [img], 'replace');
  await expectPx(page, 0.25, 0.5, [0, 255, 0]);
  await expectPx(page, 0.75, 0.5, [255, 0, 0]);
  await subTab(page, 'Remove BG');
  await page.getByLabel('Enable Chroma key').check();
  await expectPx(page, 0.25, 0.5, WHITE_RGB); // green keyed → the white clip below
  await expectPx(page, 0.75, 0.5, [255, 0, 0]);
  await note('chroma key on image', [[0.25, 0.5], [0.75, 0.5]]);
  await setNumber(page, 'Intensity value', 0);
  await expectPx(page, 0.25, 0.5, [0, 255, 0]);
  await setNumber(page, 'Intensity value', 50);
  await expectPx(page, 0.25, 0.5, WHITE_RGB);

  // a mask on the image clip too (circle): outside it the white clip shows, inside red stays red
  await subTab(page, 'Mask');
  await page.getByTestId('mask-circle').click();
  await expectPx(page, 0.6, 0.5, [255, 0, 0]);
  await expectPx(page, 0.9, 0.5, WHITE_RGB);

  // ---- Canvas (main track): scale the main clip to 50 % and fill around it
  await store(page, 'select', [main], 'replace');
  await subTab(page, 'Basic');
  await setNumber(page, 'Scale value', 50);
  await expectPx(page, 0.5, 0.15, BLACK);
  await page.getByLabel('Enable Canvas').check();
  await expect.poll(async () => (await clip(page, main)).canvas.type).toBe('blur');
  await expectLuma(page, 0.5, 0.15, 150, 256); // blurred copy of the white clip
  await note('canvas blur', [[0.5, 0.15], [0.03, 0.03]]);
  await page.getByLabel('Canvas type').selectOption('color');
  await page.getByRole('button', { name: 'Canvas colour #e94b3c' }).click();
  await expectPx(page, 0.5, 0.15, [233, 75, 60]);
  await expectPx(page, 0.03, 0.03, [233, 75, 60]);
  await note('canvas colour', [[0.5, 0.15], [0.03, 0.03]]);

  // final composition, sampled before reload / export
  const POINTS: [number, number][] = [
    [0.05, 0.05], // canvas colour
    [0.5, 0.2], // canvas colour (above the 50 % clip)
    [0.5, 0.3], // white clip, outside the image's circle
    [0.42, 0.5], // inside the circle, keyed green half → white clip
    [0.6, 0.5], // inside the circle, red half
  ];
  const EXPECT: RGB[] = [[233, 75, 60], [233, 75, 60], WHITE_RGB, WHITE_RGB, [255, 0, 0]];
  for (let i = 0; i < POINTS.length; i++) await expectPx(page, POINTS[i]![0], POINTS[i]![1], EXPECT[i]!);
  await screenshot(page, 'tab-video-02-final');
  await note('final (preview)', POINTS);

  // ---- reload: every value persists
  await page.waitForTimeout(3_000); // autosave (0.8 s debounce, ≥ 2 s between writes)
  await page.reload();
  await expect(page.getByTestId('player-canvas')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).length), { timeout: 15_000 }).toBe(2);
  const m = await clip(page, main);
  const i2 = await clip(page, img);
  expect(m.transform.scale).toBe(0.5);
  expect(m.canvas).toMatchObject({ type: 'color', color: '#e94b3c' });
  expect(i2.chroma).toMatchObject({ enabled: true, intensity: 50 });
  expect(i2.mask.shape).toBe('circle');
  await store(page, 'setPlayhead', 1_000_000);
  for (let i = 0; i < POINTS.length; i++) await expectPx(page, POINTS[i]![0], POINTS[i]![1], EXPECT[i]!);
  await note('final (after reload)', POINTS);

  // ---- export: the MP4 frame at 1 s shows the same pixels
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('1080p');
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 180_000);
  expectMediaFile(file, { width: 1080, height: 1920, hasVideo: true, duration: 5, durationTolerance: 0.2 }); // the 5 s image overlay sets the length
  const png = path.join(dir, 'frame-1s.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', file, '-frames:v', '1', png]);
  fs.mkdirSync(path.join(path.dirname(file), '..', 'screens'), { recursive: true });
  fs.copyFileSync(png, path.join(path.dirname(file), '..', 'screens', 'tab-video-03-export-frame.png'));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const at = (fx: number, fy: number): RGB => {
    const x = Math.round(fx * 1079);
    const y = Math.round(fy * 1919);
    const o = (y * 1080 + x) * 3;
    return [raw[o]!, raw[o + 1]!, raw[o + 2]!];
  };
  const exported = POINTS.map(([x, y]) => at(x, y));
  log.push(`final (exported MP4 @1s): ${POINTS.map(([x, y], i) => `(${x},${y})=${exported[i]!.join(',')}`).join('  ')}`);
  console.log(`\n[tab-video pixels]\n${log.join('\n')}\n`);
  for (let i = 0; i < POINTS.length; i++) {
    expect(near(exported[i]!, EXPECT[i]!, 20), `export ${POINTS[i]} = ${exported[i]} vs ${EXPECT[i]}`).toBe(true);
  }

  expect(errors.real(), errors.real().join('\n')).toEqual([]);
});
