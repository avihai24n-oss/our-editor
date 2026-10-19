/**
 * Timeline stability: the "timeline jumps / shakes" reports, measured every animation frame.
 *
 * - Hover (preview axis) moves only the amber hover line; the white playhead moves only on click,
 *   drag, keys or playback. The player previews the hovered frame while paused.
 * - A press whose pointerup is lost no longer leaves the playhead glued to the mouse.
 * - With B (split tool) active, nothing oscillates for 2 s with the mouse still or moving slowly.
 * - Playback follows the playhead without paging, and a sideways scroll while playing is not
 *   snapped back every frame.
 * - Deleting / trimming the last clip while scrolled to the end does not clamp the scroll.
 * - Zoom never paints a frame with clips missing under the anchor.
 * - Adding tracks does not move the main track.
 *
 * Real (non-overlay) scrollbars: Playwright hides scrollbars by default, which would hide any
 * scrollbar-toggle loop; this spec turns them back on.
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsoleErrors, importMedia, MEDIA, openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } as any });

type Sample = {
  sl: number;
  st: number;
  sbH: number;
  sbW: number;
  sw: number;
  sh: number;
  ch: number;
  tlH: number;
  mainY: number;
  ph: number;
  pv: number | null;
  phX: number | null;
  hovX: number | null;
  bladeX: number | null;
  clips: string;
  underAnchor: boolean;
};

async function startSampler(page: Page, anchorX = 0) {
  await page.evaluate((ax) => {
    const w = window as any;
    cancelAnimationFrame(w.__stabRaf);
    w.__stab = [];
    const left = (sel: string) => {
      const e = document.querySelector(sel) as HTMLElement | null;
      return e ? Math.round(e.getBoundingClientRect().left * 10) / 10 : null;
    };
    const tick = () => {
      const sc = document.querySelector('.tl-scroller') as HTMLElement;
      const r = sc.getBoundingClientRect();
      const main = document.querySelector('.tl-row--main') as HTMLElement;
      const s = w.__oe.getState();
      const clipEls = [...document.querySelectorAll<HTMLElement>('[data-testid="timeline-clip"]')];
      const underAnchor = !ax || clipEls.some((c) => {
        const b = c.getBoundingClientRect();
        return b.left <= ax && b.right >= ax && main.contains(c);
      });
      w.__stab.push({
        sl: Math.round(sc.scrollLeft),
        st: Math.round(sc.scrollTop),
        sbH: sc.offsetHeight - sc.clientHeight,
        sbW: sc.offsetWidth - sc.clientWidth,
        sw: sc.scrollWidth,
        sh: sc.scrollHeight,
        ch: sc.clientHeight,
        tlH: Math.round((document.querySelector('[data-testid="timeline"]') as HTMLElement).getBoundingClientRect().height),
        mainY: Math.round(main.getBoundingClientRect().top - r.top),
        ph: s.playhead,
        pv: s.previewTime,
        phX: left('.tl-playhead'),
        hovX: left('[data-testid="timeline-hover"]'),
        bladeX: left('[data-testid="timeline-blade"]'),
        clips: clipEls.map((c) => `${c.dataset.clipId}@${Math.round(c.getBoundingClientRect().left)},${Math.round(c.getBoundingClientRect().top)}`).join(' '),
        underAnchor,
      });
      w.__stabRaf = requestAnimationFrame(tick);
    };
    tick();
  }, anchorX);
}
const takeSamples = (page: Page): Promise<Sample[]> => page.evaluate(() => (window as any).__stab.splice(0));
const stopSampler = (page: Page) => page.evaluate(() => cancelAnimationFrame((window as any).__stabRaf));

/** Number of direction reversals of a numeric series (A→B→A is one): oscillation shows up here. */
function reversals(values: (number | null)[]): number {
  const v = values.filter((x): x is number => x !== null);
  let n = 0;
  let dir = 0;
  for (let i = 1; i < v.length; i++) {
    const d = Math.sign(v[i]! - v[i - 1]!);
    if (d !== 0) {
      if (dir !== 0 && d !== dir) n++;
      dir = d;
    }
  }
  return n;
}
/** How many times a value changed at all. */
const changes = <T,>(values: T[]): number => values.reduce((n, x, i) => (i && x !== values[i - 1] ? n + 1 : n), 0);

