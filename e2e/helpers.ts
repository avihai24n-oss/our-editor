/**
 * Reusable Playwright helpers for Our Editor e2e tests.
 *
 * Selector contract (see docs/integration-notes/e2e-testids.md):
 *   left-panel, player, inspector, timeline, export-button     (required regions)
 *   media-import-input   <input type="file"> used to import media
 *   media-asset          one asset tile in the media library, with data-asset-name="<file name>"
 *   timeline-track       one track row, with data-track-index="<0-based>"
 *   timeline-clip        one clip on the timeline, with data-clip-name / data-clip-id
 *   play-button          play/pause toggle in the player
 *   timecode             current-time readout in the player ("00:00:01:15" or "00:01.50")
 *   export-dialog, export-confirm   the export modal and its final "Export" button
 *
 * Every helper falls back to a looser selector when a test id is missing, so a
 * test can still run while builders catch up — but the test id is the contract.
 */
import { expect, type Download, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');
export const MEDIA_DIR = path.join(PROJECT_ROOT, 'test-media');
export const SCREENS_DIR = path.join(here, 'screens');
export const DOWNLOADS_DIR = path.join(here, 'downloads');

export const TID = {
  leftPanel: 'left-panel',
  player: 'player',
  inspector: 'inspector',
  timeline: 'timeline',
  exportButton: 'export-button',
  mediaImportInput: 'media-import-input',
  mediaAsset: 'media-asset',
  timelineTrack: 'timeline-track',
  timelineClip: 'timeline-clip',
  playButton: 'play-button',
  timecode: 'timecode',
  exportDialog: 'export-dialog',
  exportConfirm: 'export-confirm',
} as const;

export const REQUIRED_REGIONS = [
  TID.leftPanel,
  TID.player,
  TID.inspector,
  TID.timeline,
  TID.exportButton,
] as const;

/** Test media file names shipped in test-media/. */
export const MEDIA = {
  vertical: 'v-vertical-5s.mp4',
  landscape: 'v-landscape-4s.mp4',
  silent: 'v-silent-3s.mp4',
  image: 'img-square.png',
  tone: 'a-tone-6s.mp3',
  beeps: 'a-speech-like.wav',
} as const;

const tid = (page: Page, id: string): Locator => page.getByTestId(id);

/** Resolve a test-media file name (or an absolute path) to an absolute path. */
export function mediaPath(file: string): string {
  const p = path.isAbsolute(file) ? file : path.join(MEDIA_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`test media not found: ${p}`);
  return p;
}

/**
 * Import media files via the file input.
 * Contract: [data-testid="media-import-input"]; fallback: first input[type=file]
 * inside [data-testid="left-panel"]; last resort: first input[type=file] on the page.
 * Waits until each file shows up as a media-asset (or its name appears in the left panel).
 */
export async function importMedia(page: Page, files: string[], opts: { waitForAssets?: boolean } = {}) {
  const paths = files.map(mediaPath);
  let input = tid(page, TID.mediaImportInput);
  if ((await input.count()) === 0) input = tid(page, TID.leftPanel).locator('input[type="file"]');
  if ((await input.count()) === 0) input = page.locator('input[type="file"]');
  await input.first().setInputFiles(paths);

  if (opts.waitForAssets !== false) {
    for (const p of paths) await expect(assetLocator(page, path.basename(p))).toBeVisible({ timeout: 20_000 });
  }
}

/** Locate a media-library asset by its file name. */
export function assetLocator(page: Page, assetName: string): Locator {
  const byTid = page.locator(`[data-testid="${TID.mediaAsset}"][data-asset-name="${cssEscape(assetName)}"]`);
  const byText = tid(page, TID.mediaAsset).filter({ hasText: assetName });
  const looseText = tid(page, TID.leftPanel).getByText(assetName, { exact: false });
  return byTid.or(byText).or(looseText).first();
}

/** Locate the track row for trackIndex (0 = top/main track as rendered), or the whole timeline. */
export function trackLocator(page: Page, trackIndex?: number): Locator {
  if (trackIndex === undefined) return tid(page, TID.timeline);
  return page.locator(`[data-testid="${TID.timelineTrack}"][data-track-index="${trackIndex}"]`)
    .or(tid(page, TID.timelineTrack).nth(trackIndex))
    .first();
}

/** All clips currently on the timeline. */
export function clipsLocator(page: Page): Locator {
  return tid(page, TID.timelineClip);
}

/**
 * Drag a media asset onto the timeline (optionally onto a specific track).
 * Tries Playwright's dragTo (HTML5 DnD) first; if no new clip appears, retries with
 * raw pointer events (for pointer-based drag implementations).
 * xOffset = px from the left of the track where the drop happens (default 40).
 */
export async function dragAssetToTimeline(page: Page, assetName: string, trackIndex?: number, xOffset = 40) {
  const source = assetLocator(page, assetName);
  const target = trackLocator(page, trackIndex);
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const before = await clipsLocator(page).count();

  const tbox = await target.boundingBox();
  if (!tbox) throw new Error('timeline target has no bounding box');
  const targetPosition = { x: Math.min(xOffset, tbox.width - 2), y: Math.min(tbox.height / 2, 30) };

  await source.dragTo(target, { targetPosition });
  try {
    await expect.poll(() => clipsLocator(page).count(), { timeout: 3_000 }).toBeGreaterThan(before);
    return;
  } catch {
    /* fall through to manual pointer drag */
  }

  const sbox = await source.boundingBox();
  if (!sbox) throw new Error('asset has no bounding box');
  await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
  await page.mouse.down();
  const tx = tbox.x + targetPosition.x;
  const ty = tbox.y + targetPosition.y;
  await page.mouse.move(tx, ty, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => clipsLocator(page).count(), { timeout: 5_000 }).toBeGreaterThan(before);
}

/** Click the player's play/pause button (contract: play-button; fallback: button named Play inside player). */
export async function clickPlay(page: Page) {
  let btn = tid(page, TID.playButton);
  if ((await btn.count()) === 0) btn = tid(page, TID.player).getByRole('button', { name: /play|pause/i });
  await btn.first().click();
}

/**
 * Press a shortcut. Use "Mod" for Cmd on macOS / Ctrl elsewhere, e.g. "Mod+Z", "Mod+Shift+Z", "Mod+B".
 * Plain keys ("Space", "Delete", "ArrowLeft") pass through unchanged.
 * Focus is moved off text inputs first (clicks the timeline) unless opts.keepFocus is set.
 */
export async function pressShortcut(page: Page, combo: string, opts: { keepFocus?: boolean } = {}) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const keys = combo.split('+').map((k) => (/^(mod|cmdorctrl|ctrlormeta)$/i.test(k) ? mod : k));
  if (!opts.keepFocus) {
    await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) a.blur();
    });
  }
  await page.keyboard.press(keys.join('+'));
}

