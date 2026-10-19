/**
 * CapCut keyboard shortcuts in real Chromium: the new bindings (⌘⇧B, [ ], I/O, ⇧X, ⌥X, ⌘. ⌘, ,
 * ⌘⇧S, ⌘R, ⇧B, ~, Tab, ⌘I, ⌘⇧F, ⌥⇧Z, toasts), the shortcuts panel and the tooltips.
 * State checks read the dev-only store handle `window.__oe`.
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsoleErrors, importMedia, MEDIA, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';
const S = (sec: number) => Math.round(sec * 1_000_000);

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__oe.getState();
    return {
      playhead: s.playhead as number,
      selection: s.selection.clipIds as string[],
      past: s.past.length as number,
      clips: s.project.tracks.flatMap((t: any) =>
        t.clips.map((c: any) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          trackKind: t.kind,
          start: c.start,
          duration: c.duration,
          volumeDb: c.audio?.volumeDb,
          muted: c.audio?.muted,
          audioLink: c.audioLink ?? null,
        })),
      ) as { id: string; name: string; type: string; trackKind: string; start: number; duration: number; volumeDb?: number; muted?: boolean; audioLink: string | null }[],
    };
  });

const setPlayhead = (page: Page, us: number) => page.evaluate((t) => (window as any).__oe.getState().setPlayhead(t), us);
const select = (page: Page, ids: string[]) => page.evaluate((x) => (window as any).__oe.getState().select(x), ids);
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());

/** Imports the test media and builds: main [vertical 5 s][landscape 4 s], audio [tone 6 s]. */
async function setup(page: Page) {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe);
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.tone]);
  await page.evaluate((names) => {
    const s = (window as any).__oe.getState();
    const id = (n: string) => (Object.values(s.project.assets) as any[]).find((a) => a.name === n).id;
    s.addClip(id(names.vertical), { at: 0 });
    s.addClip(id(names.landscape), { at: 5_000_000 });
    s.addClip(id(names.tone), { at: 0 });
    s.clearSelection();
    s.setPlayhead(0);
  }, MEDIA);
  await blur(page);
}

test.describe.configure({ mode: 'serial' });

