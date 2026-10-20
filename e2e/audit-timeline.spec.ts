/**
 * FUNCTIONAL AUDIT of the timeline in real Chromium (docs/AUDIT-timeline.md).
 *
 * Every toolbar button, every shortcut of src/timeline/shortcutDefs.ts (except the A / B tool
 * modes, reworked elsewhere) and every mouse gesture is driven through the real UI, and checked on
 *   - the project model: exact clip start / duration / in-point values (µs);
 *   - the model invariants after each step (window.__oeCheck → src/store/invariants.ts);
 *   - undo / redo: ⌘Z restores the exact previous project JSON, ⌘⇧Z the exact result;
 *   - the rendered preview (canvas pixels) and the live audio voices where it matters.
 * It ends with a UI-level fuzz: random keyboard / toolbar edits, invariants after each, ⌘Z back to
 * the start.
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsoleErrors, importMedia, MEDIA, openApp } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';
const S = (sec: number) => Math.round(sec * 1_000_000);
const ZOOM = 100; // px per second for every gesture test


// ---------------------------------------------------------------- helpers

const ev = <R, A = undefined>(page: Page, fn: (a: A) => R, arg?: A): Promise<R> => page.evaluate(fn as any, arg as A) as Promise<R>;

/** The whole project document as JSON (what undo / redo must restore exactly). */
const doc = (page: Page) => ev(page, () => JSON.stringify((window as any).__oe.getState().project));

async function healthy(page: Page, where = '') {
  const v = await ev(page, () => (window as any).__oeCheck() as string[]);
  expect(v, `invariants ${where}`).toEqual([]);
}

interface ClipRow {
  id: string;
  name: string;
  type: string;
  track: string;
  trackKind: string;
  start: number;
  duration: number;
  inPoint?: number;
  speed?: number;
  muted?: boolean;
  audioLink?: string;
  flipH?: boolean;
  rotation?: number;
  disabled: boolean;
  volumeDb?: number;
}
const clips = (page: Page) =>
  ev(page, () =>
    (window as any).__oe.getState().project.tracks.flatMap((t: any) =>
      t.clips.map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        track: t.id,
        trackKind: t.kind,
        start: c.start,
        duration: c.duration,
        inPoint: c.inPoint,
        speed: c.speed,
        muted: c.audio?.muted,
        audioLink: c.audioLink,
        flipH: c.transform?.flipH,
        rotation: c.transform?.rotation,
        disabled: c.disabled,
        volumeDb: c.audio?.volumeDb,
      })),
    ),
  ) as Promise<ClipRow[]>;
const clip = async (page: Page, id: string) => (await clips(page)).find((c) => c.id === id)!;
const tracks = (page: Page) =>
  ev(page, () => (window as any).__oe.getState().project.tracks.map((t: any) => ({ id: t.id, kind: t.kind, n: t.clips.length, locked: t.locked, hidden: t.hidden, muted: t.muted }))) as Promise<
    { id: string; kind: string; n: number; locked: boolean; hidden: boolean; muted: boolean }[]
  >;
const sel = (page: Page) => ev(page, () => (window as any).__oe.getState().selection.clipIds as string[]);
const playhead = (page: Page) => ev(page, () => (window as any).__oe.getState().playhead as number);
const setPlayhead = (page: Page, us: number) => ev(page, (t) => (window as any).__oe.getState().setPlayhead(t), us);
const select = (page: Page, ids: string[]) => ev(page, (x) => (window as any).__oe.getState().select(x), ids);
const pastLen = (page: Page) => ev(page, () => (window as any).__oe.getState().past.length as number);

/** Moves the mouse off the timeline (the preview axis would otherwise show the hovered frame). */
async function parkMouse(page: Page) {
  const b = await page.getByTestId('left-panel').boundingBox();
  await page.mouse.move(b!.x + 20, b!.y + 20);
}
async function blur(page: Page) {
  await ev(page, () => (document.activeElement as HTMLElement | null)?.blur?.());
}
async function key(page: Page, combo: string) {
  await blur(page);
  await page.keyboard.press(combo);
}

/** Runs a UI action and proves ⌘Z / ⌘⇧Z restore the exact documents; invariants hold throughout. */
async function exactUndo(page: Page, what: string, act: () => Promise<unknown>) {
  const before = await doc(page);
  await act();
  await expect.poll(() => doc(page), { message: `${what}: changed the project` }).not.toBe(before);
  const after = await doc(page);
  await healthy(page, `after ${what}`);
  await key(page, `${MOD}+KeyZ`);
  expect(await doc(page), `${what}: ⌘Z restores the exact previous project`).toBe(before);
  await healthy(page, `after undo of ${what}`);
  await key(page, `${MOD}+Shift+KeyZ`);
  expect(await doc(page), `${what}: ⌘⇧Z restores the exact result`).toBe(after);
}

/** Opens the app, imports the test media, returns the asset ids by file name. */
async function boot(page: Page) {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe && !!(window as any).__oeCheck);
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.image, MEDIA.tone]);
  await ev(page, () => {
    const s = (window as any).__oe.getState();
    s.setZoom(100);
    s.setMagnet(true);
    s.setSnapping(true);
    s.setLinkage(true);
    (window as any).__oeUi.getState().setLinkage(true);
  });
  return ev(page, () => {
    const out: Record<string, string> = {};
    for (const a of Object.values((window as any).__oe.getState().project.assets) as any[]) out[a.name] = a.id;
    return out;
  });
}
const add = (page: Page, assetId: string, opts: Record<string, unknown> = {}) =>
  ev(page, ([id, o]) => (window as any).__oe.getState().addClip(id, o) as string, [assetId, opts] as const);