/** Raw timecode text from the player (contract: timecode). */
export async function getTimecode(page: Page): Promise<string> {
  return ((await tid(page, TID.timecode).first().textContent()) ?? '').trim();
}

/**
 * Parse a timecode into seconds. Accepts "HH:MM:SS:FF" (fps default 30), "MM:SS.ms",
 * "HH:MM:SS.ms", "SS.ms". When the readout shows "current / total" only the first part is used.
 */
export function timecodeToSeconds(tc: string, fps = 30): number {
  const first = tc.split('/')[0]!.trim();
  const parts = first.split(':').map((p) => p.trim());
  if (parts.length === 4) {
    const [h, m, s, f] = parts.map(Number) as [number, number, number, number];
    return h * 3600 + m * 60 + s + f / fps;
  }
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Current player time in seconds. */
export async function getTimeSeconds(page: Page, fps = 30): Promise<number> {
  return timecodeToSeconds(await getTimecode(page), fps);
}

/** Save a full-page screenshot to e2e/screens/<name>.png and return its path. */
export async function screenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  const file = path.join(SCREENS_DIR, name.endsWith('.png') ? name : `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

export interface ConsoleCollector {
  errors: string[];
  /** Errors minus known-noise patterns. */
  real(): string[];
}

const DEFAULT_IGNORES: RegExp[] = [
  /favicon\.ico/i,
  /Download the React DevTools/i,
  /\[vite\] connecting/i,
];

/** Start collecting console errors and uncaught page errors. Call before page.goto. */
export function collectConsoleErrors(page: Page, ignore: RegExp[] = []): ConsoleCollector {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  const patterns = [...DEFAULT_IGNORES, ...ignore];
  return { errors, real: () => errors.filter((e) => !patterns.some((r) => r.test(e))) };
}

/**
 * Run `trigger` and wait for the browser download it causes; saves it into e2e/downloads/.
 * Example: const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click());
 */
export async function waitForDownload(page: Page, trigger: () => Promise<unknown>, timeout = 180_000): Promise<string> {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const [download]: [Download, unknown] = await Promise.all([page.waitForEvent('download', { timeout }), trigger()]);
  const failure = await download.failure();
  if (failure) throw new Error(`download failed: ${failure}`);
  const file = path.join(DOWNLOADS_DIR, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  return file;
}

export interface ProbeResult {
  duration: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  fps: number | null;
  sizeBytes: number;
}

/** ffprobe a media file (requires ffprobe on PATH). */
export function ffprobe(file: string): ProbeResult {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }>;
  };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const fpsStr = v?.avg_frame_rate ?? '';
  const [n, d] = fpsStr.split('/').map(Number);
  return {
    duration: Number(j.format?.duration ?? v?.duration ?? a?.duration ?? NaN),
    width: v?.width ?? null,
    height: v?.height ?? null,
    hasVideo: !!v,
    hasAudio: !!a,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    fps: n && d ? n / d : null,
    sizeBytes: fs.statSync(file).size,
  };
}

export interface ExpectMedia {
  duration?: number;
  /** Allowed duration error in seconds (default 0.15). */
  durationTolerance?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
}

/** ffprobe the file and assert the expectations. Returns the probe for further checks. */
export function expectMediaFile(file: string, want: ExpectMedia): ProbeResult {
  const p = ffprobe(file);
  expect(p.sizeBytes, `${file} is empty`).toBeGreaterThan(0);
  if (want.duration !== undefined) {
    expect(Math.abs(p.duration - want.duration), `duration ${p.duration} vs ${want.duration}`).toBeLessThanOrEqual(
      want.durationTolerance ?? 0.15,
    );
  }
  if (want.width !== undefined) expect(p.width).toBe(want.width);
  if (want.height !== undefined) expect(p.height).toBe(want.height);
  if (want.hasAudio !== undefined) expect(p.hasAudio).toBe(want.hasAudio);
  if (want.hasVideo !== undefined) expect(p.hasVideo).toBe(want.hasVideo);
  return p;
}

/** Open the app and wait for all required regions. */
export async function openApp(page: Page) {
  await page.goto('/');
  for (const id of REQUIRED_REGIONS) await expect(tid(page, id).first()).toBeVisible();
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
