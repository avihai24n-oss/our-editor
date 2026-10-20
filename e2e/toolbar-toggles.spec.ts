/**
 * The four toggles on the right of the timeline toolbar (CapCut screenshots 10–14):
 * Main track magnet (P), Auto snapping (N), Linkage (~), Preview axis (S).
 * Checks the CapCut tooltips, the ON/OFF tile styling, the keys, the ▾ menus, persistence, and
 * that each toggle really changes behaviour. State checks read the dev handles `window.__oe` /
 * `window.__oeUi`.
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { collectConsoleErrors, importMedia, MEDIA, openApp, SCREENS_DIR } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const S = (sec: number) => Math.round(sec * 1_000_000);
const CYAN = 'rgb(34, 211, 238)';

const ev = <R, A = undefined>(page: Page, fn: (a: A) => R, arg?: A) => page.evaluate(fn as any, arg) as Promise<Awaited<R>>;
const ed = (page: Page, k: string) => ev(page, (f: string) => (window as any).__oe.getState()[f], k);
const ui = (page: Page, k: string) => ev(page, (f: string) => (window as any).__oeUi.getState()[f], k);
const clips = (page: Page) =>
  ev(page, () =>
    (window as any).__oe.getState().project.tracks.flatMap((t: any) =>
      t.clips.map((c: any) => ({ id: c.id, type: c.type, trackKind: t.kind, start: c.start, duration: c.duration, audioLink: c.audioLink })),
    ),
  ) as Promise<{ id: string; type: string; trackKind: string; start: number; duration: number; audioLink?: string }[]>;
const clip = async (page: Page, id: string) => (await clips(page)).find((c) => c.id === id)!;

async function key(page: Page, code: string) {
  await ev(page, () => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press(code);
}
async function parkMouse(page: Page) {
  const b = await page.getByTestId('left-panel').boundingBox();
  await page.mouse.move(b!.x + 20, b!.y + 20);
}

async function boot(page: Page) {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe && !!(window as any).__oeUi);
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.image]);
  await ev(page, () => {
    const s = (window as any).__oe.getState();
    s.setZoom(100);
    s.setMagnet(true);
    s.setSnapping(true);
    (window as any).__oeUi.getState().setLinkage(true);
    (window as any).__oeUi.getState().setPreviewAxis(true);
  });
  return ev(page, () => {
    const out: Record<string, string> = {};
    for (const a of Object.values((window as any).__oe.getState().project.assets) as any[]) out[a.name] = a.id;
    return out;
  });
}
const add = (page: Page, assetId: string, opts: Record<string, unknown> = {}) =>
  ev(page, ([id, o]: readonly [string, Record<string, unknown>]) => (window as any).__oe.getState().addClip(id, o) as string, [assetId, opts] as const);

async function geo(page: Page) {
  await ev(page, () => ((document.querySelector('.tl-scroller') as HTMLElement).scrollLeft = 0));
  await page.waitForTimeout(50);
  const lane = await page.locator('[data-track-role="main"] .tl-lane').boundingBox();
  const zoom = (await ed(page, 'zoom')) as number;
  return {
    x: (us: number) => lane!.x + (us / 1e6) * zoom,
    rowY: async (kind: string) => {
      const id = await ev(page, (k: string) => (window as any).__oe.getState().project.tracks.find((t: any) => t.kind === k).id, kind);
      const b = await page.locator(`[data-track-id="${id}"]`).boundingBox();
      return b!.y + b!.height / 2;
    },
  };
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(to.x - from.x) * 6, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/** The toggle's visible state: tooltip, aria, glyph colour and tile background. */
async function look(page: Page, tid: string) {
  const b = page.getByTestId(tid);
  return {
    title: await b.getAttribute('title'),
    pressed: await b.getAttribute('aria-pressed'),
    color: await b.locator('svg').evaluate((el) => getComputedStyle(el).color),
    bg: await b.evaluate((el) => getComputedStyle(el).backgroundColor),
  };
}
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

