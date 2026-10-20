/**
 * Copy / paste attributes (CapCut ⌥⌘C / ⌥⌘V): copy clip A's attributes, paste a chosen subset onto
 * clip B through the dialog, check B's values and the preview pixels, one undo step, and that a
 * speed paste keeps the model invariants (window.__oeCheck).
 *
 * white.mp4 is a 2 s 1080×1920 white clip: at 100 % it fills the 9:16 canvas, at 50 % the corners
 * show the black canvas.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectConsoleErrors, importMedia, openApp, pressShortcut, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-attrs-'));
const WHITE = path.join(dir, 'white.mp4');

test.beforeAll(() => {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=1080x1920:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', WHITE]);
});
test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const store = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__oe.getState()[f as string](...(a as unknown[])), [fn, args] as const);
const clip = (page: Page, id: string) =>
  page.evaluate((cid) => {
    const p = (window as any).__oe.getState().project;
    return JSON.parse(JSON.stringify(p.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === cid)));
  }, id);
const pastLen = (page: Page) => page.evaluate(() => (window as any).__oe.getState().past.length as number);

async function cornerLuma(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(Math.round(0.08 * c.width), Math.round(0.08 * c.height), 1, 1).data;
    return 0.299 * d[0]! + 0.587 * d[1]! + 0.114 * d[2]!;
  });
}
const expectCorner = (page: Page, dark: boolean) =>
  expect.poll(async () => ((await cornerLuma(page)) < 40) === dark, { timeout: 8_000 }).toBe(true);

test('copy attributes ⌥⌘C, paste dialog ⌥⌘V: values, pixels, one undo step, invariants', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await openApp(page);
  await importMedia(page, [WHITE]);
  const asset: string = await page.evaluate(() => Object.values((window as any).__oe.getState().project.assets).find((x: any) => x.name === 'white.mp4')!.id);
  const a: string = await store(page, 'addClip', asset, { at: 0 });
  const b: string = await store(page, 'addClip', asset, { at: 2_000_000 });
  await store(page, 'updateClip', a, { transform: { scale: 0.5 } });
  await store(page, 'setSpeed', a, 2);

  // B under the playhead, at 100 %: white corner
  await store(page, 'select', [b], 'replace');
  const bStart = (await clip(page, b)).start;
  await store(page, 'setPlayhead', bStart + 500_000);
  await expectCorner(page, false);

  // nothing copied yet: ⌥⌘V opens no dialog
  await store(page, 'select', [b], 'replace');
  await pressShortcut(page, 'Mod+Alt+v');
  await expect(page.getByTestId('paste-attributes-dialog')).toHaveCount(0);

  // copy from A
  await store(page, 'select', [a], 'replace');
  await pressShortcut(page, 'Mod+Alt+c');
  expect(await page.evaluate(() => (window as any).__oeUi.getState().attributeClipboard?.sourceId)).toBe(a);

  // paste onto B: the dialog lists the video groups; keep Transform only
  await store(page, 'select', [b], 'replace');
  await pressShortcut(page, 'Mod+Alt+v');
  const dlg = page.getByTestId('paste-attributes-dialog');
  await expect(dlg).toBeVisible();
  for (const g of ['transform', 'blend', 'mask', 'chroma', 'canvas', 'speed', 'animation', 'adjust', 'audio']) await expect(dlg.getByTestId(`attr-${g}`)).toBeChecked();
  await expect(dlg.getByTestId('attr-text')).toHaveCount(0);
  await screenshot(page, 'attributes-dialog');
  await dlg.getByTestId('attr-all').uncheck();
  await expect(dlg.getByTestId('attr-paste')).toBeDisabled();
  await dlg.getByTestId('attr-transform').check();
  const before = await pastLen(page);
  await dlg.getByTestId('attr-paste').click();
  await expect(dlg).toHaveCount(0);

  let cb = await clip(page, b);
  expect(cb.transform.scale).toBe(0.5);
  expect(cb.speed).toBe(1);
  expect(await pastLen(page)).toBe(before + 1);
  await store(page, 'setPlayhead', cb.start + 500_000);
  await expectCorner(page, true);

  // one undo step brings B back
  await pressShortcut(page, 'Mod+z');
  cb = await clip(page, b);
  expect(cb.transform.scale).toBe(1);
  await expectCorner(page, false);

  // paste everything (Enter in the dialog): speed 2x halves B and the model stays valid
  await store(page, 'select', [b], 'replace');
  await pressShortcut(page, 'Mod+Alt+v');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dlg).toHaveCount(0);
  cb = await clip(page, b);
  expect(cb.speed).toBe(2);
  expect(cb.duration).toBe(1_000_000);
  expect(cb.transform.scale).toBe(0.5);
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);
  await store(page, 'setPlayhead', cb.start + 300_000);
  await expectCorner(page, true);
  // Escape closes without pasting
  await pressShortcut(page, 'Mod+Alt+v');
  await expect(dlg).toBeVisible();
  const n = await pastLen(page);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(await pastLen(page)).toBe(n);

  expect(errors.real(), errors.real().join('\n')).toEqual([]);
});
