/**
 * Motion keyframes (src/model/motionKeys.ts, src/inspector/motionKeyframes.tsx,
 * src/timeline/MotionKeyLine.tsx, src/actions/motionKeys.ts):
 * - Video › Basic › Transform: Position ◇ adds a key, the number box adds the second key at the
 *   playhead; the preview (selection box + pixels) is interpolated half-way; Keyframe curve bends it
 * - timeline diamonds: click = playhead there, double-click = remove
 * - ⌥K keys position + scale + rotation; dragging the clip on the canvas edits the key (one undo)
 * - Ken Burns one-click; export frames match the preview mid-way between keys
 *
 * Run: cd e2e && E2E_PORT=5402 npx playwright test motion-keys.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, imageRgb, videoFrame } from './audit-helpers';
import { importMedia, mediaPath, openApp, pressShortcut, screenshot, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(here, 'test-results', 'motion-keys-tmp');
const S = (s: number) => Math.round(s * 1e6);

const st = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__oe.getState()[f as string](...(a as unknown[])), [fn, args] as const);
const theClip = (page: Page) =>
  page.evaluate(() => JSON.parse(JSON.stringify((window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === 'video'))));
const playhead = (page: Page) => page.evaluate(() => (window as any).__oe.getState().playhead as number);

async function settle(page: Page) {
  await page.evaluate(async () => {
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    for (let i = 0; i < 200; i++) {
      await raf();
      if (![...document.querySelectorAll('video')].some((v) => v.src && (v.seeking || v.readyState < 2))) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    for (let i = 0; i < 6; i++) await raf();
  });
}
async function seek(page: Page, t: number) {
  await st(page, 'setPlayhead', t);
  await settle(page);
}

/** Pixel (project coords) of the player canvas. */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    ({ x, y }) => {
      const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
      const k = c.width / (window as any).__oe.getState().project.settings.width;
      const d = c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
      return (d[0]! + d[1]! + d[2]!) / 3;
    },
    { x, y },
  );

/** Centre of the selection box relative to the canvas centre, project px. */
async function selCentre(page: Page) {
  const W = await page.evaluate(() => (window as any).__oe.getState().project.settings.width);
  const cv = (await page.getByTestId('player-canvas').boundingBox())!;
  const sb = (await page.getByTestId('player-selection').boundingBox())!;
  const k = cv.width / W;
  return { x: (sb.x + sb.width / 2 - (cv.x + cv.width / 2)) / k, y: (sb.y + sb.height / 2 - (cv.y + cv.height / 2)) / k, w: sb.width / k };
}

async function setupVideo(page: Page) {
  await openApp(page);
  await importMedia(page, [mediaPath('v-landscape-4s.mp4')]);
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    s.addClip(Object.keys(s.project.assets)[0], { at: 0, kind: 'main' });
  });
  const clip = page.locator('[data-testid="timeline-clip"][data-clip-type="video"]');
  await clip.click();
  await expect(page.getByTestId('section-transform')).toBeVisible();
  return clip;
}

