/**
 * Animation tab, end to end: apply animations through the inspector, check the PREVIEW canvas
 * pixels at chosen times inside the In / Out ranges, reload (persistence), export an MP4 and
 * check the SAME frames in the file with ffmpeg — proving preview = export.
 *
 * Project: two white 1080×1920 images on the main track (3 s each) on a black canvas.
 *   clip A: In "Fade In" 1 s, Out "Slide Left" 1 s     clip B: In "Wipe Right" 1 s
 *   t = 0.2 s  fade at 20 %                → whole frame ≈ 20 % white
 *   t = 2.8 s  slide-left out at 80 %      → content shifted left by k = 1 − E(0.2) = 0.512 W
 *   t = 3.5 s  wipe-right in at 50 %       → visible from the left edge to 0.875 W
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectConsoleErrors, expectMediaFile, importMedia, openApp, screenshot, waitForDownload } from './helpers';

const FPS = 30;
const SAMPLES = [
  { name: 'black (fade start)', t: 0 },
  { name: 'fade 20%', t: 0.2 },
  { name: 'white (rest)', t: 1.5 },
  { name: 'slide-left out 80%', t: 2.8 },
  { name: 'wipe-right in 50%', t: 3.5 },
] as const;
/** Fractions of the canvas width where the luma is measured (vertical band through the middle). */
const COLS = [0.05, 0.25, 0.45, 0.55, 0.7, 0.8, 0.95];

const ease = (p: number) => 1 - (1 - p) ** 3; // cubic ease-out, as in the catalogue
const slideEdge = 1 - (1 - ease(1 - 0.8)); // content spans [0, slideEdge·W] at t = 2.8 s
const wipeEdge = ease(0.5); // visible [0, wipeEdge·W] at t = 3.5 s

function whitePng(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-anim-'));
  const file = path.join(dir, 'white-1080x1920.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=white:s=1080x1920', '-frames:v', '1', file]);
  return file;
}

/** Types into a NumberBox like a user: focus, select all, type, Enter. */
async function typeDuration(box: Locator, value: string) {
  await box.click();
  await box.press('ControlOrMeta+a');
  await box.pressSequentially(value);
  await box.press('Enter');
  if (await box.evaluate((el) => el === document.activeElement)) await box.blur();
  await expect(box).toHaveValue(`${Number(value).toFixed(1)}s`);
}

const state = (page: Page) => page.evaluate(() => (window as any).__oe.getState().project);

/** Mean luma (0..255) in a small square around each column at mid-height of the player canvas. */
async function previewLuma(page: Page): Promise<number[]> {
  return page.evaluate((cols) => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="player-canvas"]')!;
    const ctx = c.getContext('2d')!;
    const y = Math.round(c.height / 2);
    return cols.map((f) => {
      const x = Math.min(c.width - 4, Math.max(0, Math.round(f * c.width) - 2));
      const d = ctx.getImageData(x, y - 2, 4, 4).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      return sum / (d.length / 4);
    });
  }, COLS);
}

async function seekPreview(page: Page, t: number): Promise<number[]> {
  await page.evaluate((us) => {
    const st = (window as any).__oe.getState();
    st.pause();
    st.setPreviewTime?.(null);
    st.setPlayhead(us);
  }, Math.round(t * 1e6));
  // the engine renders on the next frame once the image is decoded; wait for two stable reads
  let last: number[] = [];
  await expect
    .poll(
      async () => {
        const now = await previewLuma(page);
        const same = last.length && now.every((v, i) => Math.abs(v - last[i]!) < 0.5);
        last = now;
        return same;
      },
      { timeout: 10_000, intervals: [150, 150, 250, 400] },
    )
    .toBeTruthy();
  return last;
}