test('CapCut shortcuts work in the browser', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await setup(page);
  // survives ⌘R only if the reload was prevented
  await page.evaluate(() => ((window as any).__noReload = true));

  let s = await state(page);
  const vertical = s.clips.find((c) => c.name === MEDIA.vertical)!;
  expect(s.clips).toHaveLength(3);

  // ---- ⌘⇧B: split every track at the playhead (one undo step), ⌘B still only the selection
  await setPlayhead(page, S(2));
  await select(page, [vertical.id]);
  const past = (await state(page)).past;
  await page.keyboard.press(`${MOD}+Shift+KeyB`);
  s = await state(page);
  expect(s.clips).toHaveLength(5); // vertical and tone split
  expect(s.past).toBe(past + 1);
  await page.keyboard.press(`${MOD}+KeyZ`);
  expect((await state(page)).clips).toHaveLength(3);
  await page.keyboard.press(`${MOD}+KeyB`);
  expect((await state(page)).clips).toHaveLength(4); // only the selected clip
  await page.keyboard.press(`${MOD}+KeyZ`);

  // ---- [ / ]
  await setPlayhead(page, S(5.5));
  await page.keyboard.press('BracketLeft');
  s = await state(page);
  expect(s.selection.sort()).toEqual(s.clips.filter((c) => c.start < S(5.5)).map((c) => c.id).sort());
  expect(s.selection).toHaveLength(3);
  await page.keyboard.press('BracketRight');
  s = await state(page);
  expect(s.selection.sort()).toEqual(s.clips.filter((c) => c.start + c.duration > S(5.5)).map((c) => c.id).sort());
  expect(s.selection).toHaveLength(2); // landscape + tone
  // [ / ] also arm CapCut's Select leftward / rightward tools; A goes back to Select
  await expect(page.locator('.tl')).toHaveAttribute('data-tool', 'selectRight');
  await page.keyboard.press('KeyA');
  await expect(page.locator('.tl')).toHaveAttribute('data-tool', 'select');

  // ---- I / O, ⇧X, ⌥X, Esc
  const area = page.getByTestId('timeline-area');
  await setPlayhead(page, S(1));
  await page.keyboard.press('KeyI');
  await setPlayhead(page, S(3));
  await page.keyboard.press('KeyO');
  await expect(area).toBeVisible();
  await expect(area).toHaveAttribute('data-in', String(S(1)));
  await expect(area).toHaveAttribute('data-out', String(S(3)));
  await screenshot(page, 'shortcuts-01-in-out');
  await page.keyboard.press('Alt+KeyX');
  await expect(area).toHaveCount(0);
  await select(page, [vertical.id]);
  await page.keyboard.press('Shift+KeyX');
  await expect(area).toHaveAttribute('data-in', '0');
  await expect(area).toHaveAttribute('data-out', String(vertical.duration));
  await page.keyboard.press('Escape');
  await expect(area).toHaveCount(0);
  expect((await state(page)).selection).toEqual([vertical.id]); // Esc cleared the area first

  // typing in a text field never fires shortcuts
  await page.getByLabel('Project name').click();
  await page.keyboard.press('KeyI');
  await expect(area).toHaveCount(0);
  await page.getByLabel('Project name').press('Escape');
  await blur(page);

  // ---- ⌘. / ⌘, volume ±1 dB on the selection (undoable)
  await page.keyboard.press(`${MOD}+Period`);
  await page.keyboard.press(`${MOD}+Period`);
  await page.keyboard.press(`${MOD}+Comma`);
  expect((await state(page)).clips.find((c) => c.id === vertical.id)!.volumeDb).toBe(1);
  await page.keyboard.press(`${MOD}+KeyZ`);
  expect((await state(page)).clips.find((c) => c.id === vertical.id)!.volumeDb).toBe(2);
  await page.keyboard.press(`${MOD}+KeyZ`);
  await page.keyboard.press(`${MOD}+KeyZ`);
  expect((await state(page)).clips.find((c) => c.id === vertical.id)!.volumeDb).toBe(0);

  // ---- ⌘⇧S extract / restore audio
  await page.keyboard.press(`${MOD}+Shift+KeyS`);
  await expect(page.getByTestId('toast')).toHaveText('Audio extracted');
  s = await state(page);
  const v = s.clips.find((c) => c.id === vertical.id)!;
  const extracted = s.clips.find((c) => c.type === 'audio' && c.audioLink && c.audioLink === v.audioLink)!;
  expect(v.muted).toBe(true);
  expect(extracted).toMatchObject({ start: v.start, duration: v.duration, trackKind: 'audio' });
  await screenshot(page, 'shortcuts-02-extracted-audio');
  await page.keyboard.press(`${MOD}+Shift+KeyS`);
  await expect(page.getByTestId('toast')).toHaveText('Audio restored');
  s = await state(page);
  expect(s.clips).toHaveLength(3);
  expect(s.clips.find((c) => c.id === vertical.id)!.muted).toBe(false);

  // ---- ⌘R speed panel (and no page reload), ⇧B curve
  await page.keyboard.press(`${MOD}+KeyR`);
  await expect(page.getByTestId('inspector').getByRole('tab', { name: 'Speed', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('speed-row')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
  await page.keyboard.press('Shift+KeyB');
  await expect(page.getByTestId('speed-curve-soon')).toBeVisible();
  await screenshot(page, 'shortcuts-03-speed-curve');

  // ---- toast-only bindings
  await page.keyboard.press(`${MOD}+KeyG`);
  await expect(page.getByTestId('toast')).toHaveText('Coming soon: Group');
  await page.keyboard.press(`${MOD}+Shift+KeyG`);
  await expect(page.getByTestId('toast')).toHaveText('Coming soon: Ungroup');
  await page.keyboard.press('Alt+KeyG');
  await expect(page.getByTestId('toast')).toHaveText('Coming soon: Create compound clip');
  await page.keyboard.press(`${MOD}+KeyJ`);
  await expect(page.getByTestId('toast')).toHaveText('Coming soon: Match cut');
  await page.keyboard.press('Alt+KeyK');
  await expect(page.getByTestId('toast')).toHaveText('Keyframes — coming soon');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast')).toHaveText('Coming soon: Split caption');

  // ---- ~ linkage
  const linkage = page.getByTestId('timeline-linkage');
  const was = await linkage.getAttribute('aria-pressed');
  await page.keyboard.press('Backquote');
  await expect(linkage).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
  await page.keyboard.press('Shift+Backquote');
  await expect(linkage).toHaveAttribute('aria-pressed', String(was));

  // ---- Tab / Shift+Tab cycle the library tabs
  await expect(page.getByTestId('library-tab-media')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('library-tab-audio')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('library-tab-text')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('library-tab-media')).toHaveAttribute('aria-selected', 'true');

  // ---- ⌘I opens the import picker (also from another library tab)
  await page.keyboard.press('Tab');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5_000 }), page.keyboard.press(`${MOD}+KeyI`)]);
  expect(chooser.isMultiple()).toBe(true);
  await expect(page.getByTestId('library-tab-media')).toHaveAttribute('aria-selected', 'true');
  await chooser.setFiles([]);

  // ---- ⌥⇧Z fits the preview; ⌘⇧F full screen
  await page.getByTestId('player-zoom').click();
  await page.getByRole('button', { name: '150%' }).click();
  await expect(page.getByTestId('player-zoom')).toHaveText('150%');
  await blur(page);
  await page.keyboard.press('Alt+Shift+KeyZ');
  await expect(page.getByTestId('player-zoom')).toHaveText('Fit');
  await page.keyboard.press(`${MOD}+Shift+KeyF`);
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press(`${MOD}+Shift+KeyF`);
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  if (MAC) {
    await page.keyboard.press('Control+Meta+KeyF');
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
  }

  // ---- Hebrew layout: same physical keys, Hebrew characters in e.key
  await setPlayhead(page, S(2));
  await page.evaluate(() => (window as any).__oe.getState().clearSelection());
  const before = (await state(page)).clips.length;
  await page.evaluate((mac) => {
    const ev = (key: string, code: string, extra: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...extra }));
    ev('נ', 'KeyB', mac ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true }); // ⌘⇧B
    ev(']', 'BracketLeft'); // [ (mirrored on Hebrew)
  }, MAC);
  s = await state(page);
  expect(s.clips.length).toBe(before + 2);
  expect(s.selection.length).toBeGreaterThan(0);

  // ---- ⌘E export dialog
  await page.keyboard.press(`${MOD}+KeyE`);
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  // shortcuts are ignored behind a modal
  await page.keyboard.press('KeyI');
  await expect(page.getByTestId('timeline-area')).toHaveCount(0);
  await page.getByTestId('export-dialog').getByRole('button', { name: 'Close' }).click();

  expect(errors.real()).toEqual([]);
});

