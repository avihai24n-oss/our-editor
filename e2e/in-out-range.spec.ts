/**
 * In / Out range export (CapCut I / O): mark the range with the real I and O keys, drag the In
 * handle on the ruler, export through the dialog (which defaults to the range) and measure the MP4:
 *  - duration / frame count = the range;
 *  - pictures: the clip carries its frame number in 10 binary blocks (v-framecode-12s.mp4), so the
 *    first exported frame must be the source frame at In and the last one the frame before Out;
 *  - sound: a 1 kHz beep track with beeps at 1.0, 3.5, 6.0, 8.5, 11.0 s; only the ones inside the
 *    range may be heard, each at (beep − In) in the file.
 * Run alone: cd e2e && E2E_PORT=5404 npx playwright test in-out-range.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAudio, onsetSample, peakAbs, probeStreams } from './audit-helpers';
import { importMedia, mediaPath, openApp, SCREENS_DIR, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(here, 'test-results', 'in-out-media');
const BEEPS = path.join(TMP, 'a-beeps-12s.wav');
const BEEP_AT = [1.0, 3.5, 6.0, 8.5, 11.0];
const S = (s: number) => Math.round(s * 1e6);
const FPS = 30;

test.beforeAll(() => {
  const code = path.join(path.dirname(mediaPath('a-speech-like.wav')), 'v-framecode-12s.mp4');
  if (!fs.existsSync(code))
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=12', '-vf', "geq=lum='if(lt(Y,300), 255*mod(floor(N/pow(2,floor(X/64))),2), 128)':cb=128:cr=128", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', code]);
  fs.mkdirSync(TMP, { recursive: true });
  if (!fs.existsSync(BEEPS)) {
    const on = BEEP_AT.map((t) => `between(t,${t},${t + 0.02})`).join('+');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.8*sin(2*PI*1000*t)*(${on})':s=48000:d=12`, '-ac', '2', '-c:a', 'pcm_s16le', BEEPS]);
  }
});

const ui = (page: Page) => page.evaluate(() => (window as any).__oeUi.getState().area as { in: number | null; out: number | null });

/** Frame number written into exported frame `n` (1280×720 output of the 640×360 frame-coded clip). */
function frameNumber(file: string, n: number, w: number, h: number): number {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 });
  expect(raw.length).toBe(w * h);
  const y = Math.floor(h * 0.4);
  let v = 0;
  for (let b = 0; b < 10; b++) {
    const x = Math.floor(((b + 0.5) / 10) * w);
    if (raw[y * w + x]! > 128) v |= 1 << b;
  }
  return v;
}