const STABLE_KEYS = ['sl', 'st', 'sbH', 'sbW', 'sw', 'sh', 'ch', 'tlH', 'mainY', 'ph', 'phX', 'clips'] as const;

async function setupProject(page: Page, opts: { zoom?: number; extraAudio?: boolean } = {}) {
  await openApp(page);
  await page.waitForFunction(() => !!(window as any).__oe);
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.tone]);
  await page.evaluate(({ zoom, extraAudio }) => {
    const oe = (window as any).__oe;
    const as = Object.values(oe.getState().project.assets) as any[];
    const vids = as.filter((a) => a.kind === 'video');
    let at = 0;
    for (let i = 0; i < 6; i++) {
      const a = vids[i % vids.length];
      oe.getState().addClip(a.id, { at });
      at += a.duration;
    }
    if (extraAudio) oe.getState().addClip(as.find((a) => a.kind === 'audio').id, { at: 0 });
    if (zoom) oe.getState().setZoom(zoom);
    oe.getState().setPlayhead(0);
    oe.getState().clearSelection();
  }, opts);
  await page.waitForTimeout(800);
}

test('hover moves only the amber preview line; the white playhead moves on click', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await setupProject(page, { zoom: 150, extraAudio: true });
  const main = (await page.locator('.tl-row--main').boundingBox())!;
  const ph0 = await page.evaluate(() => (window as any).__oe.getState().playhead);
  const headX0 = (await page.getByTestId('playhead').boundingBox())!.x;

  // preview axis is on by default (CapCut)
  await expect(page.getByTestId('timeline-hover')).toHaveCount(0);
  for (const dx of [300, 450, 600]) {
    await page.mouse.move(main.x + dx, main.y + main.height / 2);
    await expect(page.getByTestId('timeline-hover')).toBeVisible();
    const hov = (await page.getByTestId('timeline-hover').boundingBox())!;
    expect(Math.abs(hov.x - (main.x + dx))).toBeLessThan(6); // follows the mouse (frame-snapped)
    const st = await page.evaluate(() => {
      const s = (window as any).__oe.getState();
      return { ph: s.playhead, pv: s.previewTime };
    });
    expect(st.ph).toBe(ph0); // the playhead does not move on hover
    expect(st.pv).not.toBeNull(); // the player previews the hovered frame
    expect((await page.getByTestId('playhead').boundingBox())!.x).toBe(headX0);
  }
  // amber, not the playhead's white
  const colors = await page.evaluate(() => ({
    hover: getComputedStyle(document.querySelector('[data-testid="timeline-hover"]')!).backgroundColor,
    playhead: getComputedStyle(document.querySelector('.tl-playhead')!).backgroundColor,
  }));
  expect(colors.hover).toBe('rgb(245, 184, 61)');
  expect(colors.playhead).toBe('rgb(255, 255, 255)');
  // the hover line also shows over the ruler
  const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
  await page.mouse.move(main.x + 520, ruler.y + ruler.height / 2);
  await expect(page.getByTestId('timeline-hover-head')).toBeVisible();
  await screenshot(page, 'stability-01-hover-axis');

  // leaving the timeline: the player goes back to the playhead frame
  await page.mouse.move(main.x + 520, 40);
  await expect(page.getByTestId('timeline-hover')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__oe.getState().previewTime)).toBeNull();

  // a click on empty track space moves the playhead there
  await page.mouse.click(main.x + 450, main.y - 12);
  const ph1 = await page.evaluate(() => (window as any).__oe.getState().playhead);
  expect(ph1).toBeGreaterThan(ph0);
  expect(Math.abs((await page.getByTestId('playhead').boundingBox())!.x + 5.5 - (main.x + 450))).toBeLessThan(6);
  await screenshot(page, 'stability-02-playhead-after-click');

  // playback is not overridden by the hover preview
  await page.mouse.move(main.x + 700, main.y + main.height / 2);
  await page.evaluate(() => (window as any).__oe.getState().play());
  await page.mouse.move(main.x + 720, main.y + main.height / 2);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__oe.getState().previewTime)).toBeNull();
  await page.evaluate(() => (window as any).__oe.getState().pause());
  expect(errors.real()).toEqual([]);
});

