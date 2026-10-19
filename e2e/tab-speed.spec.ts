/**
 * Speed tab end to end: Standard 2x / 0.5x and every Speed › Curve preset on the 5 s testsrc2
 * clip (1080x1920, 30 fps, 440 Hz tone), applied through the inspector UI, then:
 *  - the timeline clip's length equals the computed duration (source span / mean speed);
 *  - the exported MP4's duration (ffprobe) equals it;
 *  - the source frame shown at chosen output times is the one the speed integral predicts
 *    (each exported frame is matched against every source frame extracted with ffmpeg);
 *  - the audio stream's duration matches, and the 440 Hz tone keeps its pitch unless
 *    "Change audio pitch" is on (dominant frequency measured on the decoded export).
 * Plus: the curve editor (drag a point, one undo step, Reset), split keeps the right part of the
 * curve, and everything survives a reload.
 *
 * Expected values are computed here from the clip's stored curve with an independent numeric
 * integral (Simpson) of the curve's speed — not with the app's own integral.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { curveSpeedAt, type SpeedCurve } from '../src/model/speedCurve';
import { collectConsoleErrors, dragAssetToTimeline, ffprobe, importMedia, MEDIA, mediaPath, openApp, screenshot, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test.describe.configure({ mode: 'serial' });

const FPS = 30;
const SRC_US = 5_000_000;
const W = 36; // comparison thumbnails (gray), 9:16
const H = 64;

interface ClipInfo {
  id: string;
  start: number;
  duration: number;
  inPoint: number;
  speed: number;
  speedCurve: SpeedCurve | null;
  preservePitch: boolean;
}

const getClip = (page: Page): Promise<ClipInfo> =>
  page.evaluate(() => {
    const c = (window as any).__oe.getState().project.tracks.find((t: any) => t.kind === 'main').clips[0];
    return { id: c.id, start: c.start, duration: c.duration, inPoint: c.inPoint, speed: c.speed, speedCurve: c.speedCurve, preservePitch: c.preservePitch };
  });

// ---------------------------------------------------------------- independent expected mapping

/** ∫₀^x speed, composite Simpson on the curve's speed (n even). */
function simpson(curve: SpeedCurve, x: number, n = 4000): number {
  if (x <= 0) return 0;
  const h = x / n;
  let s = curveSpeedAt(curve, 0) + curveSpeedAt(curve, x);
  for (let i = 1; i < n; i++) s += curveSpeedAt(curve, i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}
const meanSpeed = (c: ClipInfo) => (c.speedCurve ? simpson(c.speedCurve, 1) : c.speed);
/** Source time (µs) at output (timeline) time t µs. */
function expectedSource(c: ClipInfo, tUs: number): number {
  const local = tUs - c.start;
  const off = c.speedCurve ? c.duration * simpson(c.speedCurve, local / c.duration, 400) : local * c.speed;
  return Math.min(SRC_US - 1, Math.max(0, Math.round(c.inPoint + off)));
}
const speedAt = (c: ClipInfo, tUs: number) => (c.speedCurve ? curveSpeedAt(c.speedCurve, (tUs - c.start) / c.duration) : c.speed);

// ---------------------------------------------------------------- ffmpeg helpers

function grayFrames(file: string): Buffer[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], {
    maxBuffer: 512 * 1024 * 1024,
  });
  const size = W * H;
  const out: Buffer[] = [];
  for (let i = 0; i + size <= raw.length; i += size) out.push(raw.subarray(i, i + size));
  return out;
}

const mse = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return s / a.length;
};

/** Index of the source frame that looks most like `frame`. */
const bestMatch = (frame: Buffer, refs: Buffer[]) => {
  let best = -1;
  let bestErr = Infinity;
  refs.forEach((r, i) => {
    const e = mse(frame, r);
    if (e < bestErr) {
      bestErr = e;
      best = i;
    }
  });
  return best;
};

function monoAudio(file: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 512 * 1024 * 1024 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
}

