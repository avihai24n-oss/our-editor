import { expect, test } from '@playwright/test';
import { collectConsoleErrors, REQUIRED_REGIONS, screenshot } from './helpers';

test.describe('smoke', () => {
  test('app opens with the four regions, export button and no console errors', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    for (const id of REQUIRED_REGIONS) {
      await expect(page.getByTestId(id).first(), `missing data-testid="${id}"`).toBeVisible();
    }

    // WebCodecs must be available on localhost (secure context) for preview/export.
    const env = await page.evaluate(() => ({
      secure: window.isSecureContext,
      videoDecoder: typeof VideoDecoder !== 'undefined',
      videoEncoder: typeof VideoEncoder !== 'undefined',
    }));
    expect(env).toEqual({ secure: true, videoDecoder: true, videoEncoder: true });

    await screenshot(page, 'smoke-main-window');
    expect(consoleErrors.real(), consoleErrors.real().join('\n')).toEqual([]);
  });
});
