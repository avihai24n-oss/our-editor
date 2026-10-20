/**
 * Functional audit of the left panel (Library), the media pipeline and persistence.
 * Every control is driven like a user would, and every check asserts the REAL effect: the store
 * (window.__oe), IndexedDB, the timeline DOM, the player canvas pixels, and the state after a
 * reload. Results are written up in docs/AUDIT-library.md.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  assetByName,
  assets,
  blobKeys,
  boot,
  canvasSig,
  clickPreset,
  clips,
  countPixels,
  deleteStoredBlob,
  fixtures,
  openTab,
  plusOn,
  presetLabels,
  reloadAndWait,
  select,
  setPlayhead,
  settledSig,
  sigDiff,
  sigMean,
  state,
  tile,
  tileNames,
  transitions,
  waitSaved,
  waveBars,
} from './audit-helpers';
import { collectConsoleErrors, MEDIA, mediaPath, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const S = 1_000_000;
const FX = fixtures();

async function importViaButton(page: Page, files: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.lib__import').click();
  await (await chooser).setFiles(files);
}

async function importAndWait(page: Page, files: string[]) {
  await page.getByTestId('media-import-input').setInputFiles(files);
  for (const f of files) await expect(tile(page, path.basename(f))).toBeVisible({ timeout: 30_000 });
}

/** Waits until every tile with a poster (video / image) shows a decoded picture. */
async function expectPosters(page: Page, names: string[]) {
  for (const n of names) {
    await expect
      .poll(() => tile(page, n).locator('img.atile__img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0).catch(() => false), { timeout: 15_000 })
      .toBe(true);
  }
}

/** Real decoded peaks: a constant 330 Hz tone gives flat full-height bars (the stand-in is random 0.15..1). */
async function expectRealWaveforms(page: Page) {
  await expect.poll(async () => Math.min(...(await waveBars(page, MEDIA.tone))), { timeout: 15_000 }).toBeGreaterThan(0.85);
  // beeps with silences: some bars near the floor, some at the top
  await expect
    .poll(async () => {
      const b = await waveBars(page, MEDIA.beeps);
      return b.filter((v) => v <= 0.1).length >= 2 && b.some((v) => v > 0.95);
    }, { timeout: 15_000 })
    .toBe(true);
}


// ====================================================================== MEDIA

test('Media: Import button, multi-file import, probe, thumbnails, waveforms, persistence', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await boot(page);
  // empty state
  await expect(page.locator('.lib-empty')).toContainText('Import videos, images or audio');

  const files = [MEDIA.vertical, MEDIA.landscape, MEDIA.silent, MEDIA.image, MEDIA.tone, MEDIA.beeps].map(mediaPath);
  await importViaButton(page, files);
  for (const f of files) await expect(tile(page, path.basename(f))).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.lib-flash')).toHaveText('Imported 6 files');

  // store: probed kind, duration, size, audio presence
  const a = await assets(page);
  expect(a.map((x) => x.name)).toEqual(files.map((f) => path.basename(f)));
  const by = (n: string) => a.find((x) => x.name === n)!;
  expect(by(MEDIA.vertical)).toMatchObject({ kind: 'video', width: 1080, height: 1920, hasAudio: true });
  expect(Math.abs(by(MEDIA.vertical).duration - 5 * S)).toBeLessThan(0.1 * S);
  expect(by(MEDIA.landscape)).toMatchObject({ kind: 'video', width: 1920, height: 1080, hasAudio: true });
  expect(by(MEDIA.silent)).toMatchObject({ kind: 'video', hasAudio: false });
  expect(by(MEDIA.image)).toMatchObject({ kind: 'image', width: 1080, height: 1080, duration: 0 });
  expect(by(MEDIA.tone)).toMatchObject({ kind: 'audio' });
  expect(Math.abs(by(MEDIA.tone).duration - 6 * S)).toBeLessThan(0.1 * S);
  expect(by(MEDIA.beeps).kind).toBe('audio');

  // DOM: kinds, duration badges, posters, real waveforms
  for (const x of a) await expect(tile(page, x.name)).toHaveAttribute('data-asset-kind', x.kind);
  await expect(tile(page, MEDIA.vertical).locator('.atile__dur')).toHaveText('00:05');
  await expect(tile(page, MEDIA.tone).locator('.atile__dur')).toHaveText('00:06');
  await expect(tile(page, MEDIA.image).locator('.atile__dur')).toHaveCount(0);
  await expectPosters(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.silent, MEDIA.image]);
  await expectRealWaveforms(page);

  // IndexedDB: one blob per file
  expect((await blobKeys(page)).length).toBe(6);
  await screenshot(page, 'audit-01-imported');

  // reload: assets, thumbnails and waveforms come back from IndexedDB
  await page.waitForTimeout(1200); // project JSON autosave
  await reloadAndWait(page, 6);
  const after = await assets(page);
  expect(after.map((x) => x.name)).toEqual(files.map((f) => path.basename(f)));
  expect(after.every((x) => !x.missing)).toBe(true);
  await expectPosters(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.silent, MEDIA.image]);
  await expectRealWaveforms(page);
  expect(errors.real()).toEqual([]);
});