/** Dominant frequency in [fromSec, toSec): rising zero crossings (the tone is a pure sine). */
function freqAt(x: Float32Array, fromSec: number, toSec: number): number {
  const a = Math.max(1, Math.round(fromSec * 48000));
  const b = Math.min(x.length, Math.round(toSec * 48000));
  let n = 0;
  let first = -1;
  let last = -1;
  for (let i = a; i < b; i++) {
    if (x[i - 1]! < 0 && x[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      n++;
    }
  }
  return n > 1 ? ((n - 1) * 48000) / (last - first) : 0;
}

function audioStreamDuration(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(out.trim());
}

let srcRefs: Buffer[] = [];
test.beforeAll(() => {
  srcRefs = grayFrames(mediaPath(MEDIA.vertical));
  expect(srcRefs).toHaveLength(150);
  // sanity: testsrc2 frames are distinguishable — each source frame matches itself
  for (let k = 0; k < 150; k += 7) expect(bestMatch(srcRefs[k]!, srcRefs)).toBe(k);
});

// ---------------------------------------------------------------- UI

async function setup(page: Page) {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe);
  await importMedia(page, [MEDIA.vertical]);
  await dragAssetToTimeline(page, MEDIA.vertical, 0, 20);
  await page.evaluate(() => (window as any).__oe.getState().setZoom(120));
  const clip = page.locator('[data-testid="timeline-clip"]').first();
  await clip.click({ position: { x: 10, y: 20 } });
  await page.getByTestId('inspector').getByRole('tab', { name: 'Speed', exact: true }).click();
  await expect(page.getByTestId('speed-standard')).toBeVisible();
}

async function setSpeedUi(page: Page, value: string) {
  const box = page.getByTestId('inspector').getByLabel('Speed value', { exact: true }).first();
  await box.click();
  await box.fill(value);
  await box.press('Enter');
}

async function pitchOn(page: Page) {
  await page.getByTestId('inspector').getByRole('switch', { name: 'Change audio pitch' }).click();
}

async function pickCurve(page: Page, id: string) {
  await page.getByTestId('inspector').getByRole('tab', { name: 'Curve', exact: true }).click();
  await page.getByTestId(`curve-preset-${id}`).click();
  await expect(page.getByTestId('curve-editor')).toBeVisible();
}

/** The timeline clip's width in px must equal duration × zoom. */
async function expectTimelineLength(page: Page, c: ClipInfo) {
  const zoom = await page.evaluate(() => (window as any).__oe.getState().zoom as number);
  const box = (await page.locator('[data-testid="timeline-clip"]').first().boundingBox())!;
  expect(Math.abs(box.width - (c.duration / 1e6) * zoom), `clip width ${box.width}px at ${zoom}px/s`).toBeLessThanOrEqual(1.5);
}

async function exportProject(page: Page): Promise<string> {
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 240_000);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  return file;
}

interface Case {
  name: string;
  apply: (page: Page) => Promise<void>;
  pitch: boolean;
}

const CASES: Case[] = [
  { name: 'standard 2x', apply: (p) => setSpeedUi(p, '2'), pitch: false },
  { name: 'standard 2x, change pitch', apply: async (p) => (await pitchOn(p), await setSpeedUi(p, '2')), pitch: true },
  { name: 'standard 0.5x', apply: (p) => setSpeedUi(p, '0.5'), pitch: false },
  ...['custom', 'montage', 'hero', 'bullet', 'jump-cut', 'flash-in', 'flash-out'].map((id) => ({ name: `curve ${id}`, apply: (p: Page) => pickCurve(p, id), pitch: false })),
  { name: 'curve jump-cut, change pitch', apply: async (p) => (await pitchOn(p), await pickCurve(p, 'jump-cut')), pitch: true },
];

const results: Record<string, unknown>[] = [];

