/**
 * Dropping files from Finder / the desktop anywhere on the app. The drop is synthesised with a real
 * DataTransfer holding real File objects (test-media bytes), dispatched as dragenter → dragover →
 * drop on the target element, which is what Chromium delivers for an OS drag.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { collectConsoleErrors, mediaPath, MEDIA, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Spec = { name: string; type: string; b64: string };
const spec = (file: string, type: string, name = file): Spec => ({ name, type, b64: fs.readFileSync(mediaPath(file)).toString('base64') });
const textSpec = (name: string, type: string): Spec => ({ name, type, b64: Buffer.from('not media').toString('base64') });

/** Builds the DataTransfer in the page and returns its handle. */
async function makeTransfer(page: Page, files: Spec[]) {
  return page.evaluateHandle((list: Spec[]) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    return dt;
  }, files);
}

/** dragenter + dragover at the centre of `selector`, optionally the drop. Returns whether the drop was default-prevented. */
async function dragFilesOnto(page: Page, selector: string, files: Spec[], opts: { drop?: boolean } = {}) {
  const dt = await makeTransfer(page, files);
  return page.evaluate(
    ({ selector, dt, drop }) => {
      const el = document.querySelector(selector) as HTMLElement;
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt as DataTransfer, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new DragEvent('dragenter', init));
      el.dispatchEvent(new DragEvent('dragover', init));
      if (!drop) return null;
      const ev = new DragEvent('drop', init);
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    { selector, dt, drop: opts.drop ?? true },
  );
}

const assetNames = (page: Page) =>
  page.evaluate(() => Object.values((window as any).__oe.getState().project.assets).map((a: any) => a.name as string).sort());

test('files dropped on the player and on the inspector go to the Media pool', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe);
  const url = page.url();
  // start on another library tab: the drop must switch back to Media
  await page.getByTestId('library-tab-text').click();

  // overlay while dragging, not before
  await expect(page.getByTestId('file-drop-overlay')).toHaveCount(0);
  await dragFilesOnto(page, '[data-testid="player"]', [spec(MEDIA.landscape, 'video/mp4')], { drop: false });
  await expect(page.getByTestId('file-drop-overlay')).toBeVisible();
  await expect(page.getByTestId('file-drop-overlay')).toContainText('Drop files to import');
  await page.waitForTimeout(250); // past the fade-in
  await screenshot(page, 'file-drop-01-overlay');
  // dragleave out of the window hides it
  await page.evaluate(() => document.querySelector('[data-testid="player"]')!.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: (() => { const d = new DataTransfer(); d.items.add(new File(['x'], 'x.mp4', { type: 'video/mp4' })); return d; })(), relatedTarget: null })));
  await expect(page.getByTestId('file-drop-overlay')).toHaveCount(0);

  // drop on the player: two files at once
  const prevented = await dragFilesOnto(page, '[data-testid="player"] canvas', [spec(MEDIA.landscape, 'video/mp4'), spec(MEDIA.tone, 'audio/mpeg')]);
  expect(prevented).toBe(true); // the browser does not navigate to the file
  await expect(page.getByTestId('file-drop-overlay')).toHaveCount(0);
  await expect(page.getByTestId('library-tab-media')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`[data-testid="media-asset"][data-asset-name="${MEDIA.landscape}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-testid="media-asset"][data-asset-name="${MEDIA.tone}"]`)).toBeVisible();
  await expect(page.locator('.atile.is-new')).toHaveCount(2); // the new tiles are highlighted
  await screenshot(page, 'file-drop-02-player-imported');
  await expect(page.locator('.atile.is-new')).toHaveCount(0, { timeout: 4000 });
  // pool only: nothing was placed on the timeline
  expect(await page.getByTestId('timeline-clip').count()).toBe(0);
  // same import path as the Import button: real duration and a thumbnail
  const land = await page.evaluate((n) => (Object.values((window as any).__oe.getState().project.assets) as any[]).find((a) => a.name === n), MEDIA.landscape);
  expect(land.duration).toBeGreaterThan(3_500_000);
  expect(land.width).toBe(1920);

  // drop on the inspector: an image plus unsupported files → toast lists the skipped ones
  await dragFilesOnto(page, '[data-testid="inspector"]', [spec(MEDIA.image, 'image/png'), textSpec('notes.pdf', 'application/pdf'), textSpec('readme.txt', 'text/plain')]);
  await expect(page.locator(`[data-testid="media-asset"][data-asset-name="${MEDIA.image}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('toast')).toContainText('Skipped 2 unsupported files: notes.pdf, readme.txt');
  expect(await assetNames(page)).toEqual([MEDIA.tone, MEDIA.image, MEDIA.landscape].sort());
  await screenshot(page, 'file-drop-03-inspector-skipped');

  // the top bar and the library outside the grid work too
  await dragFilesOnto(page, '.topbar', [spec(MEDIA.landscape, 'video/mp4', 'second.mp4')]);
  await expect(page.locator('[data-testid="media-asset"][data-asset-name="second.mp4"]')).toBeVisible({ timeout: 20_000 });
  await dragFilesOnto(page, '.lib-tabs', [spec(MEDIA.image, 'image/png', 'third.png')]);
  await expect(page.locator('[data-testid="media-asset"][data-asset-name="third.png"]')).toBeVisible({ timeout: 20_000 });

  // persistence: the dropped media come back after a reload
  await page.waitForTimeout(2600);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oe && Object.keys((window as any).__oe.getState().project.assets).length === 5, null, { timeout: 20_000 });
  expect(page.url()).toBe(url);
  expect(errors.real()).toEqual([]);
});

test('a drop on the timeline imports and places; internal drags show no overlay', async ({ page }) => {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe);
  // over the timeline the overlay says the files will be placed
  await dragFilesOnto(page, '.tl-row--main', [spec(MEDIA.landscape, 'video/mp4')], { drop: false });
  await expect(page.getByTestId('file-drop-overlay')).toHaveAttribute('data-zone', 'timeline');
  await dragFilesOnto(page, '.tl-row--main', [spec(MEDIA.landscape, 'video/mp4')]);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 20_000 });
  expect(await assetNames(page)).toEqual([MEDIA.landscape]); // imported once, not twice
  await expect(page.getByTestId('file-drop-overlay')).toHaveCount(0);

  // an internal drag (asset tile → timeline) carries our MIME type: no import overlay
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('application/x-our-editor', JSON.stringify({ kind: 'text' }));
    document.querySelector('[data-testid="player"]')!.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(100);
  await expect(page.getByTestId('file-drop-overlay')).toHaveCount(0);
});
