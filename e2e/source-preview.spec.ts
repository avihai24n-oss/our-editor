/**
 * Source preview (CapCut): a click on a media-bin item shows THAT file in the player — its own
 * pixels, its own play/pause and timecode — without touching the timeline. Double-click does not
 * add a clip. A click on the timeline goes back to the timeline frame.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { boot, clips, plusOn, settledSig, sigDiff, state, tile } from './audit-helpers';
import { canvasRGB, mae } from './audit/render';
import { collectConsoleErrors, MEDIA, mediaPath } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Frame 0 of a test-media file, scaled to w×h RGB. */
function frame0(file: string, w: number, h: number): Uint8Array {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', mediaPath(file), '-vf', `select=eq(n\\,0),scale=${w}:${h}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return new Uint8Array(out);
}

const sourceTime = (page: Page) => page.evaluate(() => (window as any).__oeSource.getState().time as number);

test('source preview: click shows the file, Space plays it, double-click does not add, timeline click returns', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await boot(page);
  await page.getByTestId('media-import-input').setInputFiles([mediaPath(MEDIA.vertical), mediaPath(MEDIA.landscape)]);
  for (const f of [MEDIA.vertical, MEDIA.landscape]) await expect(tile(page, f)).toBeVisible({ timeout: 30_000 });

  // the timeline has the vertical clip; remember its frame
  await plusOn(page, MEDIA.vertical);
  await expect.poll(async () => (await clips(page)).length).toBe(1);
  await page.keyboard.press('Escape'); // deselect the new clip
  const timelineSig = await settledSig(page);
  const playhead0 = await state(page, '(s) => s.playhead');

  // click the landscape tile → the canvas shows the SMPTE bars, letterboxed in the 9:16 frame
  await tile(page, MEDIA.landscape).click();
  await expect(page.getByTestId('player-header')).toHaveText(`Media · ${MEDIA.landscape}`);
  // 1920×1080 in 1080×1920: the picture is the band y = 0.3418 … 0.6582
  const band = { y0: (1920 - 1080 * (1080 / 1920)) / 2 / 1920, y1: 1 - (1920 - 1080 * (1080 / 1920)) / 2 / 1920 };
  const want = frame0(MEDIA.landscape, 32, 18);
  await expect.poll(async () => mae(await canvasRGB(page, 32, 18, { y0: band.y0 + 0.003, y1: band.y1 - 0.003 }), want), { timeout: 10_000 }).toBeLessThan(14);
  // and the rest of the canvas is the black letterbox
  const top = await canvasRGB(page, 8, 4, { y0: 0, y1: 0.3 });
  expect(Math.max(...top)).toBeLessThan(10);
  await expect(page.getByTestId('timecode')).toContainText('00:00:04');

  // Space plays the SOURCE: its time advances, the timeline playhead does not move
  await page.keyboard.press('Space');
  await expect.poll(() => sourceTime(page), { timeout: 5000 }).toBeGreaterThan(400_000);
  expect(await state(page, '(s) => s.playing')).toBe(false);
  expect(await state(page, '(s) => s.playhead')).toBe(playhead0);
  await page.keyboard.press('Space');
  const paused = await sourceTime(page);
  await page.waitForTimeout(300);
  expect(Math.abs((await sourceTime(page)) - paused)).toBeLessThan(50_000);

  // the seek bar scrubs the source
  const seek = page.getByTestId('source-seek');
  await expect(seek).toBeVisible();
  await seek.fill('2000000');
  await expect.poll(() => sourceTime(page)).toBeGreaterThan(1_900_000);
  expect(await state(page, '(s) => s.playhead')).toBe(playhead0);

  // no undo steps from any of this
  expect(await state(page, '(s) => s.past.length')).toBe(1);

  // double-click a tile: no clip is added
  await tile(page, MEDIA.landscape).dblclick();
  await page.waitForTimeout(300);
  expect((await clips(page)).length).toBe(1);

  // click on the timeline (the ruler / an empty track area) → back to the timeline frame
  const tl = page.getByTestId('timeline');
  const box = (await tl.boundingBox())!;
  await page.mouse.click(box.x + box.width - 60, box.y + box.height - 20);
  await expect(page.getByTestId('player-header')).toHaveText('Player');
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(0));
  const back = await settledSig(page);
  expect(sigDiff(back, timelineSig)).toBeLessThan(3);
  // the source element is gone
  expect(await page.evaluate(() => (window as any).__oeSource.elements())).toBe(0);

  // Esc also leaves the mode
  await tile(page, MEDIA.landscape).click();
  await expect(page.getByTestId('player-header')).toHaveText(`Media · ${MEDIA.landscape}`);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('player-header')).toHaveText('Player');
  expect(sigDiff(await settledSig(page), timelineSig)).toBeLessThan(3);
  expect(errors.real()).toEqual([]);
});
