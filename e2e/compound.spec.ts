/**
 * Compound clips (CapCut "Create compound clip", ⌥G): two clips — a main-track video and an image
 * overlay on top of it — become one compound clip. The preview must show the same pixels as
 * before at several times, the export must match the preview, the nested timeline opens with a
 * breadcrumb and back, and ⌘Z restores the document.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, imageRgb, probeStreams, videoFrame } from './audit-helpers';
import { collectConsoleErrors, importMedia, MEDIA, openApp, pressShortcut, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(here, 'test-results', 'compound-tmp');
const FPS = 30;

const doc = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const p = (window as any).__oe.getState().project;
    return JSON.stringify({ ...p, updatedAt: 0 });
  });

async function previewPng(page: Page, tUs: number, name: string): Promise<string> {
  await page.mouse.move(5, 5);
  await page.evaluate((t) => {
    const s = (window as any).__oe.getState();
    s.pause();
    s.clearSelection();
    s.setPreviewTime(null);
    s.setPlayhead(t);
  }, tUs);
  let prev = '';
  let stable = 0;
  await page.waitForTimeout(250);
  for (let i = 0; i < 40; i++) {
    const d = await page.evaluate(() => (document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement).toDataURL('image/png'));
    if (d === prev) {
      if (++stable >= 2) break;
    } else stable = 0;
    prev = d;
    await page.waitForTimeout(200);
  }
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(prev.split(',')[1]!, 'base64'));
  return file;
}

test('two clips → one compound clip: same preview pixels, export = preview, nested editing, undo', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectConsoleErrors(page);
  await openApp(page);
  await importMedia(page, [MEDIA.vertical, MEDIA.image]);

  // main-track video 0–5 s; image overlay 1–3 s, half size, moved and screen-blended
  const ids = await page.evaluate(() => {
    const st = () => (window as any).__oe.getState();
    const byName = (n: string) => (Object.values(st().project.assets) as any[]).find((a) => a.name === n).id;
    const a = st().addClip(byName('v-vertical-5s.mp4'), { at: 0 });
    const o = st().addClip(byName('img-square.png'), { kind: 'overlay', at: 1_000_000 });
    st().trimEnd(o, 3_000_000);
    st().updateClip(o, { transform: { scale: 0.5, x: 120, y: -200, rotation: 12 }, blend: 'screen' });
    return { a, o };
  });
  const before = await doc(page);
  const times = [0.5e6, 1.5e6, 2.5e6, 4.2e6].map((t) => Math.round((Math.round((t * FPS) / 1e6) * 1e6) / FPS));
  const pre: string[] = [];
  for (const t of times) pre.push(await previewPng(page, t, `before-${t}`));

  // ---- select both clips on the timeline and press ⌥G
  await page.locator(`[data-clip-id="${ids.a}"]`).click();
  await page.locator(`[data-clip-id="${ids.o}"]`).click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => (window as any).__oe.getState().selection.clipIds.length)).toBe(2);
  await pressShortcut(page, 'Alt+KeyG');
  const compound = page.locator('[data-clip-type="compound"]');
  await expect(compound).toHaveCount(1);
  await expect(page.locator(`[data-clip-id="${ids.o}"]`)).toHaveCount(0);
  const cid = await compound.getAttribute('data-clip-id');
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);
  const after = await doc(page);

  // ---- the preview is unchanged at every chosen time
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', pre[0]!], { encoding: 'utf8' }).trim().split(',').map(Number) as [number, number];
  const post: string[] = [];
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < times.length; i++) {
    const png = await previewPng(page, times[i]!, `after-${times[i]}`);
    post.push(png);
    const c = compare(imageRgb(pre[i]!, w, h), imageRgb(png, w, h));
    rows.push({ t: times[i]! / 1e6, mad: +c.mad.toFixed(3), psnr: +c.psnr.toFixed(1) });
    expect.soft(c.mad, `t=${times[i]! / 1e6}: preview before vs after ⌥G`).toBeLessThanOrEqual(1.5);
  }

  // ---- double-click opens the nested timeline with a breadcrumb; Back returns
  await compound.dblclick();
  await expect(page.getByTestId('compound-breadcrumb')).toBeVisible();
  await expect(page.getByTestId('compound-breadcrumb')).toContainText('Main');
  await expect(page.getByTestId('compound-breadcrumb')).toContainText('Compound 1');
  await expect(page.locator(`[data-clip-id="${ids.o}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);
  await page.getByTestId('compound-back').click();
  await expect(page.getByTestId('compound-breadcrumb')).toHaveCount(0);
  await expect(page.locator(`[data-clip-id="${cid}"]`)).toHaveCount(1);
  expect(await doc(page)).toBe(after);

  // ---- Media › Subprojects lists it
  await page.getByRole('button', { name: 'Subprojects' }).first().click().catch(() => undefined);
  await expect(page.getByTestId('subproject-tile')).toHaveCount(1);

  // ---- export: a frame of the compound matches the preview
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  await page.getByTestId('export-fps').selectOption(String(FPS));
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 180_000);
  await page.keyboard.press('Escape');
  const probe = probeStreams(file);
  expect(probe.v).toMatchObject({ codec: 'h264', width: 720, height: 1280 });
  for (const i of [1, 2]) {
    const n = Math.round((times[i]! * FPS) / 1e6);
    const c = compare(videoFrame(file, n, w, h), imageRgb(post[i]!, w, h));
    rows.push({ export: n, mad: +c.mad.toFixed(2), psnr: +c.psnr.toFixed(1) });
    expect.soft(c.mad, `frame ${n}: export vs preview MAD`).toBeLessThanOrEqual(4);
    expect.soft(c.psnr, `frame ${n}: export vs preview PSNR`).toBeGreaterThanOrEqual(25);
  }
  console.log('COMPOUND', JSON.stringify(rows));
  fs.rmSync(file, { force: true });

  // ---- ⌘Z: back to the two clips, exactly
  await page.mouse.click(5, 5);
  await pressShortcut(page, 'Mod+KeyZ');
  expect(await doc(page)).toBe(before);
  // ⌥⇧G on a redone compound restores the same document too
  await pressShortcut(page, 'Mod+Shift+KeyZ');
  await page.evaluate((id) => (window as any).__oe.getState().select([id]), cid);
  await pressShortcut(page, 'Alt+Shift+KeyG');
  await expect(page.locator('[data-clip-type="compound"]')).toHaveCount(0);
  expect(await doc(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);
  expect(errors.real()).toEqual([]);
});
