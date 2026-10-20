/**
 * CapCut's right-click menu on a timeline clip, in real Chromium: CapCut's list in CapCut's
 * order, Copy / Cut / Delete / Extract audio / Deactivate through the menu (checked on the model),
 * ⇧⌃S, a hover submenu (a slot registered through the contract), keyboard navigation, Esc,
 * outside press, scroll and the viewport. State checks read the dev-only `window.__oe*` handles.
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsoleErrors, importMedia, MEDIA, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The platform the app sees (Playwright's Desktop Chrome reports Windows even on a Mac). */
const appIsMac = (page: Page) => page.evaluate(() => /mac|iphone|ipad/i.test((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent));

const CAPCUT = [
  'EditPilot', '-',
  'Copy', 'Cut', 'Copy/paste attributes', 'Delete', 'Edit', '-',
  'Split scenes', 'Transcript', 'Generate captions', 'Isolate voice', 'Extract audio', 'Remove background', '-',
  'Enhance audio', 'Enhance visuals', 'Adjust color', 'Enhance motion', '-',
  'Group', 'Create compound clip (subproject)', 'Save preset', '-',
  'Export selected clips', 'Deactivate clip', 'More clip actions', '-',
  'Range', 'Render',
];

const model = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__oe.getState();
    return {
      selection: s.selection.clipIds as string[],
      clipboard: (window as any).__oeUi.getState().clipboard.map((c: any) => c.id) as string[],
      clips: s.project.tracks.flatMap((t: any) => t.clips.map((c: any) => ({ id: c.id, type: c.type, disabled: !!c.disabled, muted: !!c.audio?.muted }))) as {
        id: string;
        type: string;
        disabled: boolean;
        muted: boolean;
      }[],
    };
  });

const menu = (page: Page) => page.getByTestId('clip-context-menu');
const item = (page: Page, id: string) => menu(page).locator(`[data-testid="ctx-item"][data-item-id="${id}"]`);
const clip = (page: Page, i: number) => page.getByTestId('timeline-clip').nth(i);

async function openOn(page: Page, i: number) {
  await clip(page, i).click({ button: 'right', position: { x: 30, y: 20 } });
  await expect(menu(page)).toBeVisible();
}

/** Labels of the open menu with '-' for separators. */
const labels = (page: Page) =>
  menu(page).evaluate((el) =>
    [...el.querySelectorAll('.ctxm__sep, .ctxm__label')].map((n) => (n.classList.contains('ctxm__sep') ? '-' : n.textContent ?? '')),
  );

async function setup(page: Page) {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe && !!(window as any).__oeMenu);
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape]);
  await page.evaluate((names) => {
    const s = (window as any).__oe.getState();
    const id = (n: string) => (Object.values(s.project.assets) as any[]).find((a) => a.name === n).id;
    s.addClip(id(names.vertical), { at: 0 });
    s.addClip(id(names.landscape), { at: 5_000_000 });
    s.clearSelection();
    window.addEventListener('contextmenu', (e) => ((window as any).__ctxPrevented = e.defaultPrevented));
  }, MEDIA);
}

test.describe.configure({ mode: 'serial' });

