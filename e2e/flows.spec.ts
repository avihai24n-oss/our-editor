/**
 * QA flows for v1: one serial walk through the real app, the way a user edits a vertical video.
 * Each step leaves a screenshot in e2e/screens/ and the console must stay clean.
 *
 * State checks read the dev-only store handle `window.__oe` (set in src/main.tsx).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  assetLocator,
  clickPlay,
  clipsLocator,
  collectConsoleErrors,
  dragAssetToTimeline,
  expectMediaFile,
  importMedia,
  MEDIA,
  openApp,
  pressShortcut,
  screenshot,
  waitForDownload,
} from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Snap = {
  clips: { id: string; type: string; name: string; start: number; duration: number; trackKind: string; speed?: number; scale?: number; volumeDb?: number; filter?: string | null; content?: string }[];
  transitions: number;
  playhead: number;
  playing: boolean;
  selection: string[];
  aspect: string;
  width: number;
  height: number;
  assets: { name: string; missing: boolean }[];
  lastSavedAt: number | null;
  past: number;
  future: number;
};

async function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const p = s.project;
    return {
      clips: p.tracks.flatMap((t: any) =>
        t.clips.map((c: any) => ({
          id: c.id,
          type: c.type,
          name: c.name,
          start: c.start,
          duration: c.duration,
          trackKind: t.kind,
          speed: c.speed,
          scale: c.transform?.scale,
          volumeDb: c.audio?.volumeDb,
          filter: c.filter ? c.filter.id : null,
          content: c.text?.content,
        })),
      ),
      transitions: p.tracks.reduce((n: number, t: any) => n + t.transitions.length, 0),
      playhead: s.playhead,
      playing: s.playing,
      selection: s.selection.clipIds,
      aspect: p.settings.aspect,
      width: p.settings.width,
      height: p.settings.height,
      assets: Object.values(p.assets).map((a: any) => ({ name: a.name, missing: !!a.missing })),
      lastSavedAt: s.saveStatus.lastSavedAt,
      past: s.past.length,
      future: s.future.length,
    };
  });
}

const clipEl = (page: Page, name: string, nth = 0) => page.locator(`[data-testid="timeline-clip"][data-clip-name="${name}"]`).nth(nth);

/** Clicks the ruler at timeline time `sec` (uses the current zoom). */
async function scrubTo(page: Page, sec: number) {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  const zoom = await page.evaluate(() => (window as any).__oe.getState().zoom as number);
  const scrollLeft = await page.evaluate(() => document.querySelector('.tl-scroller')?.scrollLeft ?? 0);
  await page.mouse.click(box.x + sec * zoom - scrollLeft + 1, box.y + box.height / 2);
}

/** Lets the player land pending seeks before a screenshot. */
const settle = (page: Page) => page.waitForTimeout(400);

async function inspectorTab(page: Page, name: string) {
  await page.getByTestId('inspector').getByRole('tab', { name, exact: true }).click();
}

/** Types into an inspector number box (aria-label "<Label> value") and commits with Enter. */
async function setNumber(page: Page, label: string, value: string) {
  const box = page.getByTestId('inspector').getByLabel(`${label} value`, { exact: true }).first();
  await box.click();
  await box.fill(value);
  await box.press('Enter');
}

test.describe.configure({ mode: 'serial' });