for (const cs of CASES) {
  test(`speed: ${cs.name} — timeline length, export duration, frames and audio`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors = collectConsoleErrors(page);
    await setup(page);
    await cs.apply(page);
    const c = await getClip(page);
    expect(c.preservePitch).toBe(!cs.pitch);

    // ---- duration = source span / mean speed (independent integral)
    const expectedUs = SRC_US / meanSpeed(c);
    expect(Math.abs(c.duration - expectedUs), `duration ${c.duration} vs ${expectedUs}`).toBeLessThanOrEqual(1000);
    await expectTimelineLength(page, c);
    await screenshot(page, `tab-speed-${cs.name.replace(/[^a-z0-9]+/gi, '-')}`);

    // ---- export
    const file = await exportProject(page);
    const probe = ffprobe(file);
    const want = c.duration / 1e6;
    expect(Math.abs(probe.duration - want), `export ${probe.duration}s vs ${want}s`).toBeLessThanOrEqual(1 / FPS + 0.03);
    expect(probe.hasAudio).toBe(true);
    const aDur = audioStreamDuration(file);
    expect(Math.abs(aDur - want), `audio ${aDur}s vs ${want}s`).toBeLessThanOrEqual(0.1);

    // ---- frames: which source frame appears at chosen output frames
    const out = grayFrames(file);
    const nFrames = Math.round(want * FPS);
    expect(Math.abs(out.length - nFrames)).toBeLessThanOrEqual(1);
    const picks = new Set<number>();
    for (let k = 0; k < 16; k++) picks.add(Math.min(out.length - 1, Math.round(((out.length - 1) * k) / 15)));
    const frameReport: [number, number, number][] = [];
    for (const n of picks) {
      const tUs = Math.round((n * 1e6) / FPS);
      const want = Math.floor((expectedSource(c, tUs) / 1e6) * FPS + 1e-6);
      const got = bestMatch(out[n]!, srcRefs);
      frameReport.push([n, want, got]);
      // ±1 source frame: decoder timestamp rounding and, at > 1x, two source frames per output frame
      expect(Math.abs(got - want), `output frame ${n} (t=${(tUs / 1e6).toFixed(3)}s): source frame ${got}, expected ${want}`).toBeLessThanOrEqual(1);
    }

    // ---- audio pitch: 440 Hz kept unless "Change audio pitch" is on
    const pcm = monoAudio(file);
    const freqs: { at: number; speed: number; hz: number; want: number }[] = [];
    const nWin = 8;
    for (let k = 0; k < nWin; k++) {
      const mid = want * ((k + 0.5) / nWin);
      const tUs = c.start + mid * 1e6;
      const v = speedAt(c, tUs);
      // only judge windows where the speed is steady (pitch-on follows the instantaneous speed)
      const v0 = speedAt(c, tUs - 40_000);
      const v1 = speedAt(c, tUs + 40_000);
      if (Math.abs(v0 - v1) / v > 0.03) continue;
      const hz = freqAt(pcm, mid - 0.04, mid + 0.04);
      const expectHz = cs.pitch ? 440 * v : 440;
      freqs.push({ at: Number(mid.toFixed(2)), speed: Number(v.toFixed(2)), hz: Math.round(hz), want: Math.round(expectHz) });
      expect(Math.abs(hz - expectHz) / expectHz, `pitch at ${mid.toFixed(2)}s: ${hz.toFixed(1)} Hz, expected ${expectHz.toFixed(1)} Hz`).toBeLessThan(0.03);
    }
    expect(freqs.length).toBeGreaterThan(0);
    results.push({ case: cs.name, durationS: want, exportS: probe.duration, audioS: aDur, frames: frameReport, pitch: freqs });
    console.log('[tab-speed]', JSON.stringify(results.at(-1)));
    expect(errors.real(), errors.real().join('\n')).toEqual([]);
  });
}