test('I / O mark a range, the In handle drags, Export renders exactly that range (video + audio)', async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  await importMedia(page, ['v-framecode-12s.mp4', BEEPS]);
  await page.evaluate(() => {
    const st = () => (window as any).__oe.getState();
    st().setAspectRatio('16:9');
    const by = (n: string) => (Object.values(st().project.assets) as any[]).find((x) => x.name === n).id;
    st().addClip(by('v-framecode-12s.mp4'), { at: 0 });
    st().addClip(by('a-beeps-12s.wav'), { at: 0 });
    st().clearSelection();
    st().setZoom(80); // 12 s ≈ 960 px: every frame is ≥ 2 px wide
  });
  expect(await page.evaluate(() => (window as any).__oe.getState().project.settings.fps)).toBe(FPS);

  // ---- the real keys: I at 2 s, O at 9 s
  const setPlayhead = (t: number) => page.evaluate((t) => (window as any).__oe.getState().setPlayhead(t), t);
  await page.mouse.move(5, 5);
  await setPlayhead(S(2));
  await page.keyboard.press('KeyI');
  await setPlayhead(S(9));
  await page.keyboard.press('KeyO');
  expect(await ui(page)).toEqual({ in: S(2), out: S(9) });
  const band = page.getByTestId('timeline-area');
  await expect(band).toBeVisible();
  await expect(page.getByTestId('timeline-area-label')).toHaveText('00:07:00');
  await expect(page.getByTestId('timeline-area-shade')).toBeVisible();

  // ---- drag the In handle from 2 s to 3 s on the ruler
  const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
  const zoom = await page.evaluate(() => (window as any).__oe.getState().zoom as number);
  const h = (await page.getByTestId('timeline-area-in').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 2.5 * zoom, h.y + h.height / 2, { steps: 4 });
  await page.mouse.move(ruler.x + 3 * zoom, h.y + h.height / 2, { steps: 4 });
  await page.mouse.up();
  const area = await ui(page);
  expect(area.out).toBe(S(9));
  const inFrame = Math.round((area.in! * FPS) / 1e6);
  expect(Math.abs(area.in! - Math.round((inFrame * 1e6) / FPS)), 'frame-snapped').toBeLessThanOrEqual(1);
  expect(Math.abs(inFrame - 3 * FPS), `in = ${area.in}`).toBeLessThanOrEqual(1);
  // the drag did not scrub: the playhead stays at 9 s
  expect(await page.evaluate(() => (window as any).__oe.getState().playhead)).toBe(S(9));

  // Esc no longer drops the range (it is for the export)
  await page.keyboard.press('Escape');
  expect(await ui(page)).toEqual(area);
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  await page.getByTestId('timeline').screenshot({ path: path.join(SCREENS_DIR, 'in-out-range-timeline.png') });

  // ---- Export: the dialog defaults to the range
  await page.getByTestId('export-button').click();
  const dlg = page.getByTestId('export-dialog');
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId('export-scope-range')).toBeChecked();
  await expect(page.getByTestId('export-range-label')).toContainText('00:00:09:00');
  const lenSec = (S(9) - area.in!) / 1e6;
  await expect(page.getByTestId('export-duration')).toHaveText(`00:00:0${Math.floor(lenSec)}:${String(Math.round((lenSec % 1) * FPS)).padStart(2, '0')}`);
  // whole timeline is one click away and changes the estimate
  await page.getByTestId('export-scope-all').check();
  await expect(page.getByTestId('export-duration')).toHaveText('00:00:12:00');
  await page.getByTestId('export-scope-range').check();
  await page.getByTestId('export-resolution').selectOption('720p');
  await page.getByTestId('export-fps').selectOption(String(FPS));
  await dlg.screenshot({ path: path.join(SCREENS_DIR, 'in-out-range-export-dialog.png') });
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 200_000);
  await expect(dlg.getByText(/Exported/)).toBeVisible();
  expect(path.basename(file)).toMatch(/\(00-0\d – 00-09\)\.mp4$/);
  await page.keyboard.press('Escape');

  // ---- container: length = the range
  const pr = probeStreams(file);
  const frames = Math.round(((S(9) - area.in!) * FPS) / 1e6);
  expect(pr.v!.frames).toBe(frames);
  expect(Math.abs(pr.v!.duration - lenSec)).toBeLessThanOrEqual(1 / FPS + 1e-6);
  expect(pr.a).not.toBeNull();
  expect(Math.abs(pr.a!.duration - lenSec)).toBeLessThan(0.05);

  // ---- pictures: first frame = source frame at In, last = the frame before Out
  const first = frameNumber(file, 0, pr.v!.width, pr.v!.height);
  const second = frameNumber(file, 1, pr.v!.width, pr.v!.height);
  const last = frameNumber(file, frames - 1, pr.v!.width, pr.v!.height);
  console.log('IN-OUT', JSON.stringify({ in: area.in, inFrame, frames, first, second, last, durV: pr.v!.duration, durA: pr.a!.duration }));
  expect(first).toBe(inFrame);
  expect(second).toBe(inFrame + 1);
  expect(last).toBe(9 * FPS - 1);

  // ---- sound: the beeps inside [In, Out) at beep − In, nothing from outside
  const pcm = decodeAudio(file);
  const inSec = area.in! / 1e6;
  const inside = BEEP_AT.filter((t) => t >= inSec && t < 9);
  expect(inside).toEqual([3.5, 6.0, 8.5]);
  let from = 0;
  const onsets: number[] = [];
  for (const t of inside) {
    const n = onsetSample(pcm, 0.2, from);
    expect(n, `beep at ${t}`).toBeGreaterThan(0);
    onsets.push(n / pcm.sampleRate);
    from = n / pcm.sampleRate + 0.1;
  }
  console.log('IN-OUT audio', JSON.stringify({ expected: inside.map((t) => +(t - inSec).toFixed(4)), onsets: onsets.map((x) => +x.toFixed(4)) }));
  inside.forEach((t, i) => expect(Math.abs(onsets[i]! - (t - inSec)), `beep ${t} lands at ${onsets[i]}`).toBeLessThan(0.003));
  expect(peakAbs(pcm, 0, inside[0]! - inSec - 0.01), 'nothing before the first in-range beep (the 1 s beep is outside)').toBeLessThan(0.02);
  expect(peakAbs(pcm, inside.at(-1)! - inSec + 0.05), 'nothing after the last in-range beep').toBeLessThan(0.02);
  fs.rmSync(file, { force: true });

  // ---- the ✕ clears the range; the dialog then has no range option
  await page.getByTestId('timeline-area-clear').click();
  expect(await ui(page)).toEqual({ in: null, out: null });
  await expect(page.getByTestId('timeline-area')).toHaveCount(0);
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await expect(page.getByTestId('export-scope')).toHaveCount(0);
  await expect(page.getByTestId('export-duration')).toHaveText('00:00:12:00');
  await page.keyboard.press('Escape');

  // ⌥X clears too; O before I works (any order, like CapCut)
  await setPlayhead(S(8));
  await page.keyboard.press('KeyO');
  await setPlayhead(S(4));
  await page.keyboard.press('KeyI');
  expect(await ui(page)).toEqual({ in: S(4), out: S(8) });
  await page.keyboard.press('Alt+KeyX');
  expect(await ui(page)).toEqual({ in: null, out: null });
});
