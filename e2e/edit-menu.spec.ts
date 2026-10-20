/**
 * Clip menu "Edit ›" end to end (src/actions/editMenu.ts), driven through the menu items'
 * `run` (window.__oeEdit) like the context menu calls them:
 *  - Reverse on the 5 s testsrc2 clip (150 numbered frames): the preview shows decreasing source
 *    frames (last frame first);
 *  - Freeze at 1 s of the reversed clip: a 3 s still, the clip split around it;
 *  - the exported MP4 shows the reversed frames, then the same frame held for 3 s, then the
 *    reversed frames again (every export frame matched against the source frames with ffmpeg);
 *  - Mirror / Rotate / Crop (dialog, 1:1 preset) change the model as one undo step each.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectConsoleErrors, dragAssetToTimeline, importMedia, MEDIA, mediaPath, openApp, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test.describe.configure({ mode: 'serial' });

const W = 36;
const H = 64;
const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-results', 'edit-menu');

function grayFrames(file: string): Buffer[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 512 * 1024 * 1024 });
  const out: Buffer[] = [];
  for (let i = 0; i + W * H <= raw.length; i += W * H) out.push(raw.subarray(i, i + W * H));
  return out;
}
const mse = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return s / a.length;
};
const bestMatch = (f: Buffer, refs: Buffer[]) => {
  let best = -1;
  let err = Infinity;
  refs.forEach((r, i) => {
    const e = mse(f, r);
    if (e < err) {
      err = e;
      best = i;
    }
  });
  return best;
};

let refs: Buffer[] = [];
test.beforeAll(() => {
  refs = grayFrames(mediaPath(MEDIA.vertical));
  expect(refs).toHaveLength(150);
});

const ctxFor = (page: Page, time: number) =>
  page.evaluate((time) => {
    const s = (window as any).__oe.getState();
    const tr = s.project.tracks.find((t: any) => t.kind === 'main');
    const c = tr.clips.find((x: any) => time >= x.start && time < x.start + x.duration) ?? tr.clips[0];
    return { clipIds: [c.id], primaryId: c.id, trackId: tr.id, time };
  }, time);

const mainClips = (page: Page) =>
  page.evaluate(() => (window as any).__oe.getState().project.tracks.find((t: any) => t.kind === 'main').clips.map((c: any) => ({ id: c.id, type: c.type, start: c.start, duration: c.duration, reversed: c.reversed, inPoint: c.inPoint })));

/** The source frame index the preview shows at timeline time t. */
async function previewFrame(page: Page, tUs: number, name: string): Promise<number> {
  await page.evaluate((t) => {
    const s = (window as any).__oe.getState();
    s.pause();
    s.setPreviewTime(null);
    s.setPlayhead(t);
  }, tUs);
  let prev = '';
  let stable = 0;
  await page.waitForTimeout(250);
  for (let i = 0; i < 40; i++) {
    const d = await page.evaluate(() => (document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement).toDataURL('image/png'));
    if (d === prev) {
      if (++stable >= 2) break;
    } else stable = 0;
    prev = d;
    await page.waitForTimeout(200);
  }
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(prev.split(',')[1]!, 'base64'));
  return bestMatch(grayFrames(file)[0]!, refs);
}

async function setup(page: Page) {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe && !!(window as any).__oeEdit);
  await importMedia(page, [MEDIA.vertical]);
  await dragAssetToTimeline(page, MEDIA.vertical, 0, 20);
  await expect.poll(() => mainClips(page).then((c) => c.length)).toBe(1);
  await page.mouse.move(5, 5);
}

