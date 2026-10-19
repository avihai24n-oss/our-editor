/**
 * Integration sanity scenario: ONE clip carrying every merged feature at once —
 * a speed curve (tab-speed) + an In animation (tab-animation) + an Adjust grade with a colour
 * wheel (tab-adjust) + a circle mask with non-uniform scale (tab-video) + a voice filter
 * (tab-audio) + a transition into the next clip.
 *
 * It must: render the same picture in the paused preview and in the exported MP4, keep the voice
 * filter in both audio paths, survive a reload unchanged, and undo all the way back (then redo).
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, imageRgb, probeStreams, videoFrame } from './audit-helpers';
import { collectConsoleErrors, importMedia, MEDIA, openApp, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(here, 'test-results', 'combined-tmp');
const FPS = 30;
/** Mean abs diff (0..255) and PSNR at the preview's resolution, sharp saturated test card. */
const MAX_MAD = 4;
const MIN_PSNR = 25;

const doc = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const p = (window as any).__oe.getState().project;
    return JSON.stringify({ ...p, updatedAt: 0 });
  });

async function previewPng(page: Page, tUs: number, name: string): Promise<string> {
  await page.mouse.move(5, 5);
  await page.evaluate((t) => {
    const s = (window as any).__oe.getState();
    s.pause();
    s.clearSelection();
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
  return file;
}

async function waitSaved(page: Page) {
  await page.waitForFunction(
    () => {
      const s = (window as any).__oe.getState();
      return !s.saveStatus.saving && s.saveStatus.lastSavedAt !== null && s.saveStatus.lastSavedAt >= s.project.updatedAt;
    },
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(200);
}

test('one clip with a speed curve + animation + grade + mask + voice filter + transition: preview = export, reload, undo', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectConsoleErrors(page);
  await openApp(page);
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape]);
  const empty = await doc(page);

  // ---- build it through the store's public actions (each one an undo step)
  const ids = await page.evaluate(() => {
    const st = () => (window as any).__oe.getState();
    const byName = (n: string) => (Object.values(st().project.assets) as any[]).find((a) => a.name === n).id;
    const a = st().addClip(byName('v-vertical-5s.mp4'), { at: 0 });
    st().setSpeedCurve(a, { preset: 'custom', points: [{ x: 0, v: 1 }, { x: 0.45, v: 2.2 }, { x: 1, v: 0.6 }] });
    const aEnd = () => {
      const c = st().project.tracks[0].clips.find((x: any) => x.id === a);
      return c.start + c.duration;
    };
    const b = st().addClip(byName('v-landscape-4s.mp4'), { at: aEnd() });
    st().setAnimation(a, 'in', 'zoom-in', 1_000_000);
    st().updateClip(a, { adjust: { saturation: 25, contrast: 12, temperature: -10 } });
    const g = st().project.tracks[0].clips.find((x: any) => x.id === a).grade;
    st().updateClip(a, { grade: { wheels: { ...g.wheels, gain: { ...g.wheels.gain, x: 0.15, y: 0.1 } } } });
    st().updateClip(a, { mask: { shape: 'circle', width: 0.8, height: 0.6, feather: 15 }, transform: { uniformScale: false, scaleX: 1.1, scaleY: 0.95 } });
    st().updateClip(a, { audio: { voiceFilter: { id: 'robot', strength: 70 } } });
    const tr = st().addTransition(a, 'mix', 600_000);
    return { a, b, tr, cut: aEnd(), steps: st().past.length };
  });
  const full = await doc(page);
  const clipA = await page.evaluate((a) => (window as any).__oe.getState().project.tracks[0].clips.find((c: any) => c.id === a), ids.a);
  expect(clipA.speedCurve.points).toHaveLength(3);
  expect(clipA.animationIn.type).toBe('zoom-in');
  expect(clipA.mask.shape).toBe('circle');
  expect(clipA.audio.voiceFilter.id).toBe('robot');
  expect(clipA.duration).not.toBe(5_000_000); // the curve changed the length
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);

  // ---- undo all the way back, then redo all the way forward (UI shortcuts)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.mouse.click(5, 5);
  for (let i = 0; i < ids.steps + 2; i++) await page.keyboard.press(`${mod}+KeyZ`);
  expect(await page.evaluate(() => (window as any).__oe.getState().past.length)).toBe(0);
  expect(await doc(page)).toBe(empty);
  for (let i = 0; i < ids.steps + 2; i++) await page.keyboard.press(`${mod}+Shift+KeyZ`);
  expect(await doc(page)).toBe(full);
  expect(await page.evaluate(() => (window as any).__oeCheck())).toEqual([]);

  // ---- voice filter in the preview audio graph (the export renders the same chain)
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(1_000_000));
  await page.getByTestId('play-button').click();
  await expect
    .poll(async () => page.evaluate(() => ((window as any).__oeAudio.voices() as any[]).flatMap((v) => v.stages).join(' ')), { timeout: 10_000 })
    .toMatch(/voice:robot:70/);
  const stages = await page.evaluate(() => ((window as any).__oeAudio.voices() as any[]).map((v) => v.stages));
  await page.getByTestId('play-button').click();

  // ---- export
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  await page.getByTestId('export-fps').selectOption(String(FPS));
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 180_000);
  await page.keyboard.press('Escape');
  fs.mkdirSync(TMP, { recursive: true });
  fs.copyFileSync(file, path.join(TMP, 'combined-export.mp4'));
  const probe = probeStreams(file);
  expect(probe.v).toMatchObject({ codec: 'h264', width: 720, height: 1280 });
  expect(probe.a).not.toBeNull();

  // ---- preview vs export at: in-animation, the fast part of the curve, both sides of the cut, clip B
  const times = [0.3e6, ids.cut * 0.45, ids.cut - 0.15e6, ids.cut + 0.15e6, ids.cut + 1.5e6];
  // compared at the preview canvas's own resolution (the export frame area-scaled down to it):
  // at a smaller common size the resampling of this sharp, saturated test card dominates PSNR
  const rows: Record<string, unknown>[] = [];
  const previews: Record<number, string> = {};
  let w = 0;
  let h = 0;
  for (const t of times) {
    const n = Math.round((t * FPS) / 1e6);
    const tUs = Math.round((n * 1e6) / FPS);
    const png = await previewPng(page, tUs, `combined-${n}`);
    previews[n] = png;
    if (!w) [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png], { encoding: 'utf8' }).trim().split(',').map(Number) as [number, number];
    const prv = imageRgb(png, w, h);
    const c = compare(videoFrame(file, n, w, h), prv);
    // the right frame: the preview matches export frame n at least as well as frames n ± 1, 2
    const near: Record<string, number> = {};
    for (const k of [-2, -1, 1, 2]) near[k] = +compare(videoFrame(file, n + k, w, h), prv).psnr.toFixed(1);
    rows.push({ t: tUs / 1e6, frame: n, mad: +c.mad.toFixed(2), psnr: +c.psnr.toFixed(1), neighbours: near });
    expect.soft(c.mad, `t=${tUs / 1e6}: preview vs export MAD`).toBeLessThanOrEqual(MAX_MAD);
    expect.soft(c.psnr, `t=${tUs / 1e6}: preview vs export PSNR`).toBeGreaterThanOrEqual(MIN_PSNR);
    expect.soft(c.psnr, `t=${tUs / 1e6}: export frame ${n} is the best match`).toBeGreaterThanOrEqual(Math.max(...Object.values(near)) - 0.3);
  }
  console.log('COMBINED', JSON.stringify({ steps: ids.steps, cut: ids.cut, stages, rows }));

  // ---- reload: the same document and the same picture
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction(() => {
    const oe = (window as any).__oe;
    return !!oe && Object.keys(oe.getState().project.assets).length === 2 && oe.getState().project.tracks[0].clips.length === 2;
  }, null, { timeout: 20_000 });
  expect(await doc(page)).toBe(full);
  const n = Math.round(((ids.cut * 0.45) * FPS) / 1e6);
  const again = await previewPng(page, Math.round((n * 1e6) / FPS), `combined-reload-${n}`);
  const r = compare(imageRgb(previews[n]!, w, h), imageRgb(again, w, h));
  console.log('RELOAD', JSON.stringify({ frame: n, mad: +r.mad.toFixed(2), psnr: +r.psnr.toFixed(1) }));
  expect(r.mad).toBeLessThanOrEqual(2);
  expect(errors.real()).toEqual([]);
  fs.copyFileSync(file, path.join(TMP, 'combined-export.mp4'));
  fs.rmSync(file, { force: true });
});