test('Media: search, sort, grid/list, categories; view prefs survive a reload', async ({ page }) => {
  await boot(page);
  await importAndWait(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.image, MEDIA.tone].map(mediaPath));
  expect(await tileNames(page)).toEqual([MEDIA.vertical, MEDIA.landscape, MEDIA.image, MEDIA.tone]);

  // search: case-insensitive substring, label, no-match state, Escape clears and closes
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const box = page.getByLabel('Search media');
  await box.fill('LAND');
  expect(await tileNames(page)).toEqual([MEDIA.landscape]);
  await expect(page.locator('.lib__label').first()).toHaveText('Results for “LAND”');
  await box.fill('.png');
  expect(await tileNames(page)).toEqual([MEDIA.image]);
  await box.fill('zzz');
  await expect(page.locator('.lib-empty')).toHaveText('No matching media');
  await box.press('Escape');
  await expect(box).toHaveCount(0);
  expect(await tileNames(page)).toHaveLength(4);

  // sort
  const sortBy = async (label: string) => {
    await page.getByRole('button', { name: 'Sort' }).click();
    await page.locator('.lib__sort-menu .menu__item', { hasText: label }).click();
  };
  await sortBy('Name');
  expect(await tileNames(page)).toEqual([MEDIA.tone, MEDIA.image, MEDIA.landscape, MEDIA.vertical]);
  await sortBy('Duration');
  expect(await tileNames(page)).toEqual([MEDIA.tone, MEDIA.vertical, MEDIA.landscape, MEDIA.image]);
  await sortBy('Type');
  expect(await tileNames(page)).toEqual([MEDIA.vertical, MEDIA.landscape, MEDIA.image, MEDIA.tone]);
  await sortBy('Date added');
  expect(await tileNames(page)).toEqual([MEDIA.vertical, MEDIA.landscape, MEDIA.image, MEDIA.tone]);

  // categories
  const cat = (label: string) => page.locator('.lib__side-item', { hasText: new RegExp(`^${label}$`) }).click();
  await cat('Videos');
  expect(await tileNames(page)).toEqual([MEDIA.vertical, MEDIA.landscape]);
  await cat('Images');
  expect(await tileNames(page)).toEqual([MEDIA.image]);
  await cat('Audio');
  expect(await tileNames(page)).toEqual([MEDIA.tone]);
  await cat('All');
  await expect(page.locator('.lib__side-item', { hasText: 'Library' })).toBeDisabled();

  // grid / list
  await expect(page.locator('.lib-grid .atile')).toHaveCount(4);
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.lib-list .atile--list')).toHaveCount(4);
  await expect(tile(page, MEDIA.tone).locator('.atile__meta').first()).toHaveText('Audio');
  await expect(tile(page, MEDIA.vertical).locator('.atile__meta--num')).toHaveText('00:05');
  await expect(tile(page, MEDIA.image).locator('.atile__meta--num')).toHaveText('—');

  // list view + Name sort persist across a reload
  await sortBy('Name');
  await reloadAndWait(page, 4);
  await expect(page.locator('.lib-list .atile--list')).toHaveCount(4);
  expect(await tileNames(page)).toEqual([MEDIA.tone, MEDIA.image, MEDIA.landscape, MEDIA.vertical]);
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page.locator('.lib-grid .atile')).toHaveCount(4);
});

test('Media: hover "+" and drag add on the right track, double-click / Enter only preview; "Added" badge', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await boot(page);
  await importAndWait(page, [MEDIA.vertical, MEDIA.image, MEDIA.tone, MEDIA.landscape, MEDIA.silent].map(mediaPath));
  await expect(page.locator('.atile__added')).toHaveCount(0);

  // video "+" at playhead 0 → main track at 0
  await plusOn(page, MEDIA.vertical);
  let c = await clips(page);
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ type: 'video', trackKind: 'main', start: 0 });
  await expect(page.locator(`[data-testid="timeline-track"][data-track-role="main"] [data-testid="timeline-clip"]`)).toHaveCount(1);
  await expect(tile(page, MEDIA.vertical).locator('.atile__added')).toHaveText('Added');
  await expect(page.locator('.atile__added')).toHaveCount(1);

  // audio "+" at playhead 2 s → an audio track, starting exactly at the playhead
  await setPlayhead(page, 2 * S);
  await plusOn(page, MEDIA.tone);
  c = await clips(page);
  const audio = c.find((x) => x.type === 'audio')!;
  expect(audio).toMatchObject({ trackKind: 'audio', start: 2 * S });
  await expect(page.locator(`[data-testid="timeline-track"][data-track-role="audio"] [data-testid="timeline-clip"]`)).toHaveCount(1);

  // image "+" with the playhead at 4 s (past the middle of the 5 s clip) → main track, after it (nearest cut)
  await setPlayhead(page, 4 * S);
  await plusOn(page, MEDIA.image);
  c = await clips(page);
  const img = c.find((x) => x.type === 'image')!;
  expect(img).toMatchObject({ trackKind: 'main', start: c.find((x) => x.name === MEDIA.vertical)!.duration });

  // CapCut: double-click and Enter do NOT add — they show the file in the player (source preview)
  const before0 = (await clips(page)).length;
  await tile(page, MEDIA.landscape).dblclick();
  await page.waitForTimeout(200);
  expect((await clips(page)).filter((x) => x.name === MEDIA.landscape)).toHaveLength(0);
  await expect(page.getByTestId('player-header')).toHaveText(`Media · ${MEDIA.landscape}`);
  await tile(page, MEDIA.silent).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  expect((await clips(page)).length).toBe(before0);
  await expect(page.getByTestId('player-header')).toHaveText(`Media · ${MEDIA.silent}`);
  // Enter on a tile is the tile's: the window shortcut (split caption → "Coming soon" toast) stays quiet
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await expect(page.locator('.atile__added')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('player-header')).toHaveText('Player');
  // the hover "+" still adds them
  await plusOn(page, MEDIA.landscape);
  await plusOn(page, MEDIA.silent);
  await expect(page.locator('.atile__added')).toHaveCount(5);

  // drag a tile onto the audio track row → lands on that track at the drop x
  const audioRow = page.locator('[data-testid="timeline-track"][data-track-role="audio"]').first();
  const before = (await clips(page)).length;
  await tile(page, MEDIA.tone).dragTo(audioRow, { targetPosition: { x: 600, y: 20 } });
  await expect.poll(async () => (await clips(page)).length).toBe(before + 1);
  const tones = (await clips(page)).filter((x) => x.name === MEDIA.tone);
  expect(tones.every((x) => x.trackKind === 'audio')).toBe(true);

  // dragging an audio file onto the MAIN track does not put audio on the main track
  const mainRow = page.locator('[data-testid="timeline-track"][data-track-role="main"]');
  await tile(page, MEDIA.tone).dragTo(mainRow, { targetPosition: { x: 200, y: 20 } });
  await expect.poll(async () => (await clips(page)).filter((x) => x.name === MEDIA.tone).length).toBe(3);
  expect((await clips(page)).filter((x) => x.trackKind === 'main').every((x) => x.type !== 'audio')).toBe(true);

  // a video dragged onto the main track goes on the main track
  const mainBefore = (await clips(page)).filter((x) => x.trackKind === 'main').length;
  await tile(page, MEDIA.landscape).dragTo(mainRow, { targetPosition: { x: 30, y: 20 } });
  await expect.poll(async () => (await clips(page)).filter((x) => x.trackKind === 'main').length).toBe(mainBefore + 1);

  // "Added" follows the timeline: deleting every clip of an asset removes its badge
  const silentIds = (await clips(page)).filter((x) => x.name === MEDIA.silent).map((x) => x.id);
  await page.evaluate((ids) => (window as any).__oe.getState().deleteClips(ids), silentIds);
  await expect(tile(page, MEDIA.silent).locator('.atile__added')).toHaveCount(0);
  await expect(page.locator('.atile__added')).toHaveCount(4);

  // a locked main track is never touched: "+" puts the clip on an overlay track instead
  const mainId = await state(page, '(s) => s.project.tracks.find((t) => t.kind === "main").id');
  await page.evaluate((id) => (window as any).__oe.getState().setTrack(id, { locked: true }), mainId);
  const n = (await clips(page)).length;
  const mainN = (await clips(page)).filter((x) => x.trackKind === 'main').length;
  await plusOn(page, MEDIA.vertical);
  await expect.poll(async () => (await clips(page)).length).toBe(n + 1);
  expect((await clips(page)).filter((x) => x.trackKind === 'main').length).toBe(mainN);
  expect((await clips(page)).filter((x) => x.name === MEDIA.vertical).some((x) => x.trackKind === 'overlay')).toBe(true);
  expect(errors.real()).toEqual([]);
});

