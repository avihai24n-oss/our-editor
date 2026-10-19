/**
 * CapCut's timeline tool modes in real Chromium (docs/research/07-tool-modes.md): Select (A),
 * Split (B), Select leftward ([) and Select rightward (]) — keys, toolbar dropdown, cursors, the
 * blade line, splitting by click, Esc / A back to Select, and that Select drags clips again.
 * State checks read the dev-only store handle `window.__oe`.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectConsoleErrors, importMedia, MEDIA, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';
const S = (sec: number) => Math.round(sec * 1_000_000);
const ZOOM = 100; // px per second

interface ClipInfo {
  id: string;
  name: string;
  trackKind: string;
  start: number;
  duration: number;
}

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__oe.getState();
    return {
      playhead: s.playhead as number,
      selection: s.selection.clipIds as string[],
      past: s.past.length as number,
      clips: s.project.tracks.flatMap((t: any) =>
        t.clips.map((c: any) => ({ id: c.id, name: c.name, trackKind: t.kind, start: c.start, duration: c.duration })),
      ) as ClipInfo[],
    };
  });

const tool = (page: Page) => page.locator('.tl').getAttribute('data-tool');
const clipEl = (page: Page, id: string): Locator => page.locator(`[data-clip-id="${id}"].tl-clip`);
const cursorOf = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).cursor);

/** Client point over clip `c` at timeline time `t` (vertically centred). */
async function pointAt(page: Page, c: ClipInfo, t: number) {
  const box = (await clipEl(page, c.id).boundingBox())!;
  return { x: box.x + ((t - c.start) / 1e6) * ZOOM, y: box.y + box.height / 2 };
}

/** Imports the test media and builds: main [vertical 5 s][landscape 4 s], audio [tone 6 s]. */
async function setup(page: Page) {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe);
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.tone]);
  await page.evaluate(
    ({ names, zoom }) => {
      const s = (window as any).__oe.getState();
      const id = (n: string) => (Object.values(s.project.assets) as any[]).find((a) => a.name === n).id;
      s.addClip(id(names.vertical), { at: 0 });
      s.addClip(id(names.landscape), { at: 5_000_000 });
      s.addClip(id(names.tone), { at: 0 });
      s.clearSelection();
      s.setPlayhead(0);
      s.setZoom(zoom);
    },
    { names: MEDIA, zoom: ZOOM },
  );
  await page.locator('.tl-scroller').evaluate((el) => (el.scrollLeft = 0));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await expect(page.locator('.tl-clip')).toHaveCount(3);
}

test.describe.configure({ mode: 'serial' });