const TOGGLES = [
  { tid: 'timeline-magnet', name: 'main track magnet', key: 'P', code: 'KeyP', read: (p: Page) => ed(p, 'magnet') },
  { tid: 'timeline-snapping', name: 'auto snapping', key: 'N', code: 'KeyN', read: (p: Page) => ed(p, 'snapping') },
  { tid: 'timeline-linkage', name: 'linkage', key: '~', code: 'Backquote', read: (p: Page) => ui(p, 'linkage') },
  { tid: 'timeline-preview-axis', name: 'preview axis', key: 'S', code: 'KeyS', read: (p: Page) => ui(p, 'previewAxis') },
] as const;

test.describe.configure({ mode: 'serial' });
test.use({ deviceScaleFactor: 2 }); // a sharp toolbar screenshot to compare with CapCut's retina capture

test('toggles: CapCut tooltips, ON/OFF tiles, keys, ▾ menus, persistence, screenshot', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await boot(page);
  await parkMouse(page);

  for (const t of TOGGLES) {
    // ON: cyan glyph on a lighter tile, tooltip offers to turn it off
    expect(await t.read(page)).toBe(true);
    let l = await look(page, t.tid);
    expect(l).toMatchObject({ title: `Turn off ${t.name}(${t.key})`, pressed: 'true', color: CYAN });
    expect(l.bg).not.toBe(TRANSPARENT);
    // key → OFF: light glyph, no tile
    await key(page, t.code);
    expect(await t.read(page)).toBe(false);
    l = await look(page, t.tid);
    expect(l).toMatchObject({ title: `Turn on ${t.name}(${t.key})`, pressed: 'false', bg: TRANSPARENT });
    expect(l.color).not.toBe(CYAN);
    // click → ON again
    await page.getByTestId(t.tid).click();
    expect(await t.read(page)).toBe(true);
    await expect(page.getByTestId(t.tid)).toHaveAttribute('aria-pressed', 'true');
  }

  // the ▾ menus (linkage, preview axis) repeat the toggle with a checkmark; magnet/snapping have none
  await expect(page.getByTestId('timeline-magnet-menu')).toHaveCount(0);
  await expect(page.getByTestId('timeline-snapping-menu')).toHaveCount(0);
  for (const t of [TOGGLES[2], TOGGLES[3]]) {
    await page.getByTestId(`${t.tid}-menu`).click();
    const item = page.getByTestId(`${t.tid}-group`).getByRole('menuitemcheckbox');
    await expect(item).toHaveAttribute('aria-checked', 'true');
    await expect(item).toContainText(t.key);
    await item.click();
    expect(await t.read(page)).toBe(false);
    await expect(item).toHaveCount(0); // closed
    await page.getByTestId(`${t.tid}-menu`).click();
    await expect(item).toHaveAttribute('aria-checked', 'false');
    await item.click();
    expect(await t.read(page)).toBe(true);
  }

  // screenshot in CapCut's screenshot-10 state: snapping OFF, the other three ON
  await key(page, 'KeyN');
  await parkMouse(page);
  const group = page.getByTestId('timeline-magnet-group').locator('..');
  const box = (await group.boundingBox())!;
  const mic = (await page.getByTestId('timeline-magnet-group').boundingBox())!;
  await page.screenshot({
    path: path.join(SCREENS_DIR, 'toolbar-toggles.png'),
    clip: { x: mic.x - 12, y: box.y - 6, width: 300, height: box.height + 12 },
  });
  await key(page, 'KeyN');

  // linkage + preview axis persist across a reload (localStorage), as before
  await key(page, 'Backquote');
  await key(page, 'KeyS');
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oeUi);
  expect(await ui(page, 'linkage')).toBe(false);
  expect(await ui(page, 'previewAxis')).toBe(false);
  expect(await ed(page, 'linkage')).toBe(false); // the store's edits read the same flag
  await expect(page.getByTestId('timeline-linkage')).toHaveAttribute('title', 'Turn on linkage(~)');
  await expect(page.getByTestId('timeline-preview-axis')).toHaveAttribute('title', 'Turn on preview axis(S)');
  await key(page, 'Backquote');
  await key(page, 'KeyS');
  expect(errors.real()).toEqual([]);
});