test('Media: delete an asset (unused, used + confirm, cancel), undo / redo, and the stored blob', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await boot(page);
  await importAndWait(page, [MEDIA.vertical, MEDIA.image, MEDIA.tone].map(mediaPath));
  expect((await blobKeys(page)).length).toBe(3);

  // an unused asset: right-click → Delete from project, no confirmation
  await tile(page, MEDIA.tone).click({ button: 'right' });
  let dialogs = 0;
  page.on('dialog', () => dialogs++);
  await page.locator('.menu__item', { hasText: 'Delete from project' }).click();
  await expect(tile(page, MEDIA.tone)).toHaveCount(0);
  expect(dialogs).toBe(0);
  expect((await assets(page)).map((a) => a.name)).toEqual([MEDIA.vertical, MEDIA.image]);

  // used asset: the confirmation is shown; dismissing keeps everything
  await plusOn(page, MEDIA.image);
  await plusOn(page, MEDIA.vertical);
  await select(page, []);
  // the playhead on the image clip (the vertical video went in front of it, at the 0 cut)
  const imageClip = (await clips(page)).find((x) => x.name === MEDIA.image)!;
  const onImage = imageClip.start + 0.5 * S;
  await setPlayhead(page, onImage);
  const withImage = await settledSig(page);
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => void d.dismiss());
  await tile(page, MEDIA.image).click({ button: 'right' });
  await page.locator('.menu__item', { hasText: 'Delete from project' }).click();
  await expect(tile(page, MEDIA.image)).toBeVisible();
  expect((await clips(page)).length).toBe(2);

  // accepting removes the asset and its clips; the main track closes the gap
  page.once('dialog', (d) => void d.accept());
  await tile(page, MEDIA.image).click({ button: 'right' });
  await page.locator('.menu__item', { hasText: 'Delete from project' }).click();
  await expect(tile(page, MEDIA.image)).toHaveCount(0);
  let c = await clips(page);
  expect(c.map((x) => x.name)).toEqual([MEDIA.vertical]);
  expect(c[0]!.start).toBe(0);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1);
  const withoutImage = await settledSig(page, { notEqual: withImage, minDiff: 3 });
  expect(sigDiff(withImage, withoutImage)).toBeGreaterThan(3);

  // ⌘Z brings back the asset AND its clip, and the clip still has its media (pixels match)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(tile(page, MEDIA.image)).toBeVisible();
  c = await clips(page);
  expect(c.map((x) => x.name).sort()).toEqual([MEDIA.image, MEDIA.vertical].sort());
  const image = await assetByName(page, MEDIA.image);
  expect(image.missing).toBe(false);
  const orphans = await state(page, '(s) => s.project.tracks.flatMap((t) => t.clips).filter((c) => c.assetId && !s.project.assets[c.assetId]).length');
  expect(orphans).toBe(0);
  await expectPostersVisible(page, MEDIA.image);
  await setPlayhead(page, onImage);
  const undone = await settledSig(page, { notEqual: withoutImage, minDiff: 3 });
  expect(sigDiff(undone, withImage)).toBeLessThan(2);

  // ⇧⌘Z removes it again; undo once more and reload: it is still there, with its blob
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  await expect(tile(page, MEDIA.image)).toHaveCount(0);
  expect((await clips(page)).map((x) => x.name)).toEqual([MEDIA.vertical]);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(tile(page, MEDIA.image)).toBeVisible();
  await page.waitForTimeout(1200);
  await reloadAndWait(page, 2);
  expect((await assets(page)).every((a) => !a.missing)).toBe(true);
  expect((await clips(page)).length).toBe(2);
  // the tone (deleted earlier, unused) left no blob behind
  const want = (await assets(page)).map((a) => a.blobKey).sort();
  await expect.poll(async () => (await blobKeys(page)).sort()).toEqual(want);

  // a deletion that is saved and reloaded is final: its blob is gone from IndexedDB
  page.once('dialog', (d) => void d.accept());
  await tile(page, MEDIA.image).click({ button: 'right' });
  await page.locator('.menu__item', { hasText: 'Delete from project' }).click();
  await expect(tile(page, MEDIA.image)).toHaveCount(0);
  await page.waitForTimeout(1200);
  await reloadAndWait(page, 1);
  await expect.poll(async () => (await blobKeys(page)).length).toBe(1);
  expect(await blobKeys(page)).toEqual([(await assetByName(page, MEDIA.vertical)).blobKey]);

  // Delete on a focused tile deletes that MEDIA, not the selected timeline clip
  await importAndWait(page, [mediaPath(MEDIA.beeps)]);
  const v = (await clips(page))[0]!;
  await select(page, [v.id]);
  await tile(page, MEDIA.beeps).focus();
  await page.keyboard.press('Delete');
  await expect(tile(page, MEDIA.beeps)).toHaveCount(0);
  expect((await clips(page)).map((x) => x.id)).toEqual([v.id]);
  expect(errors.real()).toEqual([]);
});