test('Split tool (B): blade cursor, cut line, click splits; A / Esc back to Select', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await setup(page);
  let s = await state(page);
  const vertical = s.clips.find((c) => c.name === MEDIA.vertical)!;
  const landscape = s.clips.find((c) => c.name === MEDIA.landscape)!;
  const menu = page.getByTestId('timeline-tool-menu');

  expect(await tool(page)).toBe('select');
  expect(await cursorOf(clipEl(page, vertical.id))).toBe('grab');

  // ---- B: split tool, toolbar icon follows, blade cursor over clips and lanes
  await page.keyboard.press('KeyB');
  expect(await tool(page)).toBe('split');
  await expect(menu).toHaveAttribute('data-tool', 'split');
  await expect(menu).toHaveAttribute('title', /^Split \(B\)$/);
  const bladeCursor = await cursorOf(clipEl(page, vertical.id));
  expect(bladeCursor).toContain('url("data:image/svg+xml');
  expect(bladeCursor).toMatch(/16 18, crosshair$/);
  expect(await cursorOf(page.locator('.tl-lane').first())).toContain('url("data:image/svg+xml');
  // no trim handles in split mode
  await expect(clipEl(page, vertical.id).locator('.tl-clip__handle').first()).toBeHidden();

  // ---- the cut line follows the mouse over the hovered clip, with a timecode tip
  const blade = page.getByTestId('timeline-blade');
  await expect(blade).toHaveCount(0);
  let p = await pointAt(page, vertical, S(1.5));
  await page.mouse.move(p.x, p.y);
  await expect(blade).toBeVisible();
  await expect(blade).toHaveAttribute('data-clip-id', vertical.id);
  const t1 = Number(await blade.getAttribute('data-time'));
  expect(Math.abs(t1 - S(1.5))).toBeLessThan(S(0.05));
  await expect(blade.locator('.tl-blade__tip')).toHaveText(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
  // the line spans the hovered clip only, not the whole timeline
  const bb = (await blade.boundingBox())!;
  const cb = (await clipEl(page, vertical.id).boundingBox())!;
  expect(bb.y).toBeGreaterThanOrEqual(cb.y - 1);
  expect(bb.y + bb.height).toBeLessThanOrEqual(cb.y + cb.height + 1);
  // it moves with the mouse
  p = await pointAt(page, vertical, S(3));
  await page.mouse.move(p.x, p.y);
  await expect.poll(async () => Number(await blade.getAttribute('data-time'))).toBeGreaterThan(t1 + S(1));
  await screenshot(page, 'tool-modes-01-split-line');

  // ---- it snaps onto the playhead
  await page.evaluate((t) => (window as any).__oe.getState().setPlayhead(t), S(2));
  p = await pointAt(page, vertical, S(2) + S(0.03)); // 3 px away
  await page.mouse.move(p.x, p.y);
  await expect(blade).toHaveAttribute('data-time', String(S(2)));

  // ---- click splits that clip there, one undo step; the other tracks are untouched
  const past = (await state(page)).past;
  await page.mouse.click(p.x, p.y);
  s = await state(page);
  expect(s.clips).toHaveLength(4);
  expect(s.past).toBe(past + 1);
  const mains = s.clips.filter((c) => c.trackKind === 'main').sort((a, b) => a.start - b.start);
  expect(mains.map((c) => c.start)).toEqual([0, S(2), S(5)]);
  expect(s.clips.filter((c) => c.trackKind === 'audio')).toHaveLength(1);
  // still in split mode: a second click cuts again
  p = await pointAt(page, landscape, S(7));
  await page.mouse.click(p.x, p.y);
  expect((await state(page)).clips).toHaveLength(5);
  await page.keyboard.press(`${MOD}+KeyZ`);
  expect((await state(page)).clips).toHaveLength(4);

  // ---- clips cannot be dragged in split mode (the press cuts, the drag moves nothing)
  const before = (await state(page)).clips.map((c) => c.start).sort();
  p = await pointAt(page, landscape, S(6));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 120, p.y, { steps: 6 });
  await page.mouse.up();
  s = await state(page);
  expect(s.clips).toHaveLength(5); // the press split it
  expect(s.clips.map((c) => c.start).filter((x) => !before.includes(x))).toEqual([S(6)]); // nothing moved
  await page.keyboard.press(`${MOD}+KeyZ`);
  expect((await state(page)).clips).toHaveLength(4);

  // ---- the ruler can still be scrubbed in split mode
  const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
  const vb = (await clipEl(page, vertical.id).boundingBox())!;
  await page.mouse.click(vb.x + 4 * ZOOM, ruler.y + ruler.height / 2);
  expect(Math.abs((await state(page)).playhead - S(4))).toBeLessThan(S(0.05));
  expect(await tool(page)).toBe('split');

  // ---- A: back to Select — arrow cursor, no blade line, drag moves clips again
  await page.keyboard.press('KeyA');
  expect(await tool(page)).toBe('select');
  await expect(menu).toHaveAttribute('data-tool', 'select');
  await expect(blade).toHaveCount(0);
  expect(await cursorOf(clipEl(page, vertical.id))).toBe('grab');
  s = await state(page);
  const tone = s.clips.find((c) => c.trackKind === 'audio')!;
  p = await pointAt(page, tone, S(3));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 100, p.y, { steps: 8 });
  await page.mouse.up();
  s = await state(page);
  expect(s.clips).toHaveLength(4);
  expect(s.clips.find((c) => c.id === tone.id)!.start).toBeGreaterThan(S(0.5));

  // ---- Esc also returns to Select; ⌘B / ⇧B never switch the tool
  await page.keyboard.press('KeyB');
  expect(await tool(page)).toBe('split');
  await page.keyboard.press('Escape');
  expect(await tool(page)).toBe('select');
  await page.keyboard.press(`${MOD}+KeyB`);
  expect(await tool(page)).toBe('select');

  // ---- the keys work from any focused control except text fields
  await page.getByTestId('timeline-zoom').focus();
  await page.keyboard.press('KeyB');
  expect(await tool(page)).toBe('split');
  await page.keyboard.press('KeyA');
  expect(await tool(page)).toBe('select');
  await page.getByLabel('Project name').click();
  await page.keyboard.press('KeyB');
  expect(await tool(page)).toBe('select');
  await page.getByLabel('Project name').press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());

  expect(errors.real()).toEqual([]);
});