test("the clip menu is CapCut's, and its actions work", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await setup(page);
  const [a, b] = (await model(page)).clips.map((c) => c.id);

  // right-click an unselected clip: it becomes the selection, the browser menu never shows
  await openOn(page, 0);
  expect((await model(page)).selection).toEqual([a]);
  expect(await page.evaluate(() => (window as any).__ctxPrevented)).toBe(true);
  expect(await labels(page)).toEqual(CAPCUT);
  await screenshot(page, 'context-menu');

  // enabled rows, Soon tags, keys
  const enabled = await menu(page).locator('[data-testid="ctx-item"]:not([aria-disabled])').evaluateAll((els) => els.map((e) => e.getAttribute('data-item-id')));
  expect(enabled).toEqual(['copy', 'cut', 'delete', 'extractAudio', 'toggleDisable']);
  expect(await menu(page).locator('.ctxm__tag').count()).toBe(18); // 14 later items + the 4 placeholder slots
  await expect(item(page, 'group').locator('.ctxm__tag')).toHaveCount(0);
  const MAC = await appIsMac(page);
  const key = (id: string) => item(page, id).locator('.ctxm__key').textContent();
  expect(await key('copy')).toBe(MAC ? '⌘C' : 'Ctrl+C');
  expect(await key('cut')).toBe(MAC ? '⌘X' : 'Ctrl+X');
  expect(await key('delete')).toBe(MAC ? '⌫' : 'Backspace');
  expect(await key('extractAudio')).toBe(MAC ? '⇧⌃S' : 'Ctrl+Shift+S');
  expect(await key('compound')).toBe(MAC ? '⌥G' : 'Alt+G');
  expect(await key('toggleDisable')).toBe('V');
  await expect(item(page, 'removeBackground').locator('.ctxm__chev')).toHaveText('›');

  // the menu stays inside the viewport (the timeline sits at the bottom of the window)
  const box = (await menu(page).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);

  // Esc closes the menu and does not also deselect
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  expect((await model(page)).selection).toEqual([a]);

  // Copy
  await openOn(page, 0);
  await item(page, 'copy').click();
  await expect(menu(page)).toHaveCount(0);
  expect((await model(page)).clipboard).toEqual([a]);

  // Cut → gone + on the clipboard; undo
  await openOn(page, 1);
  await item(page, 'cut').click();
  let m = await model(page);
  expect(m.clips.map((c) => c.id)).toEqual([a]);
  expect(m.clipboard).toEqual([b]);
  await page.evaluate(() => (window as any).__oe.getState().undo());

  // Delete; undo
  await openOn(page, 1);
  expect((await model(page)).selection).toEqual([b]);
  await item(page, 'delete').click();
  expect((await model(page)).clips.map((c) => c.id)).toEqual([a]);
  await page.evaluate(() => (window as any).__oe.getState().undo());
  expect((await model(page)).clips).toHaveLength(2);

  // Extract audio → an audio clip + muted video; the menu then offers Restore audio
  await openOn(page, 0);
  await expect(item(page, 'extractAudio').locator('.ctxm__label')).toHaveText('Extract audio');
  await item(page, 'extractAudio').click();
  m = await model(page);
  expect(m.clips.filter((c) => c.type === 'audio')).toHaveLength(1);
  expect(m.clips.find((c) => c.id === a)!.muted).toBe(true);
  await openOn(page, 0);
  await expect(item(page, 'extractAudio').locator('.ctxm__label')).toHaveText('Restore audio');
  await item(page, 'extractAudio').click();
  m = await model(page);
  expect(m.clips.filter((c) => c.type === 'audio')).toHaveLength(0);
  expect(m.clips.find((c) => c.id === a)!.muted).toBe(false);

  // ⇧⌃S (Shift+Control+S) extracts too, and again restores
  await page.keyboard.press('Control+Shift+KeyS');
  expect((await model(page)).clips.filter((c) => c.type === 'audio')).toHaveLength(1);
  await page.keyboard.press('Control+Shift+KeyS');
  expect((await model(page)).clips.filter((c) => c.type === 'audio')).toHaveLength(0);

  // right-click inside a multi-selection keeps it; Deactivate acts on all of it
  await page.evaluate((ids) => (window as any).__oe.getState().select(ids), [a, b]);
  await openOn(page, 1);
  expect((await model(page)).selection).toEqual([a, b]);
  await item(page, 'toggleDisable').click();
  expect((await model(page)).clips.map((c) => c.disabled)).toEqual([true, true]);
  await openOn(page, 0);
  await expect(item(page, 'toggleDisable').locator('.ctxm__label')).toHaveText('Activate clip');
  await item(page, 'toggleDisable').click();
  expect((await model(page)).clips.map((c) => c.disabled)).toEqual([false, false]);

  expect(errors.real()).toEqual([]);
});