async function expectPostersVisible(page: Page, name: string) {
  await expect
    .poll(() => tile(page, name).locator('img.atile__img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0).catch(() => false), { timeout: 15_000 })
    .toBe(true);
}

test('Media: missing media after the stored blob is removed — tile, clip, preview, relink by re-import', async ({ page }) => {
  const errors = collectConsoleErrors(page, [/ERR_FILE_NOT_FOUND/]);
  await boot(page);
  await importAndWait(page, [MEDIA.image, MEDIA.vertical].map(mediaPath));
  await plusOn(page, MEDIA.image);
  await select(page, []);
  const good = await settledSig(page);
  await page.waitForTimeout(1200);
  await waitSaved(page);
  const img = await assetByName(page, MEDIA.image);
  await deleteStoredBlob(page, img.blobKey);
  await reloadAndWait(page, 2);

  // store + tile + clip + inspector + preview all say "Media lost"
  await expect.poll(async () => (await assetByName(page, MEDIA.image)).missing).toBe(true);
  expect((await assetByName(page, MEDIA.vertical)).missing).toBe(false);
  await expect(tile(page, MEDIA.image).locator('.atile__lost')).toHaveText('Media lost');
  await expect(tile(page, MEDIA.image)).toHaveAttribute('draggable', 'false');
  await expect(tile(page, MEDIA.image).locator('.atile__add')).toHaveCount(0);
  await expect(page.locator('[data-testid="timeline-clip"] .tl-clip__lost')).toHaveText('Media lost');
  await select(page, [(await clips(page))[0]!.id]);
  await expect(page.getByTestId('inspector')).toContainText('Media lost');
  await select(page, []);
  const lost = await settledSig(page, { notEqual: good, minDiff: 3 });
  // the preview draws the red "Media lost" placeholder (same as the export)
  expect(await countPixels(page, 'r > 70 && r < 110 && g < 45 && b < 45')).toBeGreaterThan(1000);
  // the + / double-click / Enter on a lost tile do nothing
  const n = (await clips(page)).length;
  await tile(page, MEDIA.image).dblclick();
  expect((await clips(page)).length).toBe(n);
  await screenshot(page, 'audit-02-media-lost');

  // re-importing the same file relinks the lost asset: no duplicate tile, the clip plays again
  await page.getByTestId('media-import-input').setInputFiles([mediaPath(MEDIA.image)]);
  await expect.poll(async () => (await assetByName(page, MEDIA.image)).missing, { timeout: 15_000 }).toBe(false);
  expect((await assets(page)).filter((a) => a.name === MEDIA.image)).toHaveLength(1);
  await expect(page.locator('[data-testid="timeline-clip"] .tl-clip__lost')).toHaveCount(0);
  const back = await settledSig(page, { notEqual: lost, minDiff: 3 });
  expect(sigDiff(back, good)).toBeLessThan(2);
  // and it survives a reload
  await page.waitForTimeout(1200);
  await reloadAndWait(page, 2);
  await expect.poll(async () => (await assetByName(page, MEDIA.image)).missing).toBe(false);
  expect(errors.real()).toEqual([]);
});

test('Media: the same file twice, unsupported and broken files', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await boot(page);
  await importAndWait(page, [mediaPath(MEDIA.vertical)]);
  await page.getByTestId('media-import-input').setInputFiles([mediaPath(MEDIA.vertical)]);
  await expect(page.locator('.lib-flash')).toBeVisible();
  const a = await assets(page);
  // the same file twice does not create a second tile, nor a second stored copy
  expect(a.filter((x) => x.name === MEDIA.vertical)).toHaveLength(1);
  expect(await tileNames(page)).toEqual([MEDIA.vertical]);
  expect((await blobKeys(page)).length).toBe(1);
  await expect(page.locator('.lib-flash')).toContainText('already');

  // unsupported type through the Import input: refused with a message, nothing added
  await page.getByTestId('media-import-input').setInputFiles([FX.notes]);
  await expect(page.locator('.lib-flash--error')).toContainText('notes.txt');
  // a corrupt ".mp4": refused with a message, nothing added, no stored blob
  await page.getByTestId('media-import-input').setInputFiles([FX.broken]);
  await expect(page.locator('.lib-flash--error')).toContainText('broken.mp4', { timeout: 20_000 });
  expect((await assets(page)).length).toBe(1);
  expect((await blobKeys(page)).length).toBe(1);
  // a mixed batch: the good file is imported, the bad ones are reported
  await page.getByTestId('media-import-input').setInputFiles([FX.notes, mediaPath(MEDIA.tone), FX.broken]);
  await expect(tile(page, MEDIA.tone)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.lib-flash--error')).toContainText('2 files could not be imported');
  expect((await assets(page)).map((x) => x.name)).toEqual([MEDIA.vertical, MEDIA.tone]);
  expect(errors.real()).toEqual([]);
});

test('Media: drag-and-drop from the OS onto the Media panel itself', async ({ page }) => {
  await boot(page);
  const b64 = fs.readFileSync(mediaPath(MEDIA.image)).toString('base64');
  const dropped = await page.evaluate((data) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const el = document.querySelector('.lib__scroll') as HTMLElement;
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt };
    el.dispatchEvent(new DragEvent('dragenter', init));
    el.dispatchEvent(new DragEvent('dragover', init));
    const ev = new DragEvent('drop', init);
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, b64);
  expect(dropped).toBe(true);
  await expect(tile(page, 'dropped.png')).toBeVisible({ timeout: 15_000 });
  expect((await clips(page)).length).toBe(0);
  expect((await blobKeys(page)).length).toBe(1);
});

test('Media: a 60 s 1080x1920 file imports, previews at 45 s, and survives a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await boot(page);
  await importAndWait(page, [FX.long]);
  const a = await assetByName(page, path.basename(FX.long));
  expect(a).toMatchObject({ kind: 'video', width: 1080, height: 1920, hasAudio: true });
  expect(Math.abs(a.duration - 60 * S)).toBeLessThan(0.1 * S);
  await expect(tile(page, a.name).locator('.atile__dur')).toHaveText('01:00');
  await expectPostersVisible(page, a.name);
  await plusOn(page, a.name);
  const c = (await clips(page))[0]!;
  expect(Math.abs(c.duration - 60 * S)).toBeLessThan(0.1 * S);
  await select(page, []);
  await setPlayhead(page, 5 * S);
  const at5 = await settledSig(page);
  expect(sigMean(at5)).toBeGreaterThan(20);
  await setPlayhead(page, 45 * S);
  const at45 = await settledSig(page, { notEqual: at5, minDiff: 1 });
  expect(sigDiff(at5, at45)).toBeGreaterThan(1); // testsrc2 moves: a different frame was decoded
  await page.waitForTimeout(1200);
  await reloadAndWait(page, 1);
  expect((await assetByName(page, a.name)).missing).toBe(false);
  await expectPostersVisible(page, a.name);
  expect(errors.real()).toEqual([]);
});