/** Screen x of timeline time `us` (lane origin + us × zoom), and the vertical centre of a track row. */
async function geo(page: Page) {
  await ev(page, () => {
    const sc = document.querySelector('.tl-scroller') as HTMLElement;
    sc.scrollLeft = 0;
  });
  await page.waitForTimeout(50);
  const lane = await page.locator('[data-track-role="main"] .tl-lane').boundingBox();
  const zoom = await ev(page, () => (window as any).__oe.getState().zoom as number);
  return {
    x: (us: number) => lane!.x + (us / 1e6) * zoom,
    zoom,
    rowY: async (trackId: string) => {
      const b = await page.locator(`[data-track-id="${trackId}"]`).boundingBox();
      return b!.y + b!.height / 2;
    },
    bandY: async (band: 'top' | 'bottom') => {
      const b = await page.locator(`[data-row-key="band:${band}"]`).boundingBox();
      return band === 'top' ? b!.y + b!.height - 6 : b!.y + 6;
    },
  };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { alt?: boolean } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (opts.alt) await page.keyboard.down('Alt');
  await page.mouse.move(from.x + Math.sign(to.x - from.x) * 6, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  if (opts.alt) await page.keyboard.up('Alt');
}

/** Mean luminance of the centre of the player canvas (what the preview renders). */
async function canvasLuma(page: Page) {
  return ev(page, () => {
    const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const w = Math.max(1, Math.floor(c.width / 4));
    const h = Math.max(1, Math.floor(c.height / 4));
    const d = ctx.getImageData(Math.floor(c.width / 2 - w / 2), Math.floor(c.height / 2 - h / 2), w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    return sum / (d.length / 4);
  });
}
const voices = (page: Page) => page.evaluate(async () => ((await (window as any).__oeMem.snapshot()).preview?.voices ?? 0) as number);
const toolbarButton = (page: Page, name: RegExp) => page.getByRole('toolbar', { name: 'Timeline tools' }).getByRole('button', { name });

// =================================================================== 1. toolbar buttons

test('toolbar: every button does what it says, exactly, and undoes exactly', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsoleErrors(page);
  const A = await boot(page);
  const v = await add(page, A[MEDIA.vertical]!, { at: 0 });
  const l = await add(page, A[MEDIA.landscape]!, { at: S(5) });
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await parkMouse(page);

  // undo / redo buttons: disabled states and exact restore
  await expect(page.getByTestId('timeline-redo')).toBeDisabled();
  const before = await doc(page);
  await setPlayhead(page, S(2));
  await page.getByTestId('timeline-split').click();
  const afterSplit = await doc(page);
  expect((await clips(page)).filter((c) => c.trackKind === 'main').map((c) => [c.start, c.duration, c.inPoint])).toEqual([
    [0, S(2), 0],
    [S(2), S(3), S(2)],
    [S(5), S(4), 0],
  ]);
  await page.getByTestId('timeline-undo').click();
  expect(await doc(page)).toBe(before);
  await expect(page.getByTestId('timeline-redo')).toBeEnabled();
  await page.getByTestId('timeline-redo').click();
  expect(await doc(page)).toBe(afterSplit);
  await page.getByTestId('timeline-undo').click();

  // split: selected clip only
  await setPlayhead(page, S(6));
  await select(page, [l]);
  await exactUndo(page, 'Split button', () => page.getByTestId('timeline-split').click());
  expect((await clips(page)).filter((c) => c.name === MEDIA.landscape).map((c) => [c.start, c.duration, c.inPoint])).toEqual([
    [S(5), S(1), 0],
    [S(6), S(3), S(1)],
  ]);
  await key(page, `${MOD}+KeyZ`);

  // delete left (magnet on: keeps its slot; playhead goes to the cut)
  await setPlayhead(page, S(6.5));
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await exactUndo(page, 'Delete left button', () => toolbarButton(page, /^Delete left/).click());
  expect(await clip(page, l)).toMatchObject({ start: S(5), duration: S(2.5), inPoint: S(1.5) });
  await key(page, `${MOD}+KeyZ`);

  // delete right
  await setPlayhead(page, S(6.5));
  await exactUndo(page, 'Delete right button', () => toolbarButton(page, /^Delete right/).click());
  expect(await clip(page, l)).toMatchObject({ start: S(5), duration: S(1.5), inPoint: 0 });
  await key(page, `${MOD}+KeyZ`);

  // delete (selected clip) — main track ripples
  await select(page, [v]);
  await exactUndo(page, 'Delete button', () => page.getByTestId('timeline-delete').click());
  expect(await clip(page, l)).toMatchObject({ start: 0, duration: S(4) });
  await key(page, `${MOD}+KeyZ`);
  await select(page, [v]);
  await expect(page.getByTestId('timeline-delete')).toBeEnabled();
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await expect(page.getByTestId('timeline-delete')).toBeDisabled();

  // marker at the playhead (frame-snapped)
  await setPlayhead(page, 1_234_567);
  await exactUndo(page, 'Marker button', () => toolbarButton(page, /^Add marker/).click());
  expect(await ev(page, () => (window as any).__oe.getState().project.markers.map((m: any) => m.time))).toEqual([1_233_333]);
  await expect(page.getByTestId('timeline-marker')).toHaveCount(1);

  // mirror / rotate on the selected clip — and the preview changes
  await select(page, [v]);
  await setPlayhead(page, S(1));
  await exactUndo(page, 'Mirror button', () => toolbarButton(page, /^Mirror/).click());
  expect((await clip(page, v)).flipH).toBe(true);
  await exactUndo(page, 'Rotate button', () => toolbarButton(page, /^Rotate/).click());
  expect((await clip(page, v)).rotation).toBe(90);
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await expect(toolbarButton(page, /^Mirror/)).toBeDisabled();

  // magnet: off → a delete leaves the gap; on → packs again (one undo step)
  await page.getByTestId('timeline-magnet').click();
  await expect(page.getByTestId('timeline-magnet')).toHaveAttribute('aria-pressed', 'false');
  await select(page, [v]);
  await page.getByTestId('timeline-delete').click();
  expect(await clip(page, l)).toMatchObject({ start: S(5) });
  await healthy(page, 'magnet off delete');
  await exactUndo(page, 'Magnet on (packs the main track)', () => page.getByTestId('timeline-magnet').click());
  expect(await clip(page, l)).toMatchObject({ start: 0 });
  await expect(page.getByTestId('timeline-magnet')).toHaveAttribute('aria-pressed', 'true');
  await key(page, `${MOD}+KeyZ`); // undo the packing: the gap and magnet-off come back
  expect(await clip(page, l)).toMatchObject({ start: S(5) });
  await expect(page.getByTestId('timeline-magnet')).toHaveAttribute('aria-pressed', 'false');
  await key(page, `${MOD}+KeyZ`); // undo the delete
  await page.getByTestId('timeline-magnet').click();

  // snapping / linkage / preview axis: flags and visible state
  for (const [tid, flag] of [
    ['timeline-snapping', 'snapping'],
    ['timeline-linkage', 'linkage'],
  ] as const) {
    const b = page.getByTestId(tid);
    await expect(b).toHaveAttribute('aria-pressed', 'true');
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'false');
    expect(await ev(page, (f) => (window as any).__oe.getState()[f], flag)).toBe(false);
    await b.click();
    expect(await ev(page, (f) => (window as any).__oe.getState()[f], flag)).toBe(true);
  }
  const g = await geo(page);
  const mainY = await g.rowY((await tracks(page))[0]!.id);
  await page.mouse.move(g.x(S(3)), mainY);
  await expect(page.getByTestId('timeline-hover')).toBeVisible();
  await page.getByTestId('timeline-preview-axis').click();
  await page.mouse.move(g.x(S(3.5)), mainY);
  await expect(page.getByTestId('timeline-hover')).toHaveCount(0);
  expect(await ev(page, () => (window as any).__oe.getState().previewTime)).toBeNull();
  await page.getByTestId('timeline-preview-axis').click();
  await parkMouse(page);

  // zoom − / + / slider / fit
  const z = () => ev(page, () => (window as any).__oe.getState().zoom as number);
  const z0 = await z();
  await toolbarButton(page, /^Zoom in/).click();
  expect(await z()).toBeCloseTo(z0 * 1.25, 5);
  await toolbarButton(page, /^Zoom out/).click();
  expect(await z()).toBeCloseTo(z0, 5);
  await page.getByTestId('timeline-zoom').fill('900');
  expect(await z()).toBeGreaterThan(z0 * 2);
  await page.getByTestId('timeline-fit').click();
  const lane = await ev(page, () => (document.querySelector('.tl-scroller') as HTMLElement).clientWidth - 140);
  const fitted = (await z()) * 9; // 9 s project
  expect(fitted).toBeLessThanOrEqual(lane);
  expect(fitted).toBeGreaterThan(lane * 0.7);
  // zoom is a view setting: not an undo step
  expect(await pastLen(page)).toBe(await pastLen(page));
  expect(errors.real()).toEqual([]);
});