test('keyboard shortcuts panel and tooltips come from the shared table', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openApp(page);
  // labels follow the platform the PAGE reports (Playwright's "Desktop Chrome" claims Windows)
  const MAC = await page.evaluate(() => {
    const n = navigator as Navigator & { userAgentData?: { platform?: string } };
    return /mac|iphone|ipad|ipod/i.test(n.userAgentData?.platform || n.platform || n.userAgent);
  });
  await expect(page.getByTestId('shortcuts-button')).toBeVisible();
  const split = page.getByTestId('timeline-split');
  await expect(split).toHaveAttribute('title', MAC ? 'Split (⌘B)' : 'Split (Ctrl+B)');
  await expect(page.getByTestId('timeline-undo')).toHaveAttribute('title', MAC ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)');
  await expect(page.getByTestId('export-button')).toHaveAttribute('title', MAC ? 'Export (⌘E)' : 'Export (Ctrl+E)');

  await page.getByTestId('shortcuts-button').click();
  const panel = page.getByTestId('shortcuts-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('shortcuts-group')).toHaveCount(5);
  await expect(panel.getByRole('heading')).toHaveText(['Essentials', 'Tools', 'Timeline & preview', 'Audio & speed', 'Project & clipboard']);
  expect(await panel.getByTestId('shortcuts-row').count()).toBeGreaterThan(55);
  await expect(panel.getByText(MAC ? '⇧⌘B' : 'Ctrl+Shift+B')).toBeVisible();
  await expect(panel.locator('[data-status="soon"]')).toHaveCount(7);
  await expect(panel.getByText('Coming soon').first()).toBeVisible();
  await screenshot(page, 'shortcuts-04-panel');
  // the panel is modal: B must not switch to the split tool behind it
  await page.keyboard.press('KeyB');
  await expect(page.locator('.tl--split')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(errors.real()).toEqual([]);
});