// ====================================================================== AUDIO TAB

test('Audio tab: only audio, import filter, "+" goes to an audio track, Sound effects coming soon', async ({ page }) => {
  await boot(page);
  await importAndWait(page, [MEDIA.vertical, MEDIA.tone, MEDIA.beeps].map(mediaPath));
  await openTab(page, 'audio');
  expect(await tileNames(page)).toEqual([MEDIA.tone, MEDIA.beeps]);
  await expect(page.getByTestId('media-import-input')).toHaveAttribute('accept', 'audio/*');
  await expectRealWaveforms(page);
  await plusOn(page, MEDIA.beeps);
  const c = await clips(page);
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ type: 'audio', trackKind: 'audio' });
  await expect(tile(page, MEDIA.beeps).locator('.atile__added')).toBeVisible();
  // importing from the Audio tab
  await page.getByTestId('media-import-input').setInputFiles([mediaPath(MEDIA.landscape)]);
  // a video picked anyway (accept is only a hint) goes to the Media pool, not this list
  await expect.poll(async () => (await assets(page)).length).toBe(4);
  expect(await tileNames(page)).toEqual([MEDIA.tone, MEDIA.beeps]);
  await page.locator('.lib__side-item', { hasText: 'Sound effects' }).click();
  await expect(page.locator('.lib-soon')).toContainText('Sound effects');
  await expect(page.locator('.lib__side-item', { hasText: 'Music' })).toBeDisabled();
});

// ====================================================================== TEXT