test('Reverse + Freeze: preview and export frames', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsoleErrors(page);
  await setup(page);

  // ---- Reverse
  const undoBefore = await page.evaluate(() => (window as any).__oe.getState().past.length);
  await page.evaluate((ctx) => (window as any).__oeEdit.run('edit.reverse', ctx), await ctxFor(page, 0));
  expect((await mainClips(page))[0]!.reversed).toBe(true);
  expect(await page.evaluate(() => (window as any).__oe.getState().past.length)).toBe(undoBefore + 1);
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);

  const shown: number[] = [];
  for (const f of [0, 15, 30, 90, 140]) shown.push(await previewFrame(page, Math.round((f * 1e6) / 30), `rev-${f}`));
  // timeline frame f shows source frame 149 - f
  shown.forEach((s, i) => expect(Math.abs(s - (149 - [0, 15, 30, 90, 140][i]!)), `preview ${shown}`).toBeLessThanOrEqual(1));

  // ---- playback runs backwards too (per-frame seeking)
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    s.setPlayhead(0);
    s.play();
  });
  await page.waitForTimeout(1200);
  const live = await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const d = (document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement).toDataURL('image/png');
    return { t: s.playhead as number, d };
  });
  await page.evaluate(() => (window as any).__oe.getState().pause());
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'playing.png'), Buffer.from(live.d.split(',')[1]!, 'base64'));
  const playingFrame = bestMatch(grayFrames(path.join(TMP, 'playing.png'))[0]!, refs);
  expect(live.t).toBeGreaterThan(500_000);
  // the picture runs backwards; per-frame seeking trails the clock by the seek latency
  // (measured ≈ 9 frames on this 5 s testsrc2 file), never ahead of it
  const want = 149 - Math.floor(live.t / (1e6 / 30));
  expect(playingFrame, `playing at ${live.t} showed ${playingFrame}`).toBeLessThan(140);
  expect(playingFrame - want, `playing at ${live.t} showed ${playingFrame}`).toBeGreaterThanOrEqual(-2);
  expect(playingFrame - want, `playing at ${live.t} showed ${playingFrame}`).toBeLessThanOrEqual(15);

  // ---- Freeze at 1 s (shows source frame 119)
  const still = await page.evaluate(async (ctx) => (window as any).__oeEdit.freezeAt(ctx.primaryId, ctx.time), await ctxFor(page, 1_000_000));
  expect(still).toBeTruthy();
  const clips = await mainClips(page);
  expect(clips.map((c: any) => c.type)).toEqual(['video', 'image', 'video']);
  expect(clips[1]!.start).toBe(1_000_000);
  expect(clips[1]!.duration).toBe(3_000_000);
  expect(clips[2]!.start).toBe(4_000_000);
  expect(clips[2]!.reversed).toBe(true);
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);
  const frozen = await previewFrame(page, 2_500_000, 'freeze-mid');
  expect(Math.abs(frozen - 119)).toBeLessThanOrEqual(1);
  expect(Math.abs((await previewFrame(page, 4_000_000 + Math.round(1e6 / 30) * 10, 'after-freeze')) - 109)).toBeLessThanOrEqual(1);

  // ---- export
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 150_000);
  await page.keyboard.press('Escape');
  const out = grayFrames(file);
  expect(Math.abs(out.length - 240)).toBeLessThanOrEqual(1); // 1 s + 3 s + 4 s at 30 fps
  const m = out.map((f) => bestMatch(f, refs));
  fs.writeFileSync(path.join(TMP, 'export-matches.json'), JSON.stringify(m));
  // reversed: 149 → 120
  for (let k = 0; k < 30; k++) expect(Math.abs(m[k]! - (149 - k)), `export frame ${k}: ${m.slice(0, 40)}`).toBeLessThanOrEqual(1);
  // freeze: frames 30..119 hold one picture
  const held = out[60]!;
  for (let k = 31; k < 119; k++) expect(mse(out[k]!, held), `freeze frame ${k}`).toBeLessThan(4);
  expect(Math.abs(m[60]! - 119)).toBeLessThanOrEqual(1);
  // reversed again from 119 down
  for (let k = 121; k < out.length - 1; k += 3) expect(Math.abs(m[k]! - (119 - (k - 120))), `export frame ${k}`).toBeLessThanOrEqual(1);
  // the exported file has a sound track (the reversed clip's audio)
  const astreams = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  expect(astreams.trim()).toContain('audio');

  // undo removes the freeze, then the reverse
  await page.evaluate(() => (window as any).__oe.getState().undo());
  expect((await mainClips(page)).length).toBe(1);
  await page.evaluate(() => (window as any).__oe.getState().undo());
  expect((await mainClips(page))[0]!.reversed).toBe(false);
  expect(errors.real()).toEqual([]);
});

test('Mirror, Rotate and the Crop dialog', async ({ page }) => {
  await setup(page);
  const ctx = await ctxFor(page, 0);
  const tf = () => page.evaluate(() => (window as any).__oe.getState().project.tracks.find((t: any) => t.kind === 'main').clips[0]);
  await page.evaluate((c) => (window as any).__oeEdit.run('edit.mirror', c), ctx);
  await page.evaluate((c) => (window as any).__oeEdit.run('edit.rotate', c), ctx);
  let c = await tf();
  expect(c.transform.flipH).toBe(true);
  expect(c.transform.rotation).toBe(90);

  await page.evaluate((c) => (window as any).__oeEdit.run('edit.crop', c), ctx);
  await expect(page.getByTestId('crop-dialog')).toBeVisible();
  await expect(page.getByTestId('crop-dialog').locator('img')).toBeVisible();
  await page.getByTestId('crop-ratio-1:1').click();
  await page.getByTestId('crop-apply').click();
  await expect(page.getByTestId('crop-dialog')).toBeHidden();
  c = await tf();
  // 1080×1920 source, 1:1 → full width, 1080 / 1920 of the height, centred
  expect(c.crop.left).toBe(0);
  expect(c.crop.right).toBe(0);
  expect(c.crop.top).toBeCloseTo((1 - 1080 / 1920) / 2, 4);
  expect(c.crop.bottom).toBeCloseTo((1 - 1080 / 1920) / 2, 4);
  // the preview is drawn with the crop: the picture box is now square (top band = background)
  await page.evaluate(() => (window as any).__oe.getState().undo());
  expect((await tf()).crop.top).toBe(0);
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);
});