test('tool dropdown, Select leftward ([) and Select rightward (])', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await setup(page);
  let s = await state(page);
  const vertical = s.clips.find((c) => c.name === MEDIA.vertical)!;
  const landscape = s.clips.find((c) => c.name === MEDIA.landscape)!;
  const tone = s.clips.find((c) => c.trackKind === 'audio')!;
  const menu = page.getByTestId('timeline-tool-menu');

  // ---- the dropdown lists every tool with its key
  await menu.click();
  const list = page.getByTestId('timeline-tool-list');
  await expect(list.getByRole('menuitemradio')).toHaveText([/Select\s*A$/, /Split\s*B$/, /Select leftward\s*\[$/, /Select rightward\s*\]$/]);
  await expect(list.locator('[data-tool="select"]')).toHaveAttribute('aria-checked', 'true');
  await screenshot(page, 'tool-modes-02-dropdown');

  // ---- choose Select rightward from the menu
  await list.locator('[data-tool="selectRight"]').click();
  await expect(list).toHaveCount(0);
  expect(await tool(page)).toBe('selectRight');
  await expect(menu).toHaveAttribute('data-tool', 'selectRight');
  const rightCursor = await cursorOf(clipEl(page, vertical.id));
  expect(rightCursor).toContain('url("data:image/svg+xml');
  expect(rightCursor).toMatch(/, e-resize$/);
  await expect(clipEl(page, vertical.id).locator('.tl-clip__handle').first()).toBeHidden();

  // hovering shows the line and the clips a click would take (everything ending after it)
  let p = await pointAt(page, landscape, S(5.5));
  await page.mouse.move(p.x, p.y);
  const side = page.getByTestId('timeline-side-line');
  await expect(side).toBeVisible();
  await expect(side.locator('.tl-side__tip')).toHaveText(/→$/);
  await expect(clipEl(page, landscape.id)).toHaveClass(/is-tool-target/);
  await expect(clipEl(page, tone.id)).toHaveClass(/is-tool-target/);
  await expect(clipEl(page, vertical.id)).not.toHaveClass(/is-tool-target/);
  await screenshot(page, 'tool-modes-03-select-rightward');

  // a click selects every clip right of the click, on every track
  await page.mouse.click(p.x, p.y);
  s = await state(page);
  expect(s.selection.sort()).toEqual([landscape.id, tone.id].sort());
  expect(await tool(page)).toBe('selectRight'); // stays armed, like CapCut's split tool

  // ---- [ : Select leftward — selects left of the playhead now and arms the tool
  await page.evaluate((t) => (window as any).__oe.getState().setPlayhead(t), S(5.5));
  await page.keyboard.press('BracketLeft');
  expect(await tool(page)).toBe('selectLeft');
  s = await state(page);
  expect(s.selection.sort()).toEqual([vertical.id, landscape.id, tone.id].sort());
  expect(await cursorOf(clipEl(page, vertical.id))).toMatch(/, w-resize$/);
  // a click on a clip at 2 s takes what starts before 2 s, and a drag moves them together
  p = await pointAt(page, vertical, S(2));
  await page.mouse.move(p.x, p.y);
  await expect(page.getByTestId('timeline-side-line').locator('.tl-side__tip')).toHaveText(/^←/);
  await page.mouse.click(p.x, p.y);
  s = await state(page);
  expect(s.selection.sort()).toEqual([vertical.id, tone.id].sort());

  // a click on empty lane space selects too
  const lane = (await page.locator('.tl-row--audio .tl-lane').first().boundingBox())!;
  const tb = (await clipEl(page, tone.id).boundingBox())!;
  await page.mouse.click(tb.x + 8 * ZOOM, lane.y + lane.height / 2);
  s = await state(page);
  expect(s.selection.sort()).toEqual([vertical.id, landscape.id, tone.id].sort());

  // ---- ] then Esc / A return to Select; the side line goes away
  await page.keyboard.press('BracketRight');
  expect(await tool(page)).toBe('selectRight');
  await page.keyboard.press('Escape');
  expect(await tool(page)).toBe('select');
  await expect(page.getByTestId('timeline-side-line')).toHaveCount(0);
  await expect(page.locator('.is-tool-target')).toHaveCount(0);
  await page.keyboard.press('BracketLeft');
  await page.keyboard.press('KeyA');
  expect(await tool(page)).toBe('select');
  expect(await cursorOf(clipEl(page, vertical.id))).toBe('grab');

  // ---- the menu also switches back to Split / Select
  await menu.click();
  await list.locator('[data-tool="split"]').click();
  expect(await tool(page)).toBe('split');
  await menu.click();
  await list.locator('[data-tool="select"]').click();
  expect(await tool(page)).toBe('select');

  expect(errors.real()).toEqual([]);
});