test('v1 editing flows end to end', async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors = collectConsoleErrors(page);
  let step = 'boot';
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console.error @ ${step}] ${m.text()} ${JSON.stringify(m.location())}`);
  });
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe);
  await screenshot(page, '01-empty');
  step = '01-empty';

  // ---- import
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.image, MEDIA.tone]);
  await expect(page.getByTestId('media-asset')).toHaveCount(4);
  await screenshot(page, '02-imported');
  step = '02-imported';

  // ---- add by drag (main track) and by "+"
  await dragAssetToTimeline(page, MEDIA.vertical, 0, 20);
  let s = await snap(page);
  expect(s.clips.filter((c) => c.trackKind === 'main')).toHaveLength(1);

  // "+" adds at the playhead; move the playhead to the end of the first clip first
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(5_000_000));
  const land = assetLocator(page, MEDIA.landscape);
  await land.hover();
  await page.getByRole('button', { name: `Add ${MEDIA.landscape} to timeline` }).click();
  const tone = assetLocator(page, MEDIA.tone);
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(0));
  await tone.hover();
  await page.getByRole('button', { name: `Add ${MEDIA.tone} to timeline` }).click();
  s = await snap(page);
  expect(s.clips.map((c) => `${c.trackKind}:${c.name}`).sort()).toEqual(
    [`audio:${MEDIA.tone}`, `main:${MEDIA.landscape}`, `main:${MEDIA.vertical}`].sort(),
  );
  const mainClips = s.clips.filter((c) => c.trackKind === 'main');
  expect(mainClips[0]!.name).toBe(MEDIA.vertical);
  expect(mainClips[1]!.start).toBe(5_000_000);
  await screenshot(page, '03-clips-added');
  step = '03-clips-added';

  // ---- play / pause
  await scrubTo(page, 0);
  await clickPlay(page);
  await expect(page.getByTestId('play-button')).toHaveAttribute('aria-label', 'Pause');
  await page.waitForTimeout(1200);
  await clickPlay(page);
  await expect(page.getByTestId('play-button')).toHaveAttribute('aria-label', 'Play');
  s = await snap(page);
  expect(s.playing).toBe(false);
  expect(s.playhead).toBeGreaterThan(600_000);
  // Space with the play button still focused must toggle exactly once
  await page.keyboard.press('Space');
  await expect.poll(async () => (await snap(page)).playing).toBe(true);
  await page.waitForTimeout(300);
  expect((await snap(page)).playing).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await snap(page)).playing).toBe(false);
  await screenshot(page, '04-after-play');
  step = '04-after-play';

  // ---- scrub
  await scrubTo(page, 2);
  s = await snap(page);
  expect(Math.abs(s.playhead - 2_000_000)).toBeLessThan(120_000);
  await expect(page.getByTestId('timecode')).toContainText('00:00:02');
  await settle(page);
  await screenshot(page, '05-scrubbed');
  step = '05-scrubbed';

  // ---- split with ⌘B (selected vertical clip)
  await clipEl(page, MEDIA.vertical).click({ position: { x: 10, y: 20 } });
  await scrubTo(page, 2);
  await pressShortcut(page, 'Mod+B');
  s = await snap(page);
  expect(s.clips.filter((c) => c.name === MEDIA.vertical)).toHaveLength(2);
  await settle(page);
  await screenshot(page, '06-split');
  step = '06-split';

  // ---- trim the right edge of the landscape clip by -60px
  const landClip = clipEl(page, MEDIA.landscape);
  const before = (await snap(page)).clips.find((c) => c.name === MEDIA.landscape)!.duration;
  const lb = (await landClip.boundingBox())!;
  await page.mouse.move(lb.x + lb.width - 2, lb.y + lb.height / 2);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width - 30, lb.y + lb.height / 2, { steps: 5 });
  await page.mouse.move(lb.x + lb.width - 62, lb.y + lb.height / 2, { steps: 5 });
  await page.mouse.up();
  const afterTrim = (await snap(page)).clips.find((c) => c.name === MEDIA.landscape)!.duration;
  expect(afterTrim).toBeLessThan(before - 500_000);
  await settle(page);
  await screenshot(page, '07-trimmed');
  step = '07-trimmed';

  // ---- move the audio clip right by ~1.5 s
  const audioClip = clipEl(page, MEDIA.tone);
  const ab = (await audioClip.boundingBox())!;
  const zoom = await page.evaluate(() => (window as any).__oe.getState().zoom as number);
  await page.mouse.move(ab.x + 30, ab.y + ab.height / 2);
  await page.mouse.down();
  await page.mouse.move(ab.x + 50, ab.y + ab.height / 2, { steps: 4 });
  await page.mouse.move(ab.x + 30 + zoom * 1.5, ab.y + ab.height / 2, { steps: 8 });
  await page.mouse.up();
  s = await snap(page);
  const movedStart = s.clips.find((c) => c.name === MEDIA.tone)!.start;
  expect(movedStart).toBeGreaterThan(1_000_000);
  await settle(page);
  await screenshot(page, '08-moved');
  step = '08-moved';

  // ---- delete, undo, redo
  const count0 = s.clips.length;
  await clipEl(page, MEDIA.vertical, 1).click({ position: { x: 10, y: 20 } });
  await pressShortcut(page, 'Delete');
  expect((await snap(page)).clips.length).toBe(count0 - 1);
  await pressShortcut(page, 'Mod+Z');
  expect((await snap(page)).clips.length).toBe(count0);
  await pressShortcut(page, 'Mod+Shift+Z');
  expect((await snap(page)).clips.length).toBe(count0 - 1);
  await page.getByTestId('timeline-undo').click();
  expect((await snap(page)).clips.length).toBe(count0);
  await settle(page);
  await screenshot(page, '09-undo-redo');
  step = '09-undo-redo';

  // ---- add text (Text tab preset) and edit its content
  await page.getByTestId('library-tab-text').click();
  await scrubTo(page, 1);
  await page.getByTestId('text-preset').first().locator('.ptile__preview').click();
  s = await snap(page);
  const text = s.clips.find((c) => c.type === 'text');
  expect(text).toBeTruthy();
  await expect(page.getByTestId('inspector-text')).toBeVisible();
  await page.getByTestId('text-content').fill('Hello Vaslui');
  await page.getByTestId('text-content').blur();
  s = await snap(page);
  expect(s.clips.find((c) => c.type === 'text')!.content).toBe('Hello Vaslui');
  await settle(page);
  await screenshot(page, '10-text');
  step = '10-text';

  // ---- inspector: scale, volume, speed on the first vertical clip
  await clipEl(page, MEDIA.vertical, 0).click({ position: { x: 10, y: 20 } });
  await expect(page.getByTestId('inspector-video')).toBeVisible();
  await inspectorTab(page, 'Video');
  await setNumber(page, 'Scale', '150');
  let v = (await snap(page)).clips.find((c) => c.name === MEDIA.vertical)!;
  expect(v.scale).toBeCloseTo(1.5, 2);
  await settle(page);
  await screenshot(page, '11-scale');
  step = '11-scale';
  await inspectorTab(page, 'Audio');
  await setNumber(page, 'Volume', '-6');
  v = (await snap(page)).clips.find((c) => c.name === MEDIA.vertical)!;
  expect(v.volumeDb).toBeCloseTo(-6, 1);
  await settle(page);
  await screenshot(page, '12-volume');
  step = '12-volume';
  await inspectorTab(page, 'Speed');
  await setNumber(page, 'Speed', '2');
  v = (await snap(page)).clips.find((c) => c.name === MEDIA.vertical)!;
  expect(v.speed).toBeCloseTo(2, 2);
  await settle(page);
  await screenshot(page, '13-speed');
  step = '13-speed';

  // ---- transition on the cut after the selected clip
  await page.getByTestId('library-tab-transitions').click();
  await page.getByTestId('transition-preset').first().locator('.ptile__preview').click();
  s = await snap(page);
  expect(s.transitions).toBe(1);
  await expect(page.getByTestId('timeline-transition')).toHaveCount(1);
  await expect(page.getByTestId('inspector-transition')).toBeVisible();
  await settle(page);
  await screenshot(page, '14-transition');
  step = '14-transition';

  // ---- filter on the landscape clip
  await clipEl(page, MEDIA.landscape).click({ position: { x: 10, y: 20 } });
  await page.getByTestId('library-tab-filters').click();
  await page.getByTestId('filter-preset').nth(1).locator('.ptile__preview').click();
  s = await snap(page);
  expect(s.clips.find((c) => c.name === MEDIA.landscape)!.filter).not.toBeNull();
  await settle(page);
  await screenshot(page, '15-filter');
  step = '15-filter';

  // ---- ratio 16:9 then back to 9:16
  await page.getByTestId('player-ratio').click();
  await page.getByTestId('player-ratio-menu').getByRole('button', { name: '16:9' }).click();
  s = await snap(page);
  expect([s.aspect, s.width, s.height]).toEqual(['16:9', 1920, 1080]);
  await settle(page);
  await screenshot(page, '16-ratio-16x9');
  step = '16-ratio-16x9';
  await page.getByTestId('player-ratio').click();
  await page.getByTestId('player-ratio-menu').getByRole('button', { name: '9:16' }).click();
  s = await snap(page);
  expect([s.aspect, s.width, s.height]).toEqual(['9:16', 1080, 1920]);

  // ---- autosave survives a reload
  step = 'autosave-wait';
  const t0 = Date.now();
  await expect.poll(async () => (await snap(page)).lastSavedAt ?? 0, { timeout: 10_000 }).toBeGreaterThan(t0 - 1);
  await page.waitForTimeout(300);
  const beforeReload = await snap(page);
  step = 'reloading';
  await page.reload();
  step = 'reloaded';
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe);
  await expect.poll(async () => (await snap(page)).clips.length, { timeout: 10_000 }).toBe(beforeReload.clips.length);
  const afterReload = await snap(page);
  expect(afterReload.transitions).toBe(beforeReload.transitions);
  expect(afterReload.assets.every((a) => !a.missing)).toBe(true);
  expect(afterReload.clips.find((c) => c.type === 'text')!.content).toBe('Hello Vaslui');
  await expect(clipsLocator(page)).toHaveCount(beforeReload.clips.length);
  // filmstrip thumbnails come back for every video clip (object URLs re-created from IndexedDB)
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid="timeline-clip"][data-clip-type="video"]')).every((el) =>
            Array.from(el.querySelectorAll<HTMLElement>('[style]')).some((t) => t.style.backgroundImage.includes('blob:')),
          ),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  await settle(page);
  await screenshot(page, '17-after-reload');
  step = '17-after-reload';

  // ---- export a short project: keep only the first vertical clip (and the audio) → 1080x1920 MP4
  await page.evaluate(() => {
    const st = (window as any).__oe.getState();
    const p = st.project;
    const main = p.tracks.find((t: any) => t.kind === 'main');
    const keep = main.clips[0].id;
    const drop = p.tracks.flatMap((t: any) => t.clips).filter((c: any) => c.id !== keep && c.type !== 'audio').map((c: any) => c.id);
    st.deleteClips(drop);
  });
  const shortDur = await page.evaluate(() => {
    const p = (window as any).__oe.getState().project;
    return Math.max(...p.tracks.flatMap((t: any) => t.clips.map((c: any) => c.start + c.duration))) / 1e6;
  });
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('1080p');
  await screenshot(page, '18-export-dialog');
  step = '18-export-dialog';
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 180_000);
  const probe = expectMediaFile(file, { width: 1080, height: 1920, hasAudio: true, hasVideo: true, duration: shortDur, durationTolerance: 0.2 });
  console.log('export probe', JSON.stringify(probe));
  await screenshot(page, '19-export-done');
  step = '19-export-done';

  expect(consoleErrors.real(), consoleErrors.real().join('\n')).toEqual([]);
});