test('Text tab: every preset adds a styled text clip that renders', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await boot(page);
  await openTab(page, 'text');
  const labels = await presetLabels(page, 'text-preset');
  expect(labels).toEqual(['Default text', 'Title', 'Subtitle', 'Outline', 'Caption', 'Shadow', 'Neon', 'Label', 'Serif', 'Typewriter']);
  const blank = await settledSig(page);
  const sigs: Record<string, number[]> = {};
  let defaultWhite = Infinity;
  const expected: Record<string, any> = {
    'Default text': { content: 'Default text' },
    Title: { content: 'Title', fontFamily: 'Impact', fontSize: 140 },
    Subtitle: { content: 'Subtitle', fontSize: 54, background: { enabled: true } },
    Outline: { content: 'Outline', fontSize: 110, bold: true, stroke: { enabled: true, color: '#000000', width: 10 } },
    Caption: { content: 'Caption', color: '#ffe14d', stroke: { enabled: true } },
    Shadow: { content: 'Shadow', shadow: { enabled: true, blur: 12 } },
    Neon: { content: 'Neon', color: '#7df9ff', shadow: { enabled: true, color: '#22d3ee' } },
    Label: { content: 'LABEL', color: '#111111', background: { enabled: true, color: '#ffffff', opacity: 1 } },
    Serif: { content: 'Elegant', fontFamily: 'Georgia', italic: true },
    Typewriter: { content: 'Typewriter', fontFamily: 'Courier New' },
  };
  for (const label of labels) {
    const past = await state(page, '(s) => s.past.length');
    await clickPreset(page, 'text-preset', label);
    const c = (await clips(page)).filter((x) => x.type === 'text');
    expect(c).toHaveLength(1);
    expect(c[0]!.trackKind).toBe('text');
    expect(c[0]!.text).toMatchObject(expected[label]);
    expect(await state(page, '(s) => s.past.length')).toBe(past + 1); // one undo step
    await expect(page.locator('[data-testid="timeline-track"][data-track-role="text"] [data-testid="timeline-clip"]')).toHaveCount(1);
    await select(page, []);
    await setPlayhead(page, c[0]!.start + 0.5 * S);
    sigs[label] = await settledSig(page, { notEqual: blank, minDiff: 0.1 });
    expect(sigDiff(sigs[label]!, blank), `${label} renders pixels`).toBeGreaterThan(0.1);
    expect(await countPixels(page, 'r + g + b > 360'), `${label} draws bright glyphs or a box`).toBeGreaterThan(100);
    if (label === 'Caption') expect(await countPixels(page, 'r > 200 && g > 190 && b < 120')).toBeGreaterThan(200);
    if (label === 'Neon') expect(await countPixels(page, 'r < 170 && g > 200 && b > 200')).toBeGreaterThan(200);
    const white = await countPixels(page, 'r > 245 && g > 245 && b > 245');
    if (label === 'Default text') defaultWhite = white;
    // the white box of Label covers far more pixels than white glyphs do
    if (label === 'Label') expect(white).toBeGreaterThan(defaultWhite * 2);
    if (label === 'Subtitle') expect(await countPixels(page, 'r > 0 && r < 40 && g < 40 && b < 40')).toBeGreaterThan(0);
    await page.evaluate((id) => (window as any).__oe.getState().deleteClips([id]), c[0]!.id);
  }
  // every style looks different from every other
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) expect(sigDiff(sigs[labels[i]!]!, sigs[labels[j]!]!), `${labels[i]} vs ${labels[j]}`).toBeGreaterThan(0.2);

  // the "+" adds too, at the playhead
  await setPlayhead(page, 2 * S);
  const neon = page.locator('[data-testid="text-preset"]').filter({ hasText: 'Neon' });
  await neon.hover();
  await neon.locator('.ptile__add').click();
  const added = (await clips(page)).find((x) => x.type === 'text')!;
  expect(added.start).toBe(2 * S);
  expect(added.text.color).toBe('#7df9ff');
  // dragging a preset onto the timeline lands it styled
  await neon.dragTo(page.locator('[data-testid="timeline-track"][data-track-role="main"]'), { targetPosition: { x: 40, y: 20 } });
  await expect.poll(async () => (await clips(page)).filter((x) => x.type === 'text').length).toBe(2);
  expect((await clips(page)).filter((x) => x.type === 'text').every((x) => x.text.color === '#7df9ff')).toBe(true);
  await expect(page.locator('.lib__side-item', { hasText: 'Text templates' })).toBeDisabled();
  expect(errors.real()).toEqual([]);
});

// ====================================================================== TRANSITIONS

