/**
 * Linkage (src/store/ops.ts followAttached): Avihai's layout — shots side by side on an OVERLAY
 * track (main track empty), the voice of shots 2 and 3 under them on an audio track, music from 0
 * on another. Magnet on: trimming shot 1's end by its handle ripples shots 2, 3 left AND their
 * voices with them; the music (attached to shot 1) stays. Linkage off: the voices stay.
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

test('linkage: trimming a shot on an overlay track carries the voices of the next shots; the music stays', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [mediaPath('v-framecode-12s.mp4'), mediaPath('a-tone-6s.mp3')]);
  const ids = await page.evaluate(
    ([s4, s8, s12, s3]) => {
      const st = () => (window as any).__oe.getState();
      const asset = (n: string) => (Object.values(st().project.assets) as any[]).find((x) => x.name === n).id;
      const v = asset('v-framecode-12s.mp4');
      const a = asset('a-tone-6s.mp3');
      st().setZoom(100);
      st().setSnapping(false);
      const V1 = st().addClip(v, { at: 0, kind: 'overlay' });
      st().trimEnd(V1, s4);
      const ov = st().project.tracks.find((t: any) => t.clips.some((c: any) => c.id === V1)).id;
      const V2 = st().addClip(v, { at: s4, trackId: ov });
      st().trimEnd(V2, s8);
      const V3 = st().addClip(v, { at: s8, trackId: ov });
      st().trimEnd(V3, s12);
      const a2 = st().addClip(a, { at: s4 });
      st().trimEnd(a2, s4 + s3);
      const au = st().project.tracks.find((t: any) => t.clips.some((c: any) => c.id === a2)).id;
      const a3 = st().addClip(a, { at: s8, trackId: au });
      st().trimEnd(a3, s8 + s3);
      const m = st().addClip(a, { at: 0 }); // "music" 0-6 s, under shots 1 and 2
      st().clearSelection();
      return { V1, V2, V3, a2, a3, m };
    },
    [S(4), S(8), S(12), S(3)] as const,
  );
  const { V1, m } = ids;
  expect(await page.evaluate(() => [(window as any).__oe.getState().magnet, (window as any).__oe.getState().linkage])).toEqual([true, true]);
  expect(await page.getByTestId('timeline-linkage').getAttribute('title')).toContain('move with the main / overlay clip under their start');
  const pos = async () => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, (await clipById(page, id)).start] as const)));
  const before = await pos();
  expect(before).toEqual({ V1: 0, V2: S(4), V3: S(8), a2: S(4), a3: S(8), m: 0 });
  const mDur = (await clipById(page, m)).duration;
  await screenshot(page, 'linkage-before');

  // linkage ON: drag shot 1's right handle 100 px (= 1 s) left
  const steps = await page.evaluate(() => (window as any).__oe.getState().past.length);
  await dragHandle(page, V1, 'right', -100);
  const v1 = await clipById(page, V1);
  const cut = S(4) - v1.duration;
  expect(cut).toBeGreaterThan(S(0.8));
  const after = await pos();
  expect(after).toEqual({ V1: 0, V2: S(4) - cut, V3: S(8) - cut, a2: S(4) - cut, a3: S(8) - cut, m: 0 });
  expect((await clipById(page, m)).duration).toBe(mDur);
  expect(await page.evaluate(() => (window as any).__oe.getState().past.length)).toBe(steps + 1); // one undo step
  await screenshot(page, 'linkage-on-trimmed');

  // ⌘Z puts everything back
  await page.evaluate(() => (window as any).__oe.getState().undo());
  expect(await pos()).toEqual(before);

  // linkage OFF (toolbar toggle): the shots ripple, the voices stay where they were
  await page.getByTestId('timeline-linkage').click();
  expect(await page.evaluate(() => (window as any).__oe.getState().linkage)).toBe(false);
  await dragHandle(page, V1, 'right', -100);
  const off = await pos();
  const cut2 = S(4) - (await clipById(page, V1)).duration;
  expect(off).toEqual({ V1: 0, V2: S(4) - cut2, V3: S(8) - cut2, a2: S(4), a3: S(8), m: 0 });
  await screenshot(page, 'linkage-off-trimmed');
  await page.getByTestId('timeline-linkage').click();
});
