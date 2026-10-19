/**
 * Export watchdog (integration bug fix): an export whose frame never completes must fail with a
 * visible error instead of hanging silently, and the next export must work.
 * The hang is injected through the dev-only window.__oeExportFault hook (src/export/watchdog.ts).
 */
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, expectMediaFile, importMedia, MEDIA, openApp, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

test('a stalled export fails loudly within the watchdog time, and the next export succeeds', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await openApp(page);
  await importMedia(page, [MEDIA.vertical]);
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const a = Object.values(s.project.assets)[0] as { id: string };
    const id = s.addClip(a.id, { at: 0 });
    (window as any).__oe.getState().setSpeed(id, 0.5); // the 0.5x case from the Speed-tab report
    (window as any).__oeExportFault = { hangAtFrame: 30, stallMs: 3000 };
  });

  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  const t0 = Date.now();
  await page.getByTestId('export-confirm').click();
  const alert = page.locator('.export__error[role="alert"]');
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).toContainText('stopped responding at video frame 31 /');
  const waited = (Date.now() - t0) / 1000;
  console.log(`stall reported after ${waited.toFixed(1)} s: ${await alert.textContent()}`);
  expect(waited).toBeLessThan(25);

  // no fault: the same dialog exports normally
  await page.evaluate(() => delete (window as any).__oeExportFault);
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 90_000);
  expectMediaFile(file, { hasVideo: true });
  expect(errors.real()).toEqual([]);
});