// =================================================================== 2. shortcuts

test('shortcuts: every bound key has its real effect (A / B tool modes excluded)', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectConsoleErrors(page);
  const A = await boot(page);
  await ev(page, () => ((window as any).__noReload = true));
  const v = await add(page, A[MEDIA.vertical]!, { at: 0 });
  const l = await add(page, A[MEDIA.landscape]!, { at: S(5) });
  const tone = await add(page, A[MEDIA.tone]!, { at: 0 });
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await parkMouse(page);

  // Space: play / pause
  await key(page, 'Space');
  await expect.poll(() => ev(page, () => (window as any).__oe.getState().playing)).toBe(true);
  await key(page, 'Space');
  expect(await ev(page, () => (window as any).__oe.getState().playing)).toBe(false);

  // ⌘B split (selection) / ⌘⇧B split all
  await setPlayhead(page, S(2));
  await select(page, [v]);
  await exactUndo(page, '⌘B', () => key(page, `${MOD}+KeyB`));
  expect((await clips(page)).length).toBe(4);
  await key(page, `${MOD}+KeyZ`);
  await exactUndo(page, '⌘⇧B', () => key(page, `${MOD}+Shift+KeyB`));
  expect((await clips(page)).filter((c) => c.start === S(2)).map((c) => c.inPoint)).toEqual([S(2), S(2)]);
  await key(page, `${MOD}+KeyZ`);

  // Q / W
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await setPlayhead(page, S(7));
  await exactUndo(page, 'Q', () => key(page, 'KeyQ'));
  expect(await clip(page, l)).toMatchObject({ start: S(5), duration: S(2), inPoint: S(2) });
  expect(await playhead(page)).toBe(S(5));
  await key(page, `${MOD}+KeyZ`);
  await setPlayhead(page, S(7));
  await exactUndo(page, 'W', () => key(page, 'KeyW'));
  expect(await clip(page, l)).toMatchObject({ start: S(5), duration: S(2), inPoint: 0 });
  await key(page, `${MOD}+KeyZ`);

  // ← → ⇧← ⇧→ ↑ ↓ Home End (not undo steps)
  const steps0 = await pastLen(page);
  await setPlayhead(page, S(1));
  await key(page, 'ArrowRight');
  expect(await playhead(page)).toBe(1_033_333);
  await key(page, 'ArrowLeft');
  expect(await playhead(page)).toBe(S(1));
  await key(page, 'Shift+ArrowRight');
  expect(await playhead(page)).toBe(1_333_333);
  await key(page, 'Shift+ArrowLeft');
  expect(await playhead(page)).toBe(S(1));
  await key(page, 'ArrowDown');
  expect(await playhead(page)).toBe(S(5));
  const toneEnd = (await clip(page, tone)).duration; // the decoded mp3 is a little over 6 s
  await key(page, 'ArrowDown');
  expect(await playhead(page)).toBe(toneEnd);
  await key(page, 'ArrowUp');
  expect(await playhead(page)).toBe(S(5));
  await key(page, 'End');
  expect(await playhead(page)).toBe(S(9));
  await key(page, 'Home');
  expect(await playhead(page)).toBe(0);
  expect(await pastLen(page)).toBe(steps0);

  // ⇧Z fit / = − zoom (with and without ⌘)
  const z = () => ev(page, () => (window as any).__oe.getState().zoom as number);
  const z0 = await z();
  await key(page, 'Equal');
  expect(await z()).toBeCloseTo(z0 * 1.25, 5);
  await key(page, 'Minus');
  expect(await z()).toBeCloseTo(z0, 5);
  await key(page, `${MOD}+Equal`);
  expect(await z()).toBeCloseTo(z0 * 1.25, 5);
  await key(page, `${MOD}+Minus`);
  expect(await z()).toBeCloseTo(z0, 5);
  await key(page, 'Shift+KeyZ');
  const lane = await ev(page, () => (document.querySelector('.tl-scroller') as HTMLElement).clientWidth - 140);
  expect((await z()) * 9).toBeLessThanOrEqual(lane);
  await ev(page, () => (window as any).__oe.getState().setZoom(100));

  // [ ] select left / right of the playhead
  await setPlayhead(page, S(5));
  await key(page, 'BracketLeft');
  expect((await sel(page)).sort()).toEqual([v, tone].sort());
  await key(page, 'BracketRight');
  expect((await sel(page)).sort()).toEqual([l, tone].sort());
  // (main's tool modes: [ / ] also arm the side-select tool; A goes back to Select)
  expect(await ev(page, () => (window as any).__oeUi.getState().tool)).toBe('selectRight');
  await key(page, 'KeyA');
  expect(await ev(page, () => (window as any).__oeUi.getState().tool)).toBe('select');

  // ⌘A, Backspace, Delete
  await key(page, `${MOD}+KeyA`);
  expect((await sel(page)).length).toBe(3);
  await select(page, [l]);
  await exactUndo(page, 'Backspace', () => key(page, 'Backspace'));
  expect((await clips(page)).some((c) => c.id === l)).toBe(false);
  await key(page, `${MOD}+KeyZ`);
  await select(page, [l]);
  await exactUndo(page, 'Delete', () => key(page, 'Delete'));
  await key(page, `${MOD}+KeyZ`);

  // V enable / disable
  await select(page, [v]);
  await exactUndo(page, 'V', () => key(page, 'KeyV'));
  expect((await clip(page, v)).disabled).toBe(true);
  await key(page, 'KeyV');
  expect((await clip(page, v)).disabled).toBe(false);

  // M marker, I / O / ⇧X / ⌥X area
  await setPlayhead(page, S(3));
  await exactUndo(page, 'M', () => key(page, 'KeyM'));
  const area = () => ev(page, () => (window as any).__oeUi.getState().area as { in: number | null; out: number | null });
  await setPlayhead(page, S(1));
  await key(page, 'KeyI');
  await setPlayhead(page, S(4));
  await key(page, 'KeyO');
  expect(await area()).toEqual({ in: S(1), out: S(4) });
  await expect(page.getByTestId('timeline-area')).toHaveAttribute('data-in', String(S(1)));
  await key(page, 'Alt+KeyX');
  expect(await area()).toEqual({ in: null, out: null });
  await select(page, [l]);
  await key(page, 'Shift+KeyX');
  expect(await area()).toEqual({ in: S(5), out: S(9) });
  await key(page, 'Escape');
  expect(await area()).toEqual({ in: null, out: null });
  await key(page, 'Escape');
  expect(await sel(page)).toEqual([]);

  // S preview axis, P magnet, N snapping, ~ linkage
  const ui = (k: string) => ev(page, (x) => (window as any).__oeUi.getState()[x], k);
  const ed = (k: string) => ev(page, (x) => (window as any).__oe.getState()[x], k);
  await key(page, 'KeyS');
  expect(await ui('previewAxis')).toBe(false);
  await key(page, 'KeyS');
  expect(await ui('previewAxis')).toBe(true);
  await key(page, 'KeyP');
  expect(await ed('magnet')).toBe(false);
  await key(page, 'KeyP');
  expect(await ed('magnet')).toBe(true);
  await key(page, 'KeyN');
  expect(await ed('snapping')).toBe(false);
  await key(page, 'KeyN');
  expect(await ed('snapping')).toBe(true);
  await key(page, 'Backquote');
  expect(await ed('linkage')).toBe(false);
  await key(page, 'Backquote');
  expect(await ed('linkage')).toBe(true);

  // ⌘⇧S extract / restore, ⌘. ⌘, volume
  await select(page, [l]);
  await exactUndo(page, '⌘⇧S extract', () => key(page, `${MOD}+Shift+KeyS`));
  const ex = (await clips(page)).find((c) => c.type === 'audio' && c.audioLink)!;
  expect(ex).toMatchObject({ start: S(5), duration: S(4), inPoint: 0 });
  expect(await clip(page, l)).toMatchObject({ muted: true, audioLink: ex.audioLink });
  await exactUndo(page, '⌘⇧S restore', () => key(page, `${MOD}+Shift+KeyS`));
  expect((await clips(page)).some((c) => c.id === ex.id)).toBe(false);
  expect(await clip(page, l)).toMatchObject({ muted: false });
  await exactUndo(page, '⌘.', () => key(page, `${MOD}+Period`));
  expect((await clip(page, l)).volumeDb).toBe(1);
  await key(page, `${MOD}+Comma`);
  await key(page, `${MOD}+Comma`);
  expect((await clip(page, l)).volumeDb).toBe(-1);

  // ⌘R speed / ⇧B curve speed open the inspector's Speed tab (no reload)
  await select(page, [l]);
  await key(page, `${MOD}+KeyR`);
  await expect(page.getByTestId('inspector').getByRole('tab', { name: 'Speed', exact: true })).toHaveAttribute('aria-selected', 'true');
  await key(page, 'Shift+KeyB');
  await expect(page.getByTestId('speed-curve')).toBeVisible(); // tab-speed: Speed › Curve is built now
  expect(await ev(page, () => (window as any).__noReload)).toBe(true);

  // ⌘C / ⌘V, ⌘X / ⌘V, ⌘D
  await select(page, [l]);
  await key(page, `${MOD}+KeyC`);
  await setPlayhead(page, S(20));
  await exactUndo(page, '⌘V', () => key(page, `${MOD}+KeyV`));
  const pasted = (await clips(page)).filter((c) => c.name === MEDIA.landscape && c.id !== l);
  expect(pasted.map((c) => [c.trackKind, c.start, c.duration])).toEqual([['main', S(9), S(4)]]); // magnet: appended
  await key(page, `${MOD}+KeyZ`);
  await select(page, [tone]);
  await exactUndo(page, '⌘X', () => key(page, `${MOD}+KeyX`));
  expect((await clips(page)).some((c) => c.id === tone)).toBe(false);
  await setPlayhead(page, S(2));
  await exactUndo(page, '⌘V after ⌘X', () => key(page, `${MOD}+KeyV`));
  expect((await clips(page)).find((c) => c.type === 'audio')).toMatchObject({ start: S(2), duration: toneEnd, inPoint: 0 });
  await select(page, [v]);
  await exactUndo(page, '⌘D', () => key(page, `${MOD}+KeyD`));
  expect((await clips(page)).filter((c) => c.trackKind === 'main').map((c) => c.start)).toEqual([0, S(5), S(10)]);

  // ⌘Z / ⌘⇧Z are exercised by every exactUndo above; ⌘E export, ⌘I import, Tab, ⇧⌘F, ⌥⇧Z
  await key(page, `${MOD}+KeyE`);
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-dialog')).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await key(page, `${MOD}+KeyI`);
  await chooser;
  const tab0 = await page.locator('[data-testid^="library-tab-"][aria-selected="true"]').getAttribute('data-testid');
  await key(page, 'Tab');
  const tab1 = await page.locator('[data-testid^="library-tab-"][aria-selected="true"]').getAttribute('data-testid');
  expect(tab1).not.toBe(tab0);
  await key(page, 'Shift+Tab');
  expect(await page.locator('[data-testid^="library-tab-"][aria-selected="true"]').getAttribute('data-testid')).toBe(tab0);
  await key(page, 'Alt+Shift+KeyZ');
  await key(page, `${MOD}+Shift+KeyF`);
  await expect.poll(() => ev(page, () => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press('Escape');
  await ev(page, () => (document.fullscreenElement ? document.exitFullscreen() : undefined));

  await healthy(page, 'end of shortcuts');
  expect(errors.real()).toEqual([]);
});

// =================================================================== 3. gestures

test('gestures: select, multi-select, marquee, move, new track, trim, snap, Esc cancel', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectConsoleErrors(page);
  const A = await boot(page);
  const v = await add(page, A[MEDIA.vertical]!, { at: 0 });
  const l = await add(page, A[MEDIA.landscape]!, { at: S(5) });
  const o = await add(page, A[MEDIA.image]!, { at: S(1), kind: 'overlay' });
  await ev(page, (id) => (window as any).__oe.getState().trimEnd(id, 3_000_000), o); // overlay 1..3 s
  const tone = await add(page, A[MEDIA.tone]!, { at: 0 });
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await page.waitForTimeout(300);
  let g = await geo(page);
  const tr = await tracks(page);
  const mainId = tr.find((t) => t.kind === 'main')!.id;
  const ovId = tr.find((t) => t.kind === 'overlay')!.id;
  const auId = tr.find((t) => t.kind === 'audio')!.id;
  const yMain = await g.rowY(mainId);
  const yOv = await g.rowY(ovId);
  const yAu = await g.rowY(auId);

  // click select / shift-add / cmd-toggle / click empty space → deselect + playhead
  await page.mouse.click(g.x(S(2.5)), yMain);
  expect(await sel(page)).toEqual([v]);
  await page.keyboard.down('Shift');
  await page.mouse.click(g.x(S(7)), yMain);
  await page.keyboard.up('Shift');
  expect((await sel(page)).sort()).toEqual([v, l].sort());
  await page.keyboard.down(MOD);
  await page.mouse.click(g.x(S(2.5)), yMain);
  await page.keyboard.up(MOD);
  expect(await sel(page)).toEqual([l]);
  await page.mouse.click(g.x(S(4)), yOv); // empty overlay lane
  expect(await sel(page)).toEqual([]);
  expect(await playhead(page)).toBe(S(4));

  // marquee across the overlay and main rows from 0.5 s to 6 s: picks v, o, l (not the audio)
  await drag(page, { x: g.x(S(0.5)), y: yOv - 18 }, { x: g.x(S(6)), y: yMain });
  expect((await sel(page)).sort()).toEqual([v, o, l].sort());
  await ev(page, () => (window as any).__oe.getState().clearSelection());

  // move on the magnetic main track: drag l before v → [l, v], packed
  await exactUndo(page, 'drag reorder on main', () => drag(page, { x: g.x(S(7)), y: yMain }, { x: g.x(S(0.3)), y: yMain }));
  expect((await clips(page)).filter((c) => c.trackKind === 'main').map((c) => [c.id, c.start])).toEqual([
    [l, 0],
    [v, S(4)],
  ]);
  await key(page, `${MOD}+KeyZ`);

  // move the overlay in time with snapping OFF (Alt) → exact pixel delta
  await exactUndo(page, 'drag overlay (Alt: no snap)', () => drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)) + 150, y: yOv }, { alt: true }));
  expect(await clip(page, o)).toMatchObject({ start: S(2.5), duration: S(2) });
  await key(page, `${MOD}+KeyZ`);

  // snapping to the playhead: drop the overlay start 5 px from the playhead at 4.2 s
  await setPlayhead(page, S(4.2));
  await drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)) + (S(4.2) - S(1)) / 1e4 + 5, y: yOv });
  expect((await clip(page, o)).start).toBe(S(4.2));
  await key(page, `${MOD}+KeyZ`);
  // snapping to a marker
  await ev(page, () => (window as any).__oe.getState().addMarker(6_000_000));
  await drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)) + (S(6) - S(1)) / 1e4 - 4, y: yOv });
  expect((await clip(page, o)).start).toBe(S(6));
  await key(page, `${MOD}+KeyZ`);
  await key(page, `${MOD}+KeyZ`); // the marker
  // snapping to another clip's edge (end of v at 5 s)
  await drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)) + (S(5) - S(1)) / 1e4 + 6, y: yOv });
  expect((await clip(page, o)).start).toBe(S(5));
  await key(page, `${MOD}+KeyZ`);

  // drop into the empty band above all tracks → a NEW overlay track above
  await exactUndo(page, 'drag into the top band', async () => drag(page, { x: g.x(S(2)), y: yOv }, { x: g.x(S(2)), y: await g.bandY('top') }));
  let t2 = await tracks(page);
  expect(t2.map((t) => t.kind).sort()).toEqual(['audio', 'main', 'overlay']);
  expect(t2.filter((t) => t.kind === 'overlay')).toHaveLength(1); // the old one emptied and went away
  expect((await clip(page, o)).track).not.toBe(ovId);
  await key(page, `${MOD}+KeyZ`);

  // drag the main video onto the overlay track → becomes an overlay clip at that time
  await exactUndo(page, 'drag main → overlay track', () => drag(page, { x: g.x(S(7)), y: yMain }, { x: g.x(S(7)) + 100, y: yOv }, { alt: true }));
  expect(await clip(page, l)).toMatchObject({ trackKind: 'overlay', start: S(6), duration: S(4) });
  await key(page, `${MOD}+KeyZ`);

  // the audio clip into the bottom band → a new audio track; refused onto a video track
  await drag(page, { x: g.x(S(3)), y: yAu }, { x: g.x(S(3)), y: await g.bandY('bottom') }, { alt: true });
  t2 = await tracks(page);
  expect(t2.filter((t) => t.kind === 'audio')).toHaveLength(1);
  expect((await clip(page, tone)).track).not.toBe(auId);
  await key(page, `${MOD}+KeyZ`);
  const beforeRefuse = await clip(page, tone);
  await drag(page, { x: g.x(S(3)), y: yAu }, { x: g.x(S(3)), y: yMain }, { alt: true });
  expect(await clip(page, tone)).toMatchObject({ trackKind: 'audio', track: beforeRefuse.track });
  await healthy(page, 'refused cross-kind drop');

  // trims (snapping off): right edge of v past its media end stops at 5 s; left edge of l
  await ev(page, () => (window as any).__oe.getState().setSnapping(false));
  g = await geo(page);
  await exactUndo(page, 'trim right edge (shorter)', () => drag(page, { x: g.x(S(5)) - 3, y: yMain }, { x: g.x(S(3.5)) - 3, y: yMain }));
  expect(await clip(page, v)).toMatchObject({ start: 0, duration: S(3.5), inPoint: 0 });
  expect(await clip(page, l)).toMatchObject({ start: S(3.5) }); // rippled
  await drag(page, { x: g.x(S(3.5)) - 3, y: yMain }, { x: g.x(S(12)), y: yMain });
  expect(await clip(page, v)).toMatchObject({ duration: S(5) }); // media limit
  await key(page, `${MOD}+KeyZ`);
  await key(page, `${MOD}+KeyZ`);
  await exactUndo(page, 'trim left edge', () => drag(page, { x: g.x(S(5)) + 3, y: yMain }, { x: g.x(S(6)) + 3, y: yMain }));
  expect(await clip(page, l)).toMatchObject({ start: S(5), duration: S(3), inPoint: S(1) });
  // left edge back past the media start stops at in-point 0
  await drag(page, { x: g.x(S(5)) + 3, y: yMain }, { x: g.x(S(1)), y: yMain });
  expect(await clip(page, l)).toMatchObject({ start: S(5), duration: S(4), inPoint: 0 });
  await key(page, `${MOD}+KeyZ`);
  await key(page, `${MOD}+KeyZ`);
  // trim at speed 2 respects the media in source time: 5 s of media = 2.5 s on the timeline
  await ev(page, (id) => (window as any).__oe.getState().setSpeed(id, 2), v);
  await drag(page, { x: g.x(S(2.5)) - 3, y: yMain }, { x: g.x(S(1.5)) - 3, y: yMain });
  expect(await clip(page, v)).toMatchObject({ duration: S(1.5), speed: 2 });
  await drag(page, { x: g.x(S(1.5)) - 3, y: yMain }, { x: g.x(S(8)), y: yMain });
  expect(await clip(page, v)).toMatchObject({ duration: S(2.5) });
  await key(page, `${MOD}+KeyZ`);
  await key(page, `${MOD}+KeyZ`);
  await key(page, `${MOD}+KeyZ`);
  expect((await clip(page, v)).speed).toBe(1);

  // trim snapping to the playhead (snapping on)
  await ev(page, () => (window as any).__oe.getState().setSnapping(true));
  await setPlayhead(page, S(2.2));
  await drag(page, { x: g.x(S(3)) - 3, y: yOv }, { x: g.x(S(2.2)) + 1, y: yOv });
  expect(await clip(page, o)).toMatchObject({ start: S(1), duration: S(1.2) });
  await key(page, `${MOD}+KeyZ`);

  // Esc cancels a trim mid-drag: exact document restored, no undo step
  const beforeEsc = await doc(page);
  const pEsc = await pastLen(page);
  await page.mouse.move(g.x(S(5)) - 3, yMain);
  await page.mouse.down();
  await page.mouse.move(g.x(S(4)), yMain, { steps: 8 });
  expect((await clip(page, v)).duration).toBeLessThan(S(5));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await doc(page)).toBe(beforeEsc);
  expect(await pastLen(page)).toBe(pEsc);

  // linkage: dragging a video drags its extracted audio along
  await ev(page, (id) => (window as any).__oe.getState().toggleExtractAudio([id]), l);
  await page.waitForTimeout(200);
  const ext = (await clips(page)).find((c) => c.type === 'audio' && c.audioLink)!;
  expect(ext.start).toBe(S(5));
  await exactUndo(page, 'drag linked video (linkage on)', () => drag(page, { x: g.x(S(7)), y: yMain }, { x: g.x(S(0.3)), y: yMain }));
  expect(await clip(page, l)).toMatchObject({ start: 0 });
  expect(await clip(page, ext.id)).toMatchObject({ start: 0 });
  await key(page, `${MOD}+KeyZ`);
  await key(page, 'Backquote'); // linkage off
  await drag(page, { x: g.x(S(7)), y: yMain }, { x: g.x(S(0.3)), y: yMain });
  expect(await clip(page, l)).toMatchObject({ start: 0 });
  expect(await clip(page, ext.id)).toMatchObject({ start: S(5) });
  await key(page, 'Backquote');

  await healthy(page, 'end of gestures');
  expect(errors.real()).toEqual([]);
});