test('magnet (P): off leaves gaps on the main track, on packs it', async ({ page }) => {
  const A = await boot(page);
  const v = await add(page, A[MEDIA.vertical]!, { at: 0 });
  const l = await add(page, A[MEDIA.landscape]!, { at: S(5) });
  expect(await clip(page, l)).toMatchObject({ start: S(5) });

  await key(page, 'KeyP'); // off
  expect(await ed(page, 'magnet')).toBe(false);
  await ev(page, (id: string) => {
    const s = (window as any).__oe.getState();
    s.select([id]);
    s.deleteSelected();
  }, v);
  expect(await clip(page, l)).toMatchObject({ start: S(5) }); // the gap stays

  await key(page, 'KeyP'); // on → packs
  expect(await ed(page, 'magnet')).toBe(true);
  await expect(page.getByTestId('timeline-magnet')).toHaveAttribute('aria-pressed', 'true');
  expect(await clip(page, l)).toMatchObject({ start: 0 });
  const main = (await clips(page)).filter((c) => c.trackKind === 'main');
  expect(main.map((c) => c.start)).toEqual([0]);
  // and a delete on the packed track ripples
  const l2 = await add(page, A[MEDIA.vertical]!, { at: S(4) });
  expect(await clip(page, l2)).toMatchObject({ start: S(4) });
  await ev(page, (id: string) => {
    const s = (window as any).__oe.getState();
    s.select([id]);
    s.deleteSelected();
  }, l);
  expect(await clip(page, l2)).toMatchObject({ start: 0 });
});

test('snapping (N): drag and trim snap to the playhead / clip edges only when on', async ({ page }) => {
  const A = await boot(page);
  await add(page, A[MEDIA.vertical]!, { at: 0 });
  const o = await add(page, A[MEDIA.image]!, { at: S(1), kind: 'overlay' });
  await ev(page, (id: string) => (window as any).__oe.getState().trimEnd(id, 3_000_000), o); // overlay 1..3 s
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await ev(page, () => (window as any).__oe.getState().setPlayhead(4_200_000));
  await page.waitForTimeout(300);
  const g = await geo(page);
  const yOv = await g.rowY('overlay');
  const undo = () => ev(page, () => (window as any).__oe.getState().undo());

  // ON: drop the overlay start 5 px past the playhead (4.2 s) → snaps to 4.2 s
  await drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)) + (S(4.2) - S(1)) / 1e4 + 5, y: yOv });
  expect((await clip(page, o)).start).toBe(S(4.2));
  await undo();
  // ON: 6 px past the main clip's end (5 s) → snaps to 5 s
  await drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)) + (S(5) - S(1)) / 1e4 + 6, y: yOv });
  expect((await clip(page, o)).start).toBe(S(5));
  await undo();
  // ON: trim the right edge to 1 px from the playhead → snaps
  await ev(page, () => (window as any).__oe.getState().setPlayhead(2_200_000));
  await drag(page, { x: g.x(S(3)) - 3, y: yOv }, { x: g.x(S(2.2)) + 1, y: yOv });
  expect(await clip(page, o)).toMatchObject({ start: S(1), duration: S(1.2) });
  await undo();
  await ev(page, () => (window as any).__oe.getState().clearSelection());

  // OFF (N): the same gestures land on the raw pointer position
  await key(page, 'KeyN');
  expect(await ed(page, 'snapping')).toBe(false);
  await expect(page.getByTestId('timeline-snapping')).toHaveAttribute('title', 'Turn on auto snapping(N)');
  await ev(page, () => (window as any).__oe.getState().setPlayhead(4_200_000));
  await drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)) + (S(4.2) - S(1)) / 1e4 + 5, y: yOv });
  expect(Math.abs((await clip(page, o)).start - S(4.25))).toBeLessThanOrEqual(S(0.02));
  await undo();
  await drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)) + (S(5) - S(1)) / 1e4 + 6, y: yOv });
  expect(Math.abs((await clip(page, o)).start - S(5.06))).toBeLessThanOrEqual(S(0.02));
  await undo();
  await ev(page, () => (window as any).__oe.getState().setPlayhead(2_200_000));
  await drag(page, { x: g.x(S(3)) - 3, y: yOv }, { x: g.x(S(2.2)) + 4, y: yOv });
  const trimmed = await clip(page, o);
  expect(trimmed.duration).not.toBe(S(1.2));
  expect(Math.abs(trimmed.duration - S(1.24))).toBeLessThanOrEqual(S(0.03));
  await undo();
  await key(page, 'KeyN');
  expect(await ed(page, 'snapping')).toBe(true);
});

