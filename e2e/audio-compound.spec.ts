/** ⌥G on music only makes an AUDIO compound clip that stays on the audio track (was: jumped up to a video track). */
import { expect, test } from '@playwright/test';
import { importMedia, mediaPath, openApp, pressShortcut, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('⌥G on two music clips keeps the compound on the audio track', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [mediaPath('a-tone-6s.mp3'), mediaPath('v-landscape-4s.mp4')]);
  const ids = await page.evaluate(() => {
    const st = () => (window as any).__oe.getState();
    const by = (n: string) => (Object.values(st().project.assets) as any[]).find((x) => x.name === n).id;
    st().addClip(by('v-landscape-4s.mp4'), { at: 0, kind: 'main' });
    const a = st().addClip(by('a-tone-6s.mp3'), { at: 0 });
    st().trimEnd(a, 2_000_000);
    const b = st().addClip(by('a-tone-6s.mp3'), { at: 2_000_000 });
    st().trimEnd(b, 4_000_000);
    st().select([a, b]);
    return [a, b];
  });
  expect(ids).toHaveLength(2);
  await pressShortcut(page, 'Alt+g');
  const kinds = await page.evaluate(() => (window as any).__oe.getState().project.tracks.map((t: any) => `${t.kind}:${t.clips.map((c: any) => c.type).join(',')}`));
  expect(kinds).toContain('audio:compound');
  expect(kinds.filter((k: string) => k.startsWith('overlay'))).toEqual([]);
  const clip = page.locator('[data-testid="timeline-clip"][data-clip-type="compound"]');
  const main = page.locator('[data-testid="timeline-clip"][data-clip-type="video"]');
  expect((await clip.boundingBox())!.y).toBeGreaterThan((await main.boundingBox())!.y); // drawn below the video
  await screenshot(page, 'audio-compound');
  // dragging it up onto the video area does not move it there
  const b = (await clip.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y - 200, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => (window as any).__oe.getState().project.tracks.find((t: any) => t.clips.some((c: any) => c.type === 'compound')).kind);
  expect(after).toBe('audio');
});
