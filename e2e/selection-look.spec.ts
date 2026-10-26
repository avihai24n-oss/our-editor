/** Visual check: the selected clip has a frame above its content (src/timeline/timeline.css). */
import { expect, test } from '@playwright/test';
import { importMedia, mediaPath, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('a selected video / audio clip is clearly framed', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [mediaPath('v-landscape-4s.mp4'), mediaPath('a-tone-6s.mp3')]);
  const ids = await page.evaluate(() => {
    const st = () => (window as any).__oe.getState();
    const by = (n: string) => (Object.values(st().project.assets) as any[]).find((x) => x.name === n).id;
    return [st().addClip(by('v-landscape-4s.mp4'), { at: 0, kind: 'main' }), st().addClip(by('v-landscape-4s.mp4'), { at: 4e6, kind: 'main' }), st().addClip(by('a-tone-6s.mp3'), { at: 0, kind: 'audio' })];
  });
  await page.locator(`[data-clip-id="${ids[1]}"]`).click();
  await expect(page.locator(`[data-clip-id="${ids[1]}"]`)).toHaveAttribute('data-selected', 'true');
  const before = await page.locator(`[data-clip-id="${ids[1]}"]`).evaluate((el) => getComputedStyle(el, '::before').borderTopWidth);
  expect(parseFloat(before)).toBeGreaterThanOrEqual(2);
  await screenshot(page, 'selection-video');
  await page.locator(`[data-clip-id="${ids[2]}"]`).click({ position: { x: 60, y: 6 } });
  await screenshot(page, 'selection-audio');
});
