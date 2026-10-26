/**
 * Toolbar ↔ / ↕ toggle (Toolbar.tsx ZoomModeToggle): in ↕ mode the zoom slider and − + set the
 * track height; clips (filmstrip, waveform) grow with it, dragging between tracks still works, the
 * choice survives a reload, and ↔ mode drives the timeline zoom again.
 */
import { expect, test } from '@playwright/test';
import { dragAssetToTimeline, importMedia, mediaPath, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('track height toggle', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [mediaPath('v-landscape-4s.mp4'), mediaPath('a-tone-6s.mp3')]);
  await dragAssetToTimeline(page, 'v-landscape-4s.mp4');
  await dragAssetToTimeline(page, 'a-tone-6s.mp3');
  const video = page.locator('[data-testid="timeline-clip"][data-clip-type="video"]');
  const h0 = (await video.boundingBox())!.height;
  const zoom0 = await page.evaluate(() => (window as any).__oe.getState().zoom);

  await expect(page.getByTestId('timeline-zoom')).toBeVisible();
  await page.getByTestId('zoom-mode').click();
  await expect(page.getByTestId('zoom-mode')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('track-height')).toBeVisible();
  await page.getByTestId('track-height').fill('200'); // 200 %
  await expect.poll(async () => (await video.boundingBox())!.height).toBeGreaterThan(h0 * 1.8);
  await page.getByTestId('track-height-up').click();
  await expect.poll(async () => (await video.boundingBox())!.height).toBeGreaterThan(h0 * 2.2);
  expect(await page.evaluate(() => (window as any).__oe.getState().zoom)).toBe(zoom0); // time zoom untouched
  await screenshot(page, 'track-height-tall');

  // drag the video clip up into the empty band above → a new overlay track, still works when tall
  const b = (await video.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y - 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__oe.getState().project.tracks.find((t: any) => t.clips.some((c: any) => c.type === 'video'))?.kind)).toBe('overlay');

  // survives a reload
  await page.reload();
  await expect(page.getByTestId('zoom-mode')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await page.locator('[data-testid="timeline-clip"][data-clip-type="video"]').boundingBox())!.height).toBeGreaterThan(h0 * 1.8);

  // fit button in ↕ mode = default height; ↔ mode = zoom again
  await page.getByTestId('timeline-fit').click();
  await expect.poll(async () => Math.round((await page.locator('[data-testid="timeline-clip"][data-clip-type="video"]').boundingBox())!.height)).toBeLessThan(h0 + 20);
  await page.getByTestId('zoom-mode').click();
  await expect(page.getByTestId('timeline-zoom')).toBeVisible();
  await page.getByTestId('timeline-zoom').fill('80');
  await expect.poll(() => page.evaluate(() => (window as any).__oe.getState().zoom)).not.toBe(zoom0);
});
