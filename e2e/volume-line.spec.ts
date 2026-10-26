/**
 * Timeline volume line + volume keyframes (src/timeline/VolumeLine.tsx, src/model/volumeKeys.ts):
 * - dragging the line sets the volume (100 % rests a third up, above it is boost), one undo step,
 *   double-click = 100 %
 * - Audio › Basic ◇ adds keyframes at the playhead, the slider edits the key under the playhead,
 *   ‹ › jump between keys; the timeline draws them as diamonds you drag up/down
 * - the preview audio gain follows the keyframe envelope while playing
 */
import { expect, test, type Page } from '@playwright/test';
import { clipsLocator, dragAssetToTimeline, importMedia, mediaPath, openApp, pressShortcut, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const st = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__oe.getState()[f as string](...(a as unknown[])), [fn, args] as const);
const clipOf = (page: Page, type: string) =>
  page.evaluate((ty) => JSON.parse(JSON.stringify((window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === ty))), type);

async function dragY(page: Page, x: number, fromY: number, toY: number) {
  await page.mouse.move(x, fromY);
  await page.mouse.down();
  await page.mouse.move(x, toY, { steps: 6 });
  await page.mouse.up();
}

test('drag the volume line on a video and an audio clip', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [mediaPath('v-landscape-4s.mp4'), mediaPath('a-tone-6s.mp3')]);
  await dragAssetToTimeline(page, 'v-landscape-4s.mp4');
  await dragAssetToTimeline(page, 'a-tone-6s.mp3');
  await expect(clipsLocator(page)).toHaveCount(2);

  for (const type of ['video', 'audio']) {
    const clip = page.locator(`[data-testid="timeline-clip"][data-clip-type="${type}"]`);
    const line = clip.getByTestId('clip-volume-line');
    const hit = clip.getByTestId('clip-volume-hit');
    await expect(line).toHaveAttribute('data-volume-db', '0');
    const cb = (await clip.boundingBox())!;
    const hb = (await hit.boundingBox())!;
    const x = hb.x + hb.width / 2;
    const y0 = hb.y + hb.height / 2;
    expect(y0).toBeGreaterThan(cb.y + cb.height / 2); // rests in the lower part

    // to the middle: boost (~+5 dB)
    await page.mouse.move(x, y0);
    await page.mouse.down();
    await page.mouse.move(x, cb.y + cb.height / 2, { steps: 6 });
    await expect(clip.getByTestId('clip-volume-label')).toHaveText(/^1[5-9]\d%$/);
    await page.mouse.up();
    expect(Number(await line.getAttribute('data-volume-db'))).toBeGreaterThan(3);
    await screenshot(page, `volume-line-${type}`);
    await page.mouse.move(x, cb.y + cb.height + 40);
    await pressShortcut(page, 'Meta+z');
    await expect(line).toHaveAttribute('data-volume-db', '0');

    // to the top = +20 dB, undo
    await dragY(page, x, y0, cb.y - 30);
    await expect(line).toHaveAttribute('data-volume-db', '20');
    await page.mouse.move(x, cb.y + cb.height + 40);
    await pressShortcut(page, 'Meta+z');

    // to the bottom = silence, then double-click back to 100 %
    await dragY(page, x, y0, cb.y + cb.height + 30);
    await expect(line).toHaveAttribute('data-volume-db', '-60');
    const h2 = (await hit.boundingBox())!;
    await page.mouse.dblclick(x, h2.y + h2.height / 2);
    await expect(line).toHaveAttribute('data-volume-db', '0');
  }
});

test('volume keyframes: inspector ◇ ‹ ›, timeline diamonds, preview gain', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [mediaPath('a-tone-6s.mp3')]);
  await dragAssetToTimeline(page, 'a-tone-6s.mp3');
  const clip = page.locator('[data-testid="timeline-clip"][data-clip-type="audio"]');
  await clip.click();
  const c0 = await clipOf(page, 'audio');
  const nav = page.getByTestId('volume-keyframe');
  const toggle = page.getByTestId('volume-keyframe-toggle');
  const volBox = page.getByTestId('volume-row').getByRole('textbox');

  // key 1 at +1 s, 100 %
  await st(page, 'setPlayhead', c0.start + 1_000_000);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // key 2 at +4 s, set to -20 dB with the number box (edits the key under the playhead → creates it)
  await st(page, 'setPlayhead', c0.start + 4_000_000);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await volBox.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('-20');
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  let c = await clipOf(page, 'audio');
  expect(c.audio.volumeKeys.map((k: any) => k.db)).toEqual([0, -20]);
  await expect(clip.getByTestId('clip-volume-key')).toHaveCount(2);

  // halfway the inspector shows the envelope (-10 dB)
  await st(page, 'setPlayhead', c0.start + 2_500_000);
  await expect(volBox).toHaveValue(/-10\.0/);

  // ‹ › jump between the keys
  await nav.getByRole('button', { name: 'Previous keyframe' }).click();
  expect(await page.evaluate(() => (window as any).__oe.getState().playhead)).toBe(c0.start + 1_000_000);
  await nav.getByRole('button', { name: 'Next keyframe' }).click();
  expect(await page.evaluate(() => (window as any).__oe.getState().playhead)).toBe(c0.start + 4_000_000);
  await screenshot(page, 'volume-keyframes');

  // drag the second diamond to the bottom: silence there; one undo step puts it back
  const k2 = (await clip.getByTestId('clip-volume-key').nth(1).boundingBox())!;
  const cb = (await clip.boundingBox())!;
  await dragY(page, k2.x + k2.width / 2, k2.y + k2.height / 2, cb.y + cb.height + 30);
  c = await clipOf(page, 'audio');
  expect(c.audio.volumeKeys[1].db).toBe(-60);
  await pressShortcut(page, 'Meta+z');
  c = await clipOf(page, 'audio');
  expect(c.audio.volumeKeys[1].db).toBe(-20);

  // preview: the live gain follows the envelope (≈1 before key 1, ≈0.1 after key 2)
  const gainAt = async (us: number) => {
    await page.evaluate((t) => {
      const s = (window as any).__oe.getState();
      s.pause();
      s.setPlayhead(t);
      s.play();
    }, us);
    let g = -1;
    await expect
      .poll(async () => {
        const v = (await page.evaluate(() => (window as any).__oeAudio.voices())).find((x: any) => !x.paused);
        g = v ? v.target : -1;
        return g >= 0;
      }, { timeout: 15_000 })
      .toBe(true);
    await page.evaluate(() => (window as any).__oe.getState().pause());
    return g;
  };
  expect(await gainAt(c0.start + 200_000)).toBeCloseTo(1, 1);
  expect(await gainAt(c0.start + 4_500_000)).toBeCloseTo(0.1, 1);

  // removing the last key keeps the level the clip had there
  await st(page, 'setPlayhead', c0.start + 1_000_000);
  await toggle.click();
  await st(page, 'setPlayhead', c0.start + 4_000_000);
  await toggle.click();
  c = await clipOf(page, 'audio');
  expect(c.audio.volumeKeys).toBeUndefined();
  expect(c.audio.volumeDb).toBe(-20);
  await expect(clip.getByTestId('clip-volume-key')).toHaveCount(0);
});