test('hover submenus, keyboard navigation, outside press and scroll', async ({ page }) => {
  await setup(page);
  const [a] = (await model(page)).clips.map((c) => c.id);
  // a module plugs into a slot the way the contract says
  await page.evaluate(() => {
    (window as any).__picked = [];
    (window as any).__oeMenu.registerSlot('attributes', {
      id: 'attributes',
      label: 'Copy/paste attributes',
      submenu: () => [
        { id: 'copyAttrs', label: 'Copy attributes', run: () => (window as any).__picked.push('copy') },
        { id: 'pasteAttrs', label: 'Paste attributes', run: (ctx: any) => (window as any).__picked.push(`paste:${ctx.primaryId}`) },
      ],
    });
  });

  // hover opens the submenu beside its row; hovering a plain row closes it
  await openOn(page, 0);
  await item(page, 'attributes').hover();
  const sub = page.getByTestId('clip-context-submenu');
  await expect(sub).toBeVisible();
  await expect(sub.locator('.ctxm__label')).toHaveText(['Copy attributes', 'Paste attributes']);
  const mb = (await menu(page).boundingBox())!;
  const sb = (await sub.boundingBox())!;
  expect(Math.abs(sb.x - (mb.x + mb.width)) < 8 || Math.abs(sb.x + sb.width - mb.x) < 8).toBe(true);
  await sub.locator('[data-item-id="pasteAttrs"]').click();
  expect(await page.evaluate(() => (window as any).__picked)).toEqual([`paste:${a}`]);
  await expect(menu(page)).toHaveCount(0);

  await openOn(page, 0);
  await item(page, 'attributes').hover();
  await expect(sub).toBeVisible();
  await item(page, 'delete').hover();
  await expect(sub).toHaveCount(0);

  // keyboard: ↓ lands on Copy (EditPilot is disabled), ↓ ↓ = attributes, → opens it, ← closes, Esc closes all
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await openOn(page, 0);
  await page.mouse.move(5, 5);
  await page.keyboard.press('ArrowDown');
  await expect(item(page, 'copy')).toHaveClass(/is-active/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(item(page, 'attributes')).toHaveClass(/is-active/);
  await page.keyboard.press('ArrowRight');
  await expect(sub.locator('[data-item-id="copyAttrs"]')).toHaveClass(/is-active/);
  await page.keyboard.press('ArrowLeft');
  await expect(sub).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).__picked)).toEqual([`paste:${a}`, 'copy']);
  await expect(menu(page)).toHaveCount(0);

  // the playhead did not move from the arrows while the menu had them
  expect(await page.evaluate(() => (window as any).__oe.getState().playhead)).toBe(0);

  // Esc from a submenu goes back, Esc again closes
  await openOn(page, 0);
  await item(page, 'attributes').hover();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(sub).toHaveCount(0);
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);

  // Enter on Delete deletes through the keyboard
  await openOn(page, 0);
  await page.mouse.move(5, 5);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(item(page, 'delete')).toHaveClass(/is-active/);
  await page.keyboard.press('Enter');
  expect((await model(page)).clips.map((c) => c.id)).not.toContain(a);
  await page.evaluate(() => (window as any).__oe.getState().undo());

  // an outside press closes it without doing anything else
  await openOn(page, 0);
  await page.mouse.click(5, 5);
  await expect(menu(page)).toHaveCount(0);

  // a scroll of the timeline closes it
  await openOn(page, 0);
  const tb = (await page.locator('.tl-scroller').boundingBox())!;
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height - 10);
  await page.mouse.wheel(0, 120);
  await expect(menu(page)).toHaveCount(0);

  // ⌃-click on a Mac opens it as well
  if (await appIsMac(page)) {
    await page.evaluate(() => (window as any).__oe.getState().clearSelection());
    await clip(page, 1).click({ modifiers: ['Control'], position: { x: 30, y: 20 } });
    await expect(menu(page)).toBeVisible();
    expect((await model(page)).selection).toHaveLength(1);
    await page.keyboard.press('Escape');
  }
});
