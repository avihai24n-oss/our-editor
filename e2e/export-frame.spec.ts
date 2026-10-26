/**
 * Player ⋯ › Export frame (src/export/exportFrame.ts + vite-plugins/saveFiles.js): the frame at the
 * playhead, at the project's size, with a preview, written as PNG / JPEG / WebP by the editor's
 * server into a folder on this Mac (default ~/Downloads — Chrome's own picker refuses it). Finder's
 * folder dialog is mocked here (page.route); the files really land on disk, in a temp folder.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importMedia, mediaPath, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
// inside the home folder (the server writes nowhere else)
const OUT = path.join(os.homedir(), '.our-editor', `e2e-frames-${process.pid}`);

test.beforeEach(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
});
test.afterAll(() => fs.rmSync(OUT, { recursive: true, force: true }));

async function setup(page: Page) {
  // Finder's "choose folder" → our temp folder
  await page.route('**/__save/choose-folder*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ path: OUT }) }));
  await openApp(page);
  await importMedia(page, [mediaPath('v-landscape-4s.mp4')]);
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    s.setProjectName('Frame test');
    s.addClip(Object.keys(s.project.assets)[0], { at: 0, kind: 'main' });
    s.setPlayhead(1_000_000);
  });
}

async function openDialog(page: Page) {
  await page.getByTestId('player-more').click();
  await page.getByTestId('player-export-frame').click();
  const dlg = page.getByTestId('frame-export-dialog');
  await expect(dlg.getByTestId('frame-export-preview')).toHaveAttribute('data-ready', 'true');
  return dlg;
}

/** Size + a pixel of a saved image, decoded in the page. */
const inspect = (page: Page, file: string) =>
  page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d')!;
    x.drawImage(bmp, 0, 0);
    const px = x.getImageData(Math.floor(bmp.width * 0.1), Math.floor(bmp.height / 2), 1, 1).data;
    return { width: bmp.width, height: bmp.height, min: Math.min(px[0]!, px[1]!, px[2]!) };
  }, fs.readFileSync(file).toString('base64'));

test('the dialog defaults to Downloads; a chosen folder gets PNG / JPEG files, never overwritten', async ({ page }) => {
  await setup(page);
  const { w, h } = await page.evaluate(() => ({ w: (window as any).__oe.getState().project.settings.width, h: (window as any).__oe.getState().project.settings.height }));
  const dlg = await openDialog(page);
  await expect(dlg.getByTestId('frame-export-folder')).toHaveText('~/Downloads');
  // the preview shows the frame (colour bars, not black)
  const prev = await dlg.getByTestId('frame-export-preview').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(Math.floor(c.width * 0.1), Math.floor(c.height / 2), 1, 1).data;
    return Math.min(d[0]!, d[1]!, d[2]!);
  });
  expect(prev).toBeGreaterThan(120);
  await expect(dlg.getByTestId('frame-export-name')).toHaveValue('Frame test 00-00-01-00.png');

  await dlg.getByTestId('frame-export-choose').click();
  await expect(dlg.getByTestId('frame-export-folder')).toHaveText(`~${OUT.slice(os.homedir().length)}`);
  await screenshot(page, 'export-frame-dialog');
  await dlg.getByTestId('frame-export-save').click();
  await expect(dlg).toHaveCount(0);
  const png = path.join(OUT, 'Frame test 00-00-01-00.png');
  expect(fs.existsSync(png)).toBe(true);
  expect(await inspect(page, png)).toMatchObject({ width: w, height: h });
  expect((await inspect(page, png)).min).toBeGreaterThan(120);

  // JPEG into the remembered folder, twice: the second is "(2)", nothing overwritten
  for (let i = 0; i < 2; i++) {
    const d = await openDialog(page);
    await expect(d.getByTestId('frame-export-folder')).toHaveText(`~${OUT.slice(os.homedir().length)}`);
    await d.getByTestId('frame-export-format').selectOption('jpeg');
    await d.getByTestId('frame-export-save').click();
    await expect(d).toHaveCount(0);
  }
  expect(fs.readdirSync(OUT).sort()).toEqual(['Frame test 00-00-01-00 (2).jpg', 'Frame test 00-00-01-00.jpg', 'Frame test 00-00-01-00.png']);
  expect(fs.readFileSync(path.join(OUT, 'Frame test 00-00-01-00.jpg')).subarray(0, 2).toString('hex')).toBe('ffd8');

  // back to Downloads
  const d = await openDialog(page);
  await d.getByTestId('frame-export-downloads').click();
  await expect(d.getByTestId('frame-export-folder')).toHaveText('~/Downloads');
});

test('the server refuses folders outside the home folder and odd names', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const put = (dir: string, name: string) => fetch(`/__save/file?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: 'PUT', body: 'x' }).then((x) => x.status);
    return [await put('/tmp', 'a.png'), await put('/etc', 'a.png')];
  });
  expect(r).toEqual([400, 400]);
  const bad = await page.evaluate(async (dir) => fetch(`/__save/file?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent('../x.png')}`, { method: 'PUT', body: 'x' }).then((x) => x.status), OUT);
  expect(bad).toBe(400);
});