test('linkage (~): extracted audio follows its video only when on', async ({ page }) => {
  const A = await boot(page);
  await add(page, A[MEDIA.vertical]!, { at: 0 });
  const l = await add(page, A[MEDIA.landscape]!, { at: S(5) });
  await ev(page, (id: string) => (window as any).__oe.getState().toggleExtractAudio([id]), l);
  await page.waitForTimeout(300);
  const ext = (await clips(page)).find((c) => c.type === 'audio' && c.audioLink)!;
  expect(ext.start).toBe(S(5));
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  const g = await geo(page);
  const yMain = await g.rowY('main');

  // ON: drag the video to the front → its audio comes along
  await drag(page, { x: g.x(S(7)), y: yMain }, { x: g.x(S(0.3)), y: yMain });
  expect(await clip(page, l)).toMatchObject({ start: 0 });
  expect(await clip(page, ext.id)).toMatchObject({ start: 0 });
  await ev(page, () => (window as any).__oe.getState().undo());
  expect(await clip(page, ext.id)).toMatchObject({ start: S(5) });

  // OFF: the video moves alone
  await key(page, 'Backquote');
  expect(await ui(page, 'linkage')).toBe(false);
  expect(await ed(page, 'linkage')).toBe(false);
  await expect(page.getByTestId('timeline-linkage')).toHaveAttribute('aria-pressed', 'false');
  await drag(page, { x: g.x(S(7)), y: yMain }, { x: g.x(S(0.3)), y: yMain });
  expect(await clip(page, l)).toMatchObject({ start: 0 });
  expect(await clip(page, ext.id)).toMatchObject({ start: S(5) });
  await key(page, 'Backquote');
  expect(await ed(page, 'linkage')).toBe(true);
});

test('preview axis (S): amber hover line + hovered-frame preview only when on', async ({ page }) => {
  const A = await boot(page);
  await add(page, A[MEDIA.vertical]!, { at: 0 });
  await page.waitForTimeout(300);
  const g = await geo(page);
  const yMain = await g.rowY('main');

  await page.mouse.move(g.x(S(3)), yMain);
  const hover = page.getByTestId('timeline-hover');
  await expect(hover).toBeVisible();
  const hc = await hover.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.backgroundColor, cs.borderLeftColor, cs.color].join(' ');
  });
  expect(hc).toMatch(/rgb\((2[0-9]{2}), (1[0-9]{2}), ([0-9]{1,2})\)/); // amber-ish
  await expect.poll(() => ed(page, 'previewTime')).not.toBeNull();
  expect(Math.abs(((await ed(page, 'previewTime')) as number) - S(3))).toBeLessThan(S(0.05));
  expect(await ed(page, 'playhead')).toBe(0); // the playhead does not move

  await key(page, 'KeyS'); // off
  expect(await ui(page, 'previewAxis')).toBe(false);
  await expect(page.getByTestId('timeline-preview-axis')).toHaveAttribute('title', 'Turn on preview axis(S)');
  await page.mouse.move(g.x(S(3.5)), yMain);
  await expect(hover).toHaveCount(0);
  expect(await ed(page, 'previewTime')).toBeNull();

  await key(page, 'KeyS'); // on
  await page.mouse.move(g.x(S(2)), yMain);
  await expect(hover).toBeVisible();
  await expect.poll(() => ed(page, 'previewTime')).not.toBeNull();
  await parkMouse(page);
});
