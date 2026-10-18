/**
 * Memory regression: an idle editor with media on the timeline must stay flat.
 *
 * Imports the test media, puts every file on the timeline, lets it settle, then idles ~75 s while
 * sampling the JS heap (CDP Performance.getMetrics after a forced GC), the RSS of this browser's
 * process tree, requestAnimationFrame calls and IndexedDB writes. Then it hides the tab and checks
 * that every decoder is released.
 */
import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { importMedia, MEDIA, openApp } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const IDLE_MS = 75_000;
const SAMPLE_MS = 5_000;
/** Kill switch for the machine: abort when this browser's processes pass 3 GB. */
const MAX_RSS_MB = 3000;

/** RSS (MB) of the Chromium process tree started by this worker. */
function browserRssMb(): number {
  const rows = execSync('ps -axo pid=,ppid=,rss=', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number]);
  const ids = new Set<number>([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of rows) if (!ids.has(pid) && ids.has(ppid)) (ids.add(pid), (grew = true));
  }
  ids.delete(process.pid);
  return Math.round(rows.filter(([pid]) => ids.has(pid)).reduce((s, [, , rss]) => s + rss, 0) / 1024);
}

const COUNTERS = `(() => {
  const C = { raf: 0, idbPut: 0 };
  window.__memC = C;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { C.raf++; return raf(cb); };
  for (const name of ['put', 'add']) {
    const orig = IDBObjectStore.prototype[name];
    IDBObjectStore.prototype[name] = function (...a) { C.idbPut++; return orig.apply(this, a); };
  }
})();`;

async function heapMb(page: Page, cdp: any): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const used = metrics.find((m: any) => m.name === 'JSHeapUsedSize').value as number;
  return used / 1048576;
}

test('an idle editor with media stays flat: heap, RSS, no rAF loop, no IndexedDB writes', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(COUNTERS);
  await openApp(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  await importMedia(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.tone, MEDIA.image, MEDIA.silent]);
  await page.evaluate(() => {
    const st = () => (window as any).__oe.getState();
    for (const id of Object.keys(st().project.assets)) {
      const a = st().project.assets[id];
      const end = Math.max(0, ...st().project.tracks.flatMap((t: any) => t.clips.map((c: any) => c.start + c.duration)));
      st().addClip(id, a.kind === 'audio' ? {} : { at: end });
    }
    st().setPlayhead(2_000_000);
  });
  await expect(page.getByTestId('timeline-clip')).toHaveCount(5);
  // let thumbnails, waveforms, the autosave and the release timers settle
  await page.waitForTimeout(8_000);

  const start = { heap: await heapMb(page, cdp), rss: browserRssMb(), c: await page.evaluate(() => ({ ...(window as any).__memC })) };
  const samples: { t: number; heap: number; rss: number }[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < IDLE_MS) {
    await page.waitForTimeout(SAMPLE_MS);
    const s = { t: Math.round((Date.now() - t0) / 1000), heap: await heapMb(page, cdp), rss: browserRssMb() };
    samples.push(s);
    if (s.rss > MAX_RSS_MB) throw new Error(`browser RSS ${s.rss} MB > ${MAX_RSS_MB} MB, aborting`);
  }
  const end = { heap: await heapMb(page, cdp), rss: browserRssMb(), c: await page.evaluate(() => ({ ...(window as any).__memC })) };
  const snap = await page.evaluate(() => (window as any).__oeMem.snapshot());
  console.log('memory idle', JSON.stringify({ start, end, samples, snap }));

  // JS heap flat (after GC) within 5 MB
  expect(end.heap - start.heap).toBeLessThan(5);
  // RSS does not grow while idle (Chromium may release memory, it must not climb)
  expect(Math.max(...samples.map((s) => s.rss)) - start.rss).toBeLessThan(150);
  // no animation loop while paused, no storage writes while idle
  expect(end.c.raf - start.c.raf).toBeLessThanOrEqual(2);
  expect(end.c.idbPut - start.c.idbPut).toBe(0);
  // only what the current frame needs is alive: one video, no audio voices, no thumbnail grabber
  expect(snap.preview.videos).toBeLessThanOrEqual(1);
  expect(snap.preview.voices).toBe(0);
  expect(snap.grabbers).toBe(0);
  expect(snap.caches.filmstrip.bytes).toBeLessThanOrEqual(150 * 1024 * 1024);

  // hidden tab → every decoder released, nothing scheduled
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = await page.evaluate(() => (window as any).__oeMem.snapshot());
  expect(hidden.preview).toMatchObject({ videos: 0, images: 0, voices: 0, looping: false });
  const rafHidden = await page.evaluate(() => (window as any).__memC.raf);
  await page.waitForTimeout(3_000);
  expect(await page.evaluate(() => (window as any).__memC.raf)).toBe(rafHidden);

  // visible again → the frame is drawn again (one video for the clip under the playhead)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await page.evaluate(() => (window as any).__oeMem.snapshot())).preview.videos).toBe(1);
});

test('after playback, every off-screen decoder is released while paused', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(COUNTERS);
  await openApp(page);
  await importMedia(page, [MEDIA.vertical, MEDIA.landscape, MEDIA.tone]);
  await page.evaluate(() => {
    const st = () => (window as any).__oe.getState();
    for (const id of Object.keys(st().project.assets)) {
      const a = st().project.assets[id];
      const end = Math.max(0, ...st().project.tracks.flatMap((t: any) => t.clips.map((c: any) => c.start + c.duration)));
      st().addClip(id, a.kind === 'audio' ? {} : { at: end });
    }
    st().setPlayhead(4_000_000);
  });
  await page.getByTestId('play-button').click();
  await page.waitForTimeout(3_000); // crosses the cut into the second clip
  await page.evaluate(() => (window as any).__oe.getState().pause());
  const rafAtPause = await page.evaluate(() => (window as any).__memC.raf);
  await page.waitForTimeout(6_000);
  const snap = await page.evaluate(() => (window as any).__oeMem.snapshot());
  expect(snap.preview.videos).toBeLessThanOrEqual(1);
  expect(snap.preview.voices).toBe(0);
  expect(snap.preview.looping).toBe(false);
  // a couple of one-shot renders after the pause (seek landing), never a loop
  expect((await page.evaluate(() => (window as any).__memC.raf)) - rafAtPause).toBeLessThan(10);
});