/** Luma of frame n of an MP4 at the same columns (mid-height), via ffmpeg → raw gray. */
function exportLuma(file: string, frame: number, w: number, h: number): number[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),format=gray`, '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(raw.length).toBe(w * h);
  const y = Math.round(h / 2);
  return COLS.map((f) => {
    const x = Math.min(w - 4, Math.max(0, Math.round(f * w) - 2));
    let sum = 0;
    for (let dy = -2; dy < 2; dy++) for (let dx = 0; dx < 4; dx++) sum += raw[(y + dy) * w + x + dx]!;
    return sum / 16;
  });
}

/** Normalises luma to 0..1 between the black and white reference frames. */
const norm = (v: number[], black: number[], white: number[]) => v.map((x, i) => (x - black[i]!) / Math.max(1, white[i]! - black[i]!));

function expectPattern(name: string, v: number[]) {
  const at = (f: number) => v[COLS.indexOf(f)]!;
  if (name === 'fade 20%') for (const x of v) expect(x, `${name}: ${v.map((n) => n.toFixed(2))}`).toBeGreaterThan(0.12), expect(x).toBeLessThan(0.28);
  if (name === 'slide-left out 80%') {
    // content spans [0, 0.488 W]
    for (const f of COLS) {
      if (f < slideEdge - 0.04) expect(at(f), `${name} @${f}: ${v.map((n) => n.toFixed(2))}`).toBeGreaterThan(0.85);
      if (f > slideEdge + 0.04) expect(at(f), `${name} @${f}: ${v.map((n) => n.toFixed(2))}`).toBeLessThan(0.15);
    }
  }
  if (name === 'wipe-right in 50%') {
    for (const f of COLS) {
      if (f < wipeEdge - 0.04) expect(at(f), `${name} @${f}: ${v.map((n) => n.toFixed(2))}`).toBeGreaterThan(0.85);
      if (f > wipeEdge + 0.04) expect(at(f), `${name} @${f}: ${v.map((n) => n.toFixed(2))}`).toBeLessThan(0.15);
    }
  }
}

test('Animation tab: apply, preview pixels, persist, export matches', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectConsoleErrors(page);
  const png = whitePng();
  await openApp(page);
  await importMedia(page, [png]);

  // two 3 s white clips on the main track
  const ids = await page.evaluate(() => {
    const st = (window as any).__oe.getState();
    const asset = Object.values(st.project.assets)[0] as any;
    const a = st.addClip(asset.id, { at: 0 });
    st.trimEnd(a, 3_000_000);
    const b = st.addClip(asset.id, { at: 3_000_000 });
    st.trimEnd(b, 6_000_000);
    return { a, b };
  });
  expect((await state(page)).tracks[0].clips.map((c: any) => [c.start, c.duration])).toEqual([
    [0, 3_000_000],
    [3_000_000, 3_000_000],
  ]);

  // ---- clip A: In "Fade In" through the inspector
  await page.evaluate((id) => (window as any).__oe.getState().select([id]), ids.a);
  const insp = page.getByTestId('inspector');
  await insp.getByRole('tab', { name: 'Animation' }).click();
  await insp.getByRole('tab', { name: /^In/ }).click();
  await insp.getByRole('tab', { name: 'Basic' }).click();

  // hover plays the tile thumbnail (drawn by the real compositor)
  const zoomTile = insp.locator('[data-testid="anim-tile"][data-anim-id="zoom-in"]');
  await zoomTile.hover();
  const thumbA = await zoomTile.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await page.waitForTimeout(250);
  const thumbB = await zoomTile.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
  expect(thumbA).not.toBe(thumbB);

  await insp.locator('[data-testid="anim-tile"][data-anim-id="fade"]').locator('.anim__hit').click();
  // clicking previews it once in the player, then stops
  await expect.poll(() => page.evaluate(() => (window as any).__oe.getState().playing), { timeout: 8_000 }).toBe(false);
  await expect(insp.locator('[data-testid="anim-tile"][data-anim-id="fade"]')).toHaveAttribute('data-active', 'true');
  // duration 1 s with the number box
  const durBox = insp.getByTestId('animation-duration').getByRole('textbox');
  await typeDuration(durBox, '1');

  // ---- clip A: Out "Slide Left"
  await insp.getByRole('tab', { name: /^Out/ }).click();
  await insp.getByTestId('anim-search').fill('slide left');
  await insp.locator('[data-testid="anim-tile"][data-anim-id="slide-left"]').locator('.anim__hit').click();
  await expect.poll(() => page.evaluate(() => (window as any).__oe.getState().playing), { timeout: 8_000 }).toBe(false);
  await typeDuration(durBox, '1');

  // ---- clip B: In "Wipe Right" from the Mask chip
  await page.evaluate((id) => (window as any).__oe.getState().select([id]), ids.b);
  await insp.getByRole('tab', { name: 'Animation' }).click();
  await insp.getByRole('tab', { name: /^In/ }).click();
  await insp.getByRole('tab', { name: 'Mask' }).click();
  await insp.locator('[data-testid="anim-tile"][data-anim-id="wipe-right"]').locator('.anim__hit').click();
  await expect.poll(() => page.evaluate(() => (window as any).__oe.getState().playing), { timeout: 8_000 }).toBe(false);
  await typeDuration(durBox, '1');

  const clipsNow = (await state(page)).tracks[0].clips;
  expect(clipsNow[0].animationIn).toEqual({ type: 'fade', duration: 1_000_000 });
  expect(clipsNow[0].animationOut).toEqual({ type: 'slide-left', duration: 1_000_000 });
  expect(clipsNow[1].animationIn).toEqual({ type: 'wipe-right', duration: 1_000_000 });
  // timeline indicator
  await expect(page.locator(`[data-testid="timeline-clip"][data-clip-id="${ids.a}"]`)).toHaveAttribute('data-animations', 'in,out');
  await expect(page.locator(`[data-testid="timeline-clip"][data-clip-id="${ids.a}"] .tl-clip__ramp--in`)).toHaveCount(1);

  // ---- persistence: reload and find the same animations
  await page.waitForTimeout(2500); // autosave (0.8 s debounce, ≤ 1 write / 2 s)
  await page.reload();
  await expect(page.getByTestId('player')).toBeVisible();
  await expect.poll(async () => ((await state(page)).tracks[0]?.clips ?? []).length, { timeout: 10_000 }).toBe(2);
  const reloaded = (await state(page)).tracks[0].clips;
  expect(reloaded[0].animationIn).toEqual({ type: 'fade', duration: 1_000_000 });
  expect(reloaded[1].animationIn).toEqual({ type: 'wipe-right', duration: 1_000_000 });
  await page.mouse.move(5, 5); // keep the hover preview axis off the timeline

  // ---- preview pixels
  const preview: Record<string, number[]> = {};
  for (const s of SAMPLES) preview[s.name] = await seekPreview(page, s.t);
  await screenshot(page, 'tab-animation-preview');
  const pBlack = preview['black (fade start)']!;
  const pWhite = preview['white (rest)']!;
  expect(Math.min(...pWhite) - Math.max(...pBlack)).toBeGreaterThan(150);
  const pn: Record<string, number[]> = {};
  for (const s of SAMPLES) {
    pn[s.name] = norm(preview[s.name]!, pBlack, pWhite);
    expectPattern(s.name, pn[s.name]!);
  }
  console.log('preview (normalised)', JSON.stringify(Object.fromEntries(Object.entries(pn).map(([k, v]) => [k, v.map((x) => +x.toFixed(3))]))));

  // ---- export 720p MP4 and compare the same frames
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  await page.getByTestId('export-fps').selectOption(String(FPS));
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 180_000);
  const probe = expectMediaFile(file, { width: 720, height: 1280, hasVideo: true, duration: 6, durationTolerance: 0.2 });
  const ex: Record<string, number[]> = {};
  for (const s of SAMPLES) ex[s.name] = exportLuma(file, Math.round(s.t * FPS), probe.width!, probe.height!);
  const xBlack = ex['black (fade start)']!;
  const xWhite = ex['white (rest)']!;
  expect(Math.min(...xWhite) - Math.max(...xBlack)).toBeGreaterThan(150);
  const xn: Record<string, number[]> = {};
  for (const s of SAMPLES) {
    xn[s.name] = norm(ex[s.name]!, xBlack, xWhite);
    expectPattern(s.name, xn[s.name]!);
    // preview and export agree column by column
    xn[s.name]!.forEach((v, i) => expect(Math.abs(v - pn[s.name]![i]!), `${s.name} col ${COLS[i]} preview ${pn[s.name]![i]} vs export ${v}`).toBeLessThan(0.08));
  }
  console.log('export (normalised)', JSON.stringify(Object.fromEntries(Object.entries(xn).map(([k, v]) => [k, v.map((x) => +x.toFixed(3))]))));

  expect(errors.real(), errors.real().join('\n')).toEqual([]);
});