test('a lost pointerup does not leave the playhead following the mouse', async ({ page }) => {
  await setupProject(page, { zoom: 150 });
  const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
  await page.mouse.move(ruler.x + 200, ruler.y + 10);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 260, ruler.y + 10, { steps: 3 });
  const scrubbed = await page.evaluate(() => (window as any).__oe.getState().playhead);
  // released outside the window: no pointerup arrives, the next move has no buttons pressed
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 900, clientY: 700, pointerId: 1, buttons: 0, bubbles: true })));
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1100, clientY: 700, pointerId: 1, buttons: 0, bubbles: true })));
  expect(await page.evaluate(() => (window as any).__oe.getState().playhead)).toBe(scrubbed);
  await page.mouse.up();
});

test('with B (split tool) nothing oscillates for 2 s, mouse still or moving slowly', async ({ page }) => {
  await setupProject(page, { extraAudio: true });
  const main = (await page.locator('.tl-row--main').boundingBox())!;
  await page.mouse.click(main.x + 500, main.y - 12); // click the timeline first, as reported
  await page.keyboard.press('b');
  await page.mouse.move(main.x + 380, main.y + main.height / 2);
  await expect(page.getByTestId('timeline-blade')).toBeVisible();
  await startSampler(page);

  await page.waitForTimeout(2000); // mouse still
  let s = await takeSamples(page);
  expect(s.length).toBeGreaterThan(60);
  for (const k of [...STABLE_KEYS, 'bladeX', 'hovX'] as const) expect(changes(s.map((x) => x[k])), `${k} changed with the mouse still`).toBe(0);

  for (let i = 0; i < 40; i++) {
    await page.mouse.move(main.x + 380 + i * 3, main.y + main.height / 2);
    await page.waitForTimeout(50);
  }
  s = await takeSamples(page);
  for (const k of STABLE_KEYS) expect(changes(s.map((x) => x[k])), `${k} changed during a slow hover`).toBe(0);
  expect(reversals(s.map((x) => x.bladeX)), 'blade line flips back and forth').toBe(0);
  expect(reversals(s.map((x) => x.hovX)), 'hover line flips back and forth').toBe(0);
  // a click with the blade splits once and then the view stays still
  await page.mouse.click(main.x + 500, main.y + main.height / 2);
  await page.waitForTimeout(300);
  await takeSamples(page);
  await page.waitForTimeout(1000);
  s = await takeSamples(page);
  for (const k of STABLE_KEYS) expect(changes(s.map((x) => x[k])), `${k} changed after the split click`).toBe(0);
  await stopSampler(page);
  await screenshot(page, 'stability-03-blade');
});

test('playback glides with the playhead and does not fight a manual scroll', async ({ page }) => {
  await setupProject(page, { zoom: 600 });
  const sc = page.locator('.tl-scroller');
  const box = (await sc.boundingBox())!;
  await startSampler(page);
  await page.evaluate(() => (window as any).__oe.getState().play());
  await page.waitForTimeout(4000);
  let s = await takeSamples(page);
  await page.evaluate(() => (window as any).__oe.getState().pause());
  const sl = s.map((x) => x.sl);
  expect(Math.max(...sl)).toBeGreaterThan(300); // it followed
  // no page jumps: one store write is ~1/30 s = 20 px at 600 px/s
  let maxStep = 0;
  for (let i = 1; i < sl.length; i++) maxStep = Math.max(maxStep, Math.abs(sl[i]! - sl[i - 1]!));
  expect(maxStep).toBeLessThan(60);
  expect(reversals(sl)).toBe(0);

  // sideways scroll while playing: never snapped back
  await sc.evaluate((e) => (e.scrollLeft = 0));
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(0));
  await page.evaluate(() => (window as any).__oe.getState().play());
  await page.waitForTimeout(200);
  await takeSamples(page);
  await page.mouse.move(box.x + 500, box.y + 100);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(150, 0);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  s = await takeSamples(page);
  await page.evaluate(() => (window as any).__oe.getState().pause());
  expect(reversals(s.map((x) => x.sl)), JSON.stringify(s.map((x) => x.sl))).toBe(0);
  expect(s[s.length - 1]!.sl).toBeGreaterThan(1000);
  await stopSampler(page);
});

