/**
 * Magnet on a non-main track (src/store/ops.ts rippleTrim): trimming an overlay / audio clip with the
 * magnet on sticks it left and the clips after it follow; magnet off leaves the gap (CapCut).
 */
import { expect, test, type Page } from '@playwright/test';
import { importMedia, mediaPath, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const S = (s: number) => Math.round(s * 1e6);
const clipById = (page: Page, id: string) =>
  page.evaluate((cid) => JSON.parse(JSON.stringify((window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === cid))), id);

async function dragHandle(page: Page, id: string, side: 'left' | 'right', dx: number) {
  const h = page.locator(`[data-clip-id="${id}"] .tl-clip__handle--${side}`);
  const b = (await h.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

for (const kind of ['overlay', 'audio'] as const) {
  test(`magnet on: trimming a ${kind} clip sticks it left and ripples the next one`, async ({ page }) => {
    await openApp(page);
    const file = kind === 'audio' ? 'a-tone-6s.mp3' : 'v-landscape-4s.mp4';
    await importMedia(page, [mediaPath(file)]);
    const [a, b] = await page.evaluate(
      ([name, k, s1]) => {
        const st = () => (window as any).__oe.getState();
        const asset = Object.values(st().project.assets).find((x: any) => x.name === name) as any;
        const a = st().addClip(asset.id, { at: 0, kind: k });
        const trackId = st().project.tracks.find((t: any) => t.clips.some((c: any) => c.id === a)).id;
        const b = st().addClip(asset.id, { at: s1, trackId });
        return [a, b];
      },
      [file, kind, S(kind === 'audio' ? 7 : 5)] as const,
    );
    expect(await page.evaluate(() => (window as any).__oe.getState().magnet)).toBe(true);
    const a0 = await clipById(page, a);
    const b0 = await clipById(page, b);

    // left edge of A in: A keeps its start, its in-point moves; B moves left by the same amount
    await dragHandle(page, a, 'left', 60);
    const a1 = await clipById(page, a);
    const b1 = await clipById(page, b);
    expect(a1.start).toBe(a0.start);
    expect(a1.inPoint).toBeGreaterThan(0);
    const cut = a0.duration - a1.duration;
    expect(cut).toBeGreaterThan(S(0.3));
    expect(b0.start - b1.start).toBe(cut);
    await screenshot(page, `magnet-ripple-${kind}`);

    // right edge of A in: B follows, the gap between them is kept
    const gap = b1.start - (a1.start + a1.duration);
    await dragHandle(page, a, 'right', -40);
    const a2 = await clipById(page, a);
    const b2 = await clipById(page, b);
    expect(b2.start - (a2.start + a2.duration)).toBe(gap);

    // magnet off: the old CapCut behaviour, the trimmed edge leaves a gap
    await page.evaluate(() => (window as any).__oe.getState().setMagnet(false));
    await dragHandle(page, b, 'left', 40);
    const b3 = await clipById(page, b);
    expect(b3.start).toBeGreaterThan(b2.start);
  });
}