test('Transitions tab: every transition lands on the right cut and renders a different mid frame', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await boot(page);
  await importAndWait(page, [mediaPath(MEDIA.image), FX.texture, mediaPath(MEDIA.vertical)]);
  await plusOn(page, MEDIA.image);
  await setPlayhead(page, 60 * S);
  await plusOn(page, path.basename(FX.texture));
  await setPlayhead(page, 60 * S);
  await plusOn(page, MEDIA.vertical);
  const main = (await clips(page)).filter((x) => x.trackKind === 'main');
  expect(main.map((x) => x.name)).toEqual([MEDIA.image, path.basename(FX.texture), MEDIA.vertical]);
  const [A, B, C] = main as [any, any, any];
  const cut = A.start + A.duration;

  await openTab(page, 'transitions');
  const labels = await presetLabels(page, 'transition-preset');
  expect(labels).toEqual(['Mix', 'Black Fade', 'White Flash', 'Blur', 'Zoom', 'Slide Left', 'Slide Right', 'Slide Up', 'Slide Down', 'Wipe Left', 'Wipe Right']);

  // nothing selected, playhead far from every cut but nearest to B|C → B|C
  await select(page, []);
  await setPlayhead(page, B.start + B.duration - 0.2 * S);
  await clickPreset(page, 'transition-preset', 'Mix');
  let tr = await transitions(page);
  expect(tr).toHaveLength(1);
  expect(tr[0]).toMatchObject({ fromClipId: B.id, toClipId: C.id, type: 'mix', trackKind: 'main' });
  await page.evaluate((id) => (window as any).__oe.getState().removeTransition(id), tr[0]!.id);
  // the LAST clip selected → the cut before it (B|C)
  await select(page, [C.id]);
  await clickPreset(page, 'transition-preset', 'Mix');
  tr = await transitions(page);
  expect(tr[0]).toMatchObject({ fromClipId: B.id, toClipId: C.id });
  await page.evaluate((id) => (window as any).__oe.getState().removeTransition(id), tr[0]!.id);

  // reference frames at the A|B cut with no transition: just before (A) and at the cut (B)
  await select(page, []);
  await setPlayhead(page, cut - 0.02 * S);
  const pureA = await settledSig(page);
  await setPlayhead(page, cut);
  const pureB = await settledSig(page, { notEqual: pureA, minDiff: 3 });
  expect(sigDiff(pureA, pureB)).toBeGreaterThan(3);

  // first clip selected → the cut after it (A|B); each type renders its own mid-transition frame
  const mids: Record<string, number[]> = {};
  for (const label of labels) {
    await select(page, [A.id]);
    await clickPreset(page, 'transition-preset', label);
    tr = await transitions(page);
    expect(tr, label).toHaveLength(1);
    expect(tr[0]).toMatchObject({ fromClipId: A.id, toClipId: B.id });
    // the inspector shows the transition and the cut marker is on the timeline
    await expect(page.getByTestId('inspector-transition')).toBeVisible();
    await expect(page.getByTestId('timeline-transition')).toHaveCount(1);
    // the progress at the cut is 0.5 (mid-transition); sample 1 frame later to stay clear of the exact boundary
    await select(page, []);
    await setPlayhead(page, cut + Math.round(S / 30));
    mids[label] = await settledSig(page, { notEqual: pureB, minDiff: 2 });
    expect(sigDiff(mids[label]!, pureA), `${label} ≠ clip A`).toBeGreaterThan(2);
    expect(sigDiff(mids[label]!, pureB), `${label} ≠ clip B`).toBeGreaterThan(2);
    await page.evaluate((id) => (window as any).__oe.getState().removeTransition(id), tr[0]!.id);
  }
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) expect(sigDiff(mids[labels[i]!]!, mids[labels[j]!]!), `${labels[i]} vs ${labels[j]}`).toBeGreaterThan(1);

  // a selected transition: clicking another type changes it in place
  await select(page, [A.id]);
  await clickPreset(page, 'transition-preset', 'Zoom');
  const id = (await transitions(page))[0]!.id;
  await clickPreset(page, 'transition-preset', 'Wipe Left');
  tr = await transitions(page);
  expect(tr).toHaveLength(1);
  expect(tr[0]).toMatchObject({ id, type: 'wipe-left' });
  // drag a transition tile onto the B|C cut
  await page.evaluate((id) => (window as any).__oe.getState().removeTransition(id), id);
  const zoom = await state(page, '(s) => s.zoom');
  const row = page.locator('[data-testid="timeline-track"][data-track-role="main"]');
  const rb = (await row.boundingBox())!;
  const lane = await page.evaluate(() => {
    const clip = document.querySelector('[data-testid="timeline-clip"]') as HTMLElement;
    const row = document.querySelector('[data-testid="timeline-track"][data-track-role="main"]') as HTMLElement;
    return clip.getBoundingClientRect().left - row.getBoundingClientRect().left;
  });
  const x = lane + ((B.start + B.duration) / S) * zoom;
  await page.locator('[data-testid="transition-preset"]').filter({ hasText: 'Slide Up' }).dragTo(row, { targetPosition: { x, y: rb.height / 2 } });
  await expect.poll(async () => (await transitions(page)).length).toBe(1);
  expect((await transitions(page))[0]).toMatchObject({ fromClipId: B.id, toClipId: C.id, type: 'slide-up' });
  // with no clip touching another, a click explains why nothing happened
  await page.evaluate(() => (window as any).__oe.getState().newProject());
  await clickPreset(page, 'transition-preset', 'Mix');
  await expect(page.locator('.lib-flash')).toContainText('Select a clip that touches another clip');
  expect(errors.real()).toEqual([]);
});

// ====================================================================== FILTERS / ADJUSTMENT

async function setupLookClip(page: Page) {
  await importAndWait(page, [FX.texture]);
  await plusOn(page, path.basename(FX.texture));
  const c = (await clips(page))[0]!;
  await setPlayhead(page, 0.5 * S);
  return c;
}

test('Filters tab: every filter changes the pixels; None restores; needs a selection', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  await boot(page);
  const c = await setupLookClip(page);
  await openTab(page, 'filters');
  // nothing selected: a hint, no change
  await select(page, []);
  await clickPreset(page, 'filter-preset', 'B&W');
  await expect(page.locator('.lib-flash')).toContainText('Select a video, image or text clip first');
  expect((await clips(page))[0]!.filter).toBeNull();
  // with a clip selected, the tiles preview the look on that clip's own picture; with nothing
  // selected, on a built-in sample scene (tab-adjust: tiles are graded data: JPEGs, gradePreview.tsx)
  const tileSrc = () => page.locator('[data-testid="filter-preset"] .look img').first().getAttribute('src');
  const sample = await tileSrc();
  await select(page, [c.id]);
  await expect.poll(tileSrc).toMatch(/^(blob:|data:image\/)/);
  await expect.poll(tileSrc).not.toBe(sample);
  const own = await tileSrc();
  await select(page, []);
  await expect.poll(tileSrc).not.toBe(own);
  const base = await settledSig(page);
  const labels = await presetLabels(page, 'filter-preset');
  expect(labels).toEqual(['B&W', 'Noir', 'Warm', 'Cool', 'Vivid', 'Sepia', 'Vintage', 'Retro', 'Matte', 'Cinematic']);
  const ids = ['mono', 'noir', 'warm', 'cool', 'vivid', 'sepia', 'vintage', 'retro', 'fade', 'cinematic'];
  const sigs: number[][] = [];
  for (const [i, label] of labels.entries()) {
    await select(page, [c.id]);
    await clickPreset(page, 'filter-preset', label);
    expect((await clips(page))[0]!.filter).toBe(ids[i]);
    await expect(page.locator('[data-testid="filter-preset"].is-active .ptile__name')).toHaveText(label);
    await select(page, []);
    const s = await settledSig(page, { notEqual: base, minDiff: 1 });
    expect(sigDiff(s, base), `${label} changes pixels`).toBeGreaterThan(1);
    sigs.push(s);
  }
  for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) expect(sigDiff(sigs[i]!, sigs[j]!), `${labels[i]} vs ${labels[j]}`).toBeGreaterThan(0.5);
  // B&W really is grey: R = G = B everywhere
  await select(page, [c.id]);
  await clickPreset(page, 'filter-preset', 'B&W');
  await select(page, []);
  await settledSig(page, { notEqual: base, minDiff: 1 });
  expect(await countPixels(page, 'Math.abs(r - g) > 6 || Math.abs(g - b) > 6')).toBeLessThan(50);
  // None clears it and the original picture comes back
  await select(page, [c.id]);
  await page.locator('.ptile', { has: page.locator('.ptile__name', { hasText: /^None$/ }) }).locator('.ptile__preview').click();
  expect((await clips(page))[0]!.filter).toBeNull();
  await select(page, []);
  expect(sigDiff(await settledSig(page, { notEqual: sigs[0], minDiff: 1 }), base)).toBeLessThan(0.5);
  // a filter survives a reload
  await select(page, [c.id]);
  await clickPreset(page, 'filter-preset', 'Sepia');
  await page.waitForTimeout(1200);
  await reloadAndWait(page, 1);
  expect((await clips(page))[0]!.filter).toBe('sepia');
  await setPlayhead(page, 0.5 * S);
  expect(sigDiff(await settledSig(page, { notEqual: base, minDiff: 1 }), sigs[5]!)).toBeLessThan(0.5);
  expect(errors.real()).toEqual([]);
});