test('curve editor: drag a point, one undo step, Reset, split keeps the curve, reload keeps it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await setup(page);
  await pickCurve(page, 'custom');
  await expect(page.locator('[data-testid="clip-speed-badge"]').first()).toHaveText('Custom');
  const before = await getClip(page);
  expect(before.duration).toBe(SRC_US);
  const past0 = await page.evaluate(() => (window as any).__oe.getState().past.length);

  // drag the middle point (index 2) up towards 10x
  const pt = page.locator('[data-testid="curve-point"][data-index="2"]');
  const graph = page.getByTestId('curve-graph');
  const gb = (await graph.boundingBox())!;
  const pb = (await pt.boundingBox())!;
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2 - ((pb.y - gb.y - 10) * i) / 8);
  await page.mouse.up();
  const dragged = await getClip(page);
  expect(dragged.speedCurve!.points[2]!.v).toBeGreaterThan(5);
  expect(dragged.duration).toBeLessThan(before.duration * 0.8);
  expect(Math.abs(dragged.duration - SRC_US / meanSpeed(dragged))).toBeLessThan(1000);
  await expect(page.getByTestId('curve-duration')).toHaveText(`${(dragged.duration / 1e6).toFixed(1)}s`);
  await expectTimelineLength(page, dragged);
  expect(await page.evaluate(() => (window as any).__oe.getState().past.length)).toBe(past0 + 1);
  await screenshot(page, 'tab-speed-curve-drag');

  // undo / redo
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
  expect((await getClip(page)).speedCurve!.points[2]!.v).toBe(1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Shift+Z');
  expect((await getClip(page)).speedCurve!.points[2]!.v).toBeGreaterThan(5);

  // Reset puts the preset's points back
  await page.getByTestId('curve-reset').click();
  expect((await getClip(page)).speedCurve!.points.every((p) => p.v === 1)).toBe(true);

  // Hero, then split at 40 %: the right part keeps its piece of the curve and continues the source
  await page.getByTestId('curve-preset-hero').click();
  const hero = await getClip(page);
  const cut = Math.round(hero.duration * 0.4);
  await page.evaluate((t) => (window as any).__oe.getState().setPlayhead(t), cut);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+B');
  const parts = await page.evaluate(() =>
    (window as any).__oe.getState().project.tracks.find((t: any) => t.kind === 'main').clips.map((c: any) => ({ start: c.start, duration: c.duration, inPoint: c.inPoint, speed: c.speed, speedCurve: c.speedCurve, preservePitch: c.preservePitch, id: c.id })),
  );
  expect(parts).toHaveLength(2);
  expect(parts[1].speedCurve.preset).toBe('hero');
  expect(Math.abs(parts[1].inPoint - expectedSource(hero, cut))).toBeLessThanOrEqual(2_000);
  for (const f of [0.1, 0.5, 0.9]) {
    const t = Math.round(cut + (hero.duration - cut) * f);
    expect(Math.abs(expectedSource(parts[1], t) - expectedSource(hero, t))).toBeLessThanOrEqual(2_000);
  }

  // reload: the curves come back from IndexedDB
  await page.waitForTimeout(3_000); // autosave (debounce + min gap)
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oe && (window as any).__oe.getState().project.tracks[0].clips.length === 2);
  const after = await page.evaluate(() => (window as any).__oe.getState().project.tracks.find((t: any) => t.kind === 'main').clips.map((c: any) => c.speedCurve?.preset));
  expect(after).toEqual(['hero', 'hero']);
  await page.locator('[data-testid="timeline-clip"]').nth(1).click({ position: { x: 10, y: 20 } });
  await page.getByTestId('inspector').getByRole('tab', { name: 'Speed', exact: true }).click();
  await expect(page.getByTestId('curve-editor')).toBeVisible(); // opens on Curve for a curve clip
  await expect(page.getByTestId('curve-preset-hero')).toHaveAttribute('aria-selected', 'true');
  await screenshot(page, 'tab-speed-after-reload');

  // standard speed replaces the curve (CapCut)
  await page.getByTestId('inspector').getByRole('tab', { name: 'Standard', exact: true }).click();
  await expect(page.getByTestId('speed-curve-active')).toBeVisible();
  await setSpeedUi(page, '2');
  const std = await page.evaluate(() => (window as any).__oe.getState().project.tracks.find((t: any) => t.kind === 'main').clips[1]);
  expect(std.speedCurve).toBeNull();
  expect(std.speed).toBe(2);
  // Smooth slow-mo is CapCut's AI option: shown, disabled
  await expect(page.getByTestId('smooth-slowmo').locator('input')).toBeDisabled();
  expect(errors.real(), errors.real().join('\n')).toEqual([]);
});

test.afterAll(() => {
  if (!results.length) return;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tab-speed-measurements.json'), JSON.stringify(results, null, 1));
});