test('editing at the end of a scrolled timeline does not jump the view', async ({ page }) => {
  await setupProject(page, { zoom: 200 });
  const sc = page.locator('.tl-scroller');
  await sc.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  await page.waitForTimeout(300);
  const sl0 = await sc.evaluate((e) => e.scrollLeft);

  // trim the last clip's right edge by 300 px: the edge stays under the mouse
  const last = page.locator('[data-testid="timeline-clip"]').last();
  const lb = (await last.boundingBox())!;
  await page.mouse.move(lb.x + lb.width - 2, lb.y + lb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(lb.x + lb.width - 2 - i * 30, lb.y + lb.height / 2);
  await page.mouse.up();
  const lb2 = (await last.boundingBox())!;
  expect(Math.abs(lb2.x + lb2.width - (lb.x + lb.width - 2 - 300))).toBeLessThan(8);
  expect(await sc.evaluate((e) => e.scrollLeft)).toBe(sl0);

  // delete the last clip: the scroll position is kept
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const m = s.project.tracks.find((t: any) => t.kind === 'main');
    s.deleteClips([m.clips[m.clips.length - 1].id]);
  });
  await page.waitForTimeout(200);
  expect(await sc.evaluate((e) => e.scrollLeft)).toBe(sl0);

  // add tracks above and below: the main track does not move
  await sc.evaluate((e) => (e.scrollLeft = 0));
  const y0 = (await page.locator('.tl-row--main').boundingBox())!.y;
  await page.evaluate(() => (window as any).__oe.getState().addTrack('audio'));
  await page.waitForTimeout(150);
  expect((await page.locator('.tl-row--main').boundingBox())!.y).toBe(y0);
  await page.evaluate(() => (window as any).__oe.getState().addTrack('overlay'));
  await page.waitForTimeout(150);
  expect((await page.locator('.tl-row--main').boundingBox())!.y).toBe(y0);
});

test('zooming keeps the anchor and never paints a frame without the clip under it', async ({ page }) => {
  await setupProject(page, { zoom: 200 });
  const main = (await page.locator('.tl-row--main').boundingBox())!;
  const sc = page.locator('.tl-scroller');
  await sc.evaluate((e) => (e.scrollLeft = 900));
  await page.waitForTimeout(200);
  const ax = main.x + 600;
  await startSampler(page, ax);
  await page.mouse.move(ax, main.y + main.height / 2);
  await page.keyboard.down('Meta');
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(40);
  }
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(40);
  }
  await page.keyboard.up('Meta');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -60);
  await page.keyboard.up('Control');
  await page.waitForTimeout(200);
  const s = await takeSamples(page);
  await stopSampler(page);
  expect(s.filter((x) => !x.underAnchor).length, 'frames with no clip under the zoom anchor').toBe(0);
});

test('an empty timeline does not shake at fractional page zoom (scrollbar toggle loop)', async ({ page }) => {
  // Reported on a Mac with "Show scroll bars: Always": the empty timeline moved up and down
  // without stopping. At a fractional zoom the rows overflowed by a sub-pixel, the scrollbars
  // appeared, the rows were re-fitted, the scrollbars vanished, and so on every frame.
  await openApp(page);
  for (const z of [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25]) {
    await page.evaluate((zz) => {
      document.documentElement.style.zoom = String(zz);
    }, z);
    await page.waitForTimeout(300);
    const states = await page.evaluate(
      () =>
        new Promise<number>((res) => {
          const sc = document.querySelector('.tl-scroller') as HTMLElement;
          const seen = new Set<string>();
          let n = 0;
          const tick = () => {
            seen.add([sc.clientWidth, sc.clientHeight, sc.scrollWidth, sc.scrollHeight, sc.scrollTop].join(','));
            if (++n < 90) requestAnimationFrame(tick);
            else res(seen.size);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(states, `zoom ${z}: scroller geometry must not change while idle`).toBe(1);
  }
});