test('Adjustment tab: every preset changes the pixels and sets Adjust; Reset restores', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  await boot(page);
  const c = await setupLookClip(page);
  await openTab(page, 'adjustment');
  await select(page, []);
  const base = await settledSig(page);
  const labels = await presetLabels(page, 'adjust-preset');
  expect(labels).toEqual(['Brighten', 'Darken', 'High contrast', 'Soft', 'Warm up', 'Cool down', 'Pop color', 'Desaturate', 'Matte', 'Vignette', 'Crisp']);
  const want: Record<string, Record<string, number>> = {
    Brighten: { brightness: 18, exposure: 8 },
    Darken: { brightness: -15, exposure: -8 },
    'High contrast': { contrast: 30 },
    Soft: { contrast: -18, shadows: 12 },
    'Warm up': { temperature: 25 },
    'Cool down': { temperature: -25 },
    'Pop color': { saturation: 30 },
    Desaturate: { saturation: -40 },
    Matte: { fade: 40 },
    Vignette: { vignette: 55 },
    Crisp: { sharpen: 45 },
  };
  const sigs: number[][] = [];
  for (const label of labels) {
    await select(page, [c.id]);
    await clickPreset(page, 'adjust-preset', label);
    const adj = (await clips(page))[0]!.adjust!;
    expect(adj).toMatchObject(want[label]!);
    await expect(page.locator('[data-testid="adjust-preset"].is-active .ptile__name')).toHaveText(label);
    await select(page, []);
    const s = await settledSig(page, { notEqual: base, minDiff: 0.5 });
    expect(sigDiff(s, base), `${label} changes pixels`).toBeGreaterThan(0.5);
    sigs.push(s);
  }
  const mean = (s: number[]) => sigMean(s);
  expect(mean(sigs[0]!)).toBeGreaterThan(mean(base)); // Brighten
  expect(mean(sigs[1]!)).toBeLessThan(mean(base)); // Darken
  // Vignette darkens the corners more than the centre
  const corner = (s: number[]) => (s[0]! + s[1]! + s[2]!) / 3;
  expect(corner(sigs[9]!)).toBeLessThan(corner(base) - 3);
  // Reset → neutral, original pixels
  await select(page, [c.id]);
  await page.locator('.ptile', { has: page.locator('.ptile__name', { hasText: /^Reset$/ }) }).locator('.ptile__preview').click();
  expect(Object.values((await clips(page))[0]!.adjust!).every((v) => v === 0)).toBe(true);
  await select(page, []);
  expect(sigDiff(await settledSig(page, { notEqual: sigs[10], minDiff: 0.5 }), base)).toBeLessThan(0.5);
  await expect(page.locator('.lib__side-item', { hasText: 'Adjustment layer' })).toBeDisabled();
  expect(errors.real()).toEqual([]);
});

// ====================================================================== COMING SOON + TABS

test('Stickers / Effects / Captions / Templates show a clean coming-soon state; the tab persists', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await boot(page);
  for (const [id, label] of [
    ['stickers', 'Stickers'],
    ['effects', 'Effects'],
    ['captions', 'Captions'],
    ['templates', 'Templates'],
  ] as const) {
    await openTab(page, id);
    await expect(page.getByTestId(`library-tab-${id}`)).toHaveAttribute('title', `${label} — coming soon`);
    await expect(page.locator('.lib-soon__title')).toHaveText(label);
    await expect(page.locator('.lib-soon__note')).toContainText('later version');
    await expect(page.locator('.lib-content .lib-grid, .lib-content .ptile, .lib-content [data-testid="media-asset"]')).toHaveCount(0);
    expect(await state(page, '(s) => s.past.length')).toBe(0);
  }
  await screenshot(page, 'audit-03-coming-soon');
  // the chosen tab is remembered
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oe);
  await expect(page.getByTestId('library-tab-templates')).toHaveAttribute('aria-selected', 'true');
  expect(errors.real()).toEqual([]);
});