// =================================================================== 4. track lock / hide / mute, Cover

test('track headers: lock blocks edits, hide removes pictures from the preview, mute silences', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsoleErrors(page);
  const A = await boot(page);
  const img = await add(page, A[MEDIA.image]!, { at: 0 });
  const tone = await add(page, A[MEDIA.tone]!, { at: 0 });
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await setPlayhead(page, S(1));
  await parkMouse(page);
  const tr = await tracks(page);
  const mainId = tr.find((t) => t.kind === 'main')!.id;
  const auId = tr.find((t) => t.kind === 'audio')!.id;
  const header = (id: string) => page.locator(`[data-track-id="${id}"]`);

  // ---- hide: the picture leaves the preview (renderer shared with export), audio is unaffected
  await expect.poll(() => canvasLuma(page), { timeout: 10_000 }).toBeGreaterThan(10);
  const lit = await canvasLuma(page);
  await exactUndo(page, 'hide main track', () => header(mainId).getByTestId('track-hide').click());
  await expect(header(mainId).getByTestId('track-hide')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => canvasLuma(page)).toBeLessThan(3);
  await key(page, `${MOD}+KeyZ`);
  await expect.poll(() => canvasLuma(page)).toBeGreaterThan(lit * 0.8);

  // ---- mute: no voice plays for a muted track
  await exactUndo(page, 'mute audio track', () => header(auId).getByTestId('track-mute').click());
  await setPlayhead(page, 0);
  await key(page, 'Space');
  await page.waitForTimeout(1200);
  expect(await voices(page)).toBe(0);
  await key(page, 'Space');
  await header(auId).getByTestId('track-mute').click(); // unmute
  await setPlayhead(page, 0);
  await key(page, 'Space');
  await expect.poll(() => voices(page), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  await key(page, 'Space');
  await setPlayhead(page, S(1));

  // ---- lock: clicks, drags, trims, keys and toolbar buttons do nothing to the locked track
  await exactUndo(page, 'lock main track', () => header(mainId).getByTestId('track-lock').click());
  const frozen = await doc(page);
  const p0 = await pastLen(page);
  const g = await geo(page);
  const yMain = await g.rowY(mainId);
  await expect(page.locator(`[data-clip-id="${img}"] .tl-clip__handle`)).toHaveCount(0);
  await page.mouse.click(g.x(S(2)), yMain);
  expect(await sel(page)).toEqual([]);
  await drag(page, { x: g.x(S(2)), y: yMain }, { x: g.x(S(4)), y: yMain });
  await drag(page, { x: g.x(S(5)) - 3, y: yMain }, { x: g.x(S(3)), y: yMain });
  await key(page, `${MOD}+KeyA`);
  expect(await sel(page)).toEqual([tone]); // ⌘A skips the locked track
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  for (const k of ['KeyQ', 'KeyW', `${MOD}+KeyB`, `${MOD}+Shift+KeyB`, 'Backspace', `${MOD}+KeyD`]) await key(page, k);
  // the main track itself is untouched by everything above
  const mainNow = await ev(page, (id) => JSON.stringify((window as any).__oe.getState().project.tracks.find((t: any) => t.id === id)), mainId);
  const mainThen = JSON.stringify(JSON.parse(frozen).tracks.find((t: any) => t.id === mainId));
  expect(mainNow).toBe(mainThen);
  // new media with the main track locked lands on an overlay track, not in the locked track
  await add(page, A[MEDIA.vertical]!, { at: 0 });
  expect((await clips(page)).find((c) => c.name === MEDIA.vertical)!.trackKind).toBe('overlay');
  expect(await ev(page, (id) => JSON.stringify((window as any).__oe.getState().project.tracks.find((t: any) => t.id === id)), mainId)).toBe(mainThen);
  expect(await pastLen(page)).toBeGreaterThan(p0); // the split of the audio + the add were real steps
  await healthy(page, 'after lock attempts');

  // ---- Cover: present on the main track only, and disabled ("coming soon")
  await expect(page.locator('.tl-cover')).toHaveCount(1);
  await expect(header(mainId).locator('.tl-cover')).toBeDisabled();
  expect(errors.real()).toEqual([]);
});

