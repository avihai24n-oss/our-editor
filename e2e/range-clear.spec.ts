/** In–Out range look: outside the range is greyed out; the pill's Clear button is reachable (the hover time label hides) and clearing removes the range and the grey. */
import { expect, test } from '@playwright/test';
import { importMedia, mediaPath, openApp, screenshot } from './helpers';
test('range: grey outside, Clear button removes it', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [mediaPath('v-landscape-4s.mp4')]);
  await page.evaluate(() => { const s = (window as any).__oe.getState(); s.addClip(Object.keys(s.project.assets)[0], { at: 0, kind: 'main' }); s.setPlayhead(1_000_000); });
  await page.keyboard.press('i');
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(3_000_000));
  await page.keyboard.press('o');
  const clear = page.getByTestId('timeline-area-clear');
  await clear.hover();
  await expect(page.getByTestId('timeline-hover-head')).toBeHidden();
  await screenshot(page, 'range-pill-hover');
  await expect(page.locator('.tl-area-dim')).toHaveCount(4); // ruler + tracks, before + after
  await clear.click();
  await expect(page.getByTestId('timeline-area')).toHaveCount(0);
  await expect(page.locator('.tl-area-dim')).toHaveCount(0);
});