test('position keys from the inspector: interpolated preview, curve, diamonds, ⌥K, canvas drag', async ({ page }) => {
  const clip = await setupVideo(page);
  const posX = page.getByRole('textbox', { name: 'Position X' });
  const posToggle = page.getByTestId('position-keyframe-toggle');

  // key 1 at 0.5 s (x = 0), key 2 at 2.5 s typed into the box (x = 300) → added at the playhead
  await seek(page, S(0.5));
  await posToggle.click();
  await expect(posToggle).toHaveAttribute('aria-pressed', 'true');
  await seek(page, S(2.5));
  await expect(posToggle).toHaveAttribute('aria-pressed', 'false');
  await posX.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('300');
  await page.keyboard.press('Enter');
  await expect(posToggle).toHaveAttribute('aria-pressed', 'true');
  let c = await theClip(page);
  expect(c.motionKeys.position.map((k: any) => k.v)).toEqual([
    [0, 0],
    [300, 0],
  ]);
  expect(c.transform.x).toBe(0); // the plain value is untouched

  // half-way: inspector, selection box and pixels all at x = 150
  await seek(page, S(1.5));
  await expect(posX).toHaveValue('150');
  const mid = await selCentre(page);
  expect(Math.abs(mid.x - 150)).toBeLessThan(3);
  // the 1080-wide picture moved 150 px right: x = 100 is now black, x = 200 is a bar
  expect(await pixel(page, 100, 960)).toBeLessThan(10);
  expect(await pixel(page, 200, 960)).toBeGreaterThan(60);
  await seek(page, S(0.2)); // before key 1: held at 0
  expect(await pixel(page, 100, 960)).toBeGreaterThan(60);
  await seek(page, S(1.5));
  await screenshot(page, 'motion-keys-midway');

  // timeline: two diamonds; click the first = playhead to it
  const keys = clip.getByTestId('clip-motion-key');
  await expect(keys).toHaveCount(2);
  await keys.nth(0).locator('rect').first().click({ force: true });
  expect(await playhead(page)).toBe(S(0.5));

  // curve: ease in from key 1 → half-way is well short of 150
  const curve = page.getByTestId('keyframe-curve');
  await expect(curve).toHaveValue('linear');
  await curve.selectOption('ease-in');
  await seek(page, S(1.5));
  expect(Number(await posX.inputValue())).toBeLessThan(100);
  await expect(curve).toHaveCount(0); // no key under the playhead
  await pressShortcut(page, 'Meta+z');
  await expect(posX).toHaveValue('150');

  // ‹ › navigation
  const nav = page.getByTestId('position-keyframe');
  await nav.getByRole('button', { name: 'Next keyframe' }).click();
  expect(await playhead(page)).toBe(S(2.5));

  // ⌥K at 3.5 s: position + scale + rotation keys; again removes them
  await seek(page, S(3.5));
  await pressShortcut(page, 'Alt+k');
  c = await theClip(page);
  expect(c.motionKeys.position).toHaveLength(3);
  expect(c.motionKeys.scale).toHaveLength(1);
  expect(c.motionKeys.rotation).toHaveLength(1);
  await expect(page.getByTestId('transform-keyframe-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(keys).toHaveCount(3);

  // drag the picture on the canvas at 3.5 s: the key there moves; one undo step puts it back
  const sb = (await page.getByTestId('player-selection').boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 - 20, sb.y + sb.height / 2 + 30, { steps: 5 });
  await page.mouse.move(sb.x + sb.width / 2 - 40, sb.y + sb.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  c = await theClip(page);
  const k3 = c.motionKeys.position[2].v;
  expect(k3[0]).toBeLessThan(300);
  expect(k3[1]).toBeGreaterThan(0);
  expect(c.motionKeys.position).toHaveLength(3);
  expect(c.transform.x).toBe(0);
  await screenshot(page, 'motion-keys-canvas-drag');
  await pressShortcut(page, 'Meta+z');
  c = await theClip(page);
  expect(c.motionKeys.position[2].v).toEqual([300, 0]);

  await pressShortcut(page, 'Alt+k');
  c = await theClip(page);
  expect(c.motionKeys.scale).toBeUndefined();
  expect(c.motionKeys.position).toHaveLength(2);

  // drag the second diamond 0.5 s to the left (zoom px/s from the store): the key moves in time
  const zoom = await page.evaluate(() => (window as any).__oe.getState().zoom as number);
  const kb = (await keys.nth(1).boundingBox())!;
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  await page.mouse.move(kb.x + kb.width / 2 - zoom * 0.25, kb.y + kb.height / 2, { steps: 4 });
  await page.mouse.move(kb.x + kb.width / 2 - zoom * 0.5, kb.y + kb.height / 2, { steps: 4 });
  await page.mouse.up();
  c = await theClip(page);
  expect(Math.abs(c.motionKeys.position[1].src - (c.inPoint + S(2)))).toBeLessThanOrEqual(S(1 / 30));
  expect(c.motionKeys.position[1].v).toEqual([300, 0]);
  await pressShortcut(page, 'Meta+z');
  c = await theClip(page);
  expect(c.motionKeys.position[1].src).toBe(c.inPoint + S(2.5));

  // double-click the second diamond: removes it
  await keys.nth(1).locator('rect').first().dblclick({ force: true });
  c = await theClip(page);
  expect(c.motionKeys.position).toHaveLength(1);
  await expect(keys).toHaveCount(1);
});

test('Ken Burns + rotation / opacity keys: export frames match the preview', async ({ page }) => {
  test.setTimeout(180_000);
  await setupVideo(page);
  await page.getByTestId('ken-burns-in').click();
  let c = await theClip(page);
  expect(c.motionKeys.scale.map((k: any) => +k.v[0].toFixed(2))).toEqual([1, 1.15]);
  // rotation 0 → 20° and opacity 100 → 40 % over the clip, from the inspector
  await seek(page, c.start);
  await page.getByTestId('rotation-keyframe-toggle').click();
  await page.getByTestId('opacity-keyframe-toggle').click();
  await seek(page, c.start + c.duration - S(0.1));
  const rot = page.getByRole('textbox', { name: 'Rotate' });
  await rot.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  const op = page.getByTestId('opacity-row').getByRole('textbox');
  await op.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('40');
  await page.keyboard.press('Enter');
  c = await theClip(page);
  expect(c.motionKeys.rotation.map((k: any) => k.v[0])).toEqual([0, 20]);
  expect(c.motionKeys.opacity.map((k: any) => k.v[0])).toEqual([1, 0.4]);
  await st(page, 'clearSelection');

  // export at 720p / 30 fps
  await page.mouse.move(5, 5);
  await page.getByTestId('export-button').click();
  const dlg = page.getByTestId('export-dialog');
  await page.getByTestId('export-resolution').selectOption('720p');
  await page.getByTestId('export-fps').selectOption('30');
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 150_000);
  await expect(dlg.getByText(/Exported/)).toBeVisible();
  await page.keyboard.press('Escape');

  const p = await page.evaluate(() => (window as any).__oe.getState().project.settings);
  const w = Math.round(p.width / 12);
  const h = Math.round(p.height / 12);
  fs.mkdirSync(TMP, { recursive: true });
  const frames: Record<number, ReturnType<typeof videoFrame>> = {};
  for (const n of [3, 60, 110]) {
    const t = Math.round((n * 1e6) / 30);
    await seek(page, t);
    await page.waitForTimeout(300);
    await settle(page);
    const png = path.join(TMP, `preview-${n}.png`);
    const data = await page.evaluate(() => (document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement).toDataURL('image/png'));
    fs.writeFileSync(png, Buffer.from(data.split(',')[1]!, 'base64'));
    const exp = videoFrame(file, n, w, h);
    frames[n] = exp;
    const cmp = compare(exp, imageRgb(png, w, h));
    console.log('MOTION', JSON.stringify({ frame: n, mad: +cmp.mad.toFixed(2), psnr: +cmp.psnr.toFixed(1) }));
    expect.soft(cmp.mad, `frame ${n}: preview vs export`).toBeLessThanOrEqual(6);
    expect.soft(cmp.psnr, `frame ${n}: preview vs export`).toBeGreaterThanOrEqual(28);
  }
  await screenshot(page, 'motion-keys-kenburns-end');
  // the motion really happened in the file: start and middle frames differ clearly
  expect(compare(frames[3]!, frames[60]!).mad).toBeGreaterThan(8);
  fs.rmSync(file, { force: true });
});