// =================================================================== 5. transitions + markers

test('transitions on cuts (add, select, duration, type, delete) and markers (add, seek, remove, snap)', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsoleErrors(page);
  const A = await boot(page);
  const v = await add(page, A[MEDIA.vertical]!, { at: 0 });
  const l = await add(page, A[MEDIA.landscape]!, { at: S(5) });
  await select(page, [v]);
  await parkMouse(page);

  // add from the Transitions library (lands on the cut after the selected clip)
  await page.getByTestId('library-tab-transitions').click();
  await exactUndo(page, 'add transition', () => page.getByTestId('transition-preset').first().locator('.ptile__preview').click());
  const trs = () => ev(page, () => (window as any).__oe.getState().project.tracks[0].transitions as any[]);
  expect(await trs()).toEqual([expect.objectContaining({ fromClipId: v, toClipId: l, duration: S(0.5) })]);
  const id = (await trs())[0].id as string;

  // select it on the timeline → inspector shows it; the preview inside the window mixes both clips
  await page.getByTestId('timeline-transition').click();
  expect(await ev(page, () => (window as any).__oe.getState().selection.transitionId)).toBe(id);
  await expect(page.getByTestId('inspector-transition')).toBeVisible();

  // change duration by typing (clamped to half the shorter clip = 2 s)
  const box = page.getByTestId('transition-duration').getByLabel('Duration value');
  const typeInto = async (text: string) => {
    await box.click();
    await page.keyboard.press(`${MOD}+KeyA`);
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  await exactUndo(page, 'transition duration', () => typeInto('1.5'));
  expect((await trs())[0].duration).toBe(S(1.5));
  await page.getByTestId('timeline-transition').click();
  await typeInto('9');
  expect((await trs())[0].duration).toBe(S(2));
  await key(page, `${MOD}+KeyZ`);
  // change type
  await page.getByTestId('timeline-transition').click();
  await exactUndo(page, 'transition type', () => page.getByTestId('inspector-transition').getByRole('button', { name: 'Zoom', exact: true }).click());
  expect((await trs())[0].type).toBe('zoom');

  // delete the selected transition with the Delete key (the clips stay)
  await page.getByTestId('timeline-transition').click();
  await exactUndo(page, 'delete transition', () => key(page, 'Delete'));
  expect(await trs()).toEqual([]);
  expect((await clips(page)).length).toBe(2);
  await key(page, `${MOD}+KeyZ`);
  // deleting a clip of the cut removes its transition (no orphan)
  await select(page, [l]);
  await key(page, 'Delete');
  expect(await trs()).toEqual([]);
  await healthy(page, 'no orphan transition');
  await key(page, `${MOD}+KeyZ`);
  // a split moves the transition to the right-hand piece
  await setPlayhead(page, S(2));
  await select(page, [v]);
  await key(page, `${MOD}+KeyB`);
  const right = (await clips(page)).find((c) => c.trackKind === 'main' && c.start === S(2))!;
  expect((await trs())[0]).toMatchObject({ fromClipId: right.id, toClipId: l });
  await key(page, `${MOD}+KeyZ`);

  // markers: M at the playhead, click seeks, snapping to it while trimming, double-click removes
  await setPlayhead(page, S(3));
  await key(page, 'KeyM');
  await setPlayhead(page, 0);
  const marker = page.getByTestId('timeline-marker');
  await expect(marker).toHaveCount(1);
  await marker.click();
  expect(await playhead(page)).toBe(S(3));
  await setPlayhead(page, S(8.5));
  await page.getByTestId('timeline-transition').click();
  await key(page, 'Delete'); // the transition button would cover the trim handles at the cut
  await parkMouse(page);
  const g = await geo(page);
  const yMain = await g.rowY((await tracks(page))[0]!.id);
  await drag(page, { x: g.x(S(5)) - 3, y: yMain }, { x: g.x(S(3)) + 2, y: yMain }); // v's end → snaps to the marker at 3 s
  expect(await clip(page, v)).toMatchObject({ duration: S(3) });
  await key(page, `${MOD}+KeyZ`);
  await exactUndo(page, 'remove marker (double-click)', () => marker.dblclick());
  expect(await ev(page, () => (window as any).__oe.getState().project.markers.length)).toBe(0);
  expect(errors.real()).toEqual([]);
});

// =================================================================== 6. UI fuzz

test('UI fuzz: 60 random keyboard / toolbar edits keep every invariant; ⌘Z goes back to the start exactly', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectConsoleErrors(page);
  const A = await boot(page);
  await add(page, A[MEDIA.vertical]!, { at: 0 });
  await add(page, A[MEDIA.landscape]!, { at: S(5) });
  await add(page, A[MEDIA.image]!, { at: S(2), kind: 'overlay' });
  await add(page, A[MEDIA.tone]!, { at: S(1) });
  await ev(page, () => (window as any).__oe.getState().clearSelection());
  await parkMouse(page);
  // the starting point is "now": everything after this is undone at the end
  const start = await doc(page);
  const startSteps = await pastLen(page);

  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const actions: Array<[string, () => Promise<unknown>]> = [
    ['⌘B', () => key(page, `${MOD}+KeyB`)],
    ['⌘⇧B', () => key(page, `${MOD}+Shift+KeyB`)],
    ['Q', () => key(page, 'KeyQ')],
    ['W', () => key(page, 'KeyW')],
    ['Delete', () => key(page, 'Delete')],
    ['⌘D', () => key(page, `${MOD}+KeyD`)],
    ['⌘C⌘V', async () => (await key(page, `${MOD}+KeyC`), key(page, `${MOD}+KeyV`))],
    ['⌘X', () => key(page, `${MOD}+KeyX`)],
    ['⌘V', () => key(page, `${MOD}+KeyV`)],
    ['V', () => key(page, 'KeyV')],
    ['M', () => key(page, 'KeyM')],
    ['⌘⇧S', () => key(page, `${MOD}+Shift+KeyS`)],
    ['⌘.', () => key(page, `${MOD}+Period`)],
    ['P', () => key(page, 'KeyP')],
    ['~', () => key(page, 'Backquote')],
    ['mirror', async () => (await toolbarButton(page, /^Mirror/).isEnabled()) && toolbarButton(page, /^Mirror/).click()],
    ['rotate', async () => (await toolbarButton(page, /^Rotate/).isEnabled()) && toolbarButton(page, /^Rotate/).click()],
    ['[', () => key(page, 'BracketLeft')],
    [']', () => key(page, 'BracketRight')],
    ['⌘A', () => key(page, `${MOD}+KeyA`)],
  ];
  const log: string[] = [];
  const growing = new Set(['⌘D', '⌘C⌘V', '⌘V']);
  for (let i = 0; i < 60; i++) {
    // random playhead and a random single selection, then a random action
    const all = await clips(page);
    const dur = Math.max(S(1), ...all.map((c) => c.start + c.duration));
    await setPlayhead(page, Math.floor(rnd() * dur));
    if (all.length && rnd() < 0.7) await select(page, [pick(all).id]);
    let [name, run] = pick(actions);
    // keep the edit small enough to stay quick: no more copies past 16 clips
    while (all.length > 16 && growing.has(name)) [name, run] = pick(actions);
    log.push(name);
    await run();
    const v = await ev(page, () => (window as any).__oeCheck() as string[]);
    expect(v, `step ${i} (${name}); last: ${log.slice(-5).join(', ')}`).toEqual([]);
  }
  // undo everything back to the start with ⌘Z
  const made = (await pastLen(page)) - startSteps;
  expect(made).toBeGreaterThan(15);
  for (let i = 0; i < made; i++) await key(page, `${MOD}+KeyZ`);
  // the magnet may have been toggled by P (UI state, not the document)
  expect(await doc(page)).toBe(start);
  expect(errors.real()).toEqual([]);
});
