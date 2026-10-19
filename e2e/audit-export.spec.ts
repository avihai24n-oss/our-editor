/**
 * Functional audit of EXPORT: does the downloaded MP4 really match the project?
 *
 * Each test builds a project through the store (window.__oe), exports it through the real Export
 * dialog, and measures the file with ffprobe/ffmpeg:
 *  - container: duration, exact frame count, fps, resolution per ratio × resolution, H.264
 *    profile, AAC 48 kHz stereo, A/V sync (flash frame + beep at 1.000 s, see 04-export-spike.md);
 *  - pictures: the source frame number is burnt into the test video as a barcode, so every
 *    exported frame says which source frame it shows; the same time is rendered in the preview
 *    canvas and compared (mean-abs-diff / PSNR) against the decoded export frame;
 *  - sound: RMS per window of the decoded PCM (volume, fades, mute, speed, extract, mixing);
 *  - robustness: cancel, two exports in a row, undo, a 60 s project's memory, WebM fallback.
 *
 * Every measurement is printed as `AUDIT {...}` and collected in
 * e2e/test-results/audit-export-results.json (the numbers in docs/AUDIT-export.md come from there).
 * Exported files are deleted after measuring.
 *
 * Run alone: cd e2e && E2E_PORT=5180 npx playwright test audit-export.spec.ts
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AM,
  amPath,
  compare,
  decodeAudio,
  ensureAuditMedia,
  imageRgb,
  lastLoudSample,
  lum,
  meanRgb,
  onsetSample,
  peakAbs,
  probeStreams,
  readBarcode,
  referenceRgb,
  rmsDb,
  videoFrame,
  volumedetect,
  zeroCrossHz,
  type Pcm,
} from './audit-helpers';
import { DOWNLOADS_DIR, mediaPath, openApp, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(here, 'test-results', 'audit-export-results.json');
const TMP = path.join(here, 'test-results', 'audit-tmp');

// ---------------------------------------------------------------- tolerances
/** Preview canvas vs decoded export frame, both scaled to 1/12 of the project size. */
const MAX_MAD = 6; // mean abs diff, 0..255
const MIN_PSNR = 28; // dB
/** A/V sync: beep onset vs the flash frame time. */
const MAX_SYNC_MS = 2;
/** Level checks on decoded AAC. */
const DB_TOL = 0.5;
/** Max extra length of the AAC stream past the project end (encoder flush, 1344 samples measured). */
const AAC_TAIL_S = 0.03;

const S = (sec: number) => Math.round(sec * 1e6);

function record(item: string, data: Record<string, unknown>) {
  const row = { item, ...data };
  console.log('AUDIT', JSON.stringify(row));
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  const all = fs.existsSync(RESULTS) ? (JSON.parse(fs.readFileSync(RESULTS, 'utf8')) as unknown[]) : [];
  all.push(row);
  fs.writeFileSync(RESULTS, JSON.stringify(all, null, 1));
}

const exported: string[] = [];
function cleanup() {
  for (const f of exported.splice(0)) fs.rmSync(f, { force: true });
}

// ---------------------------------------------------------------- page side

async function resetProject(page: Page, aspect: string = '9:16') {
  await page.evaluate((aspect) => {
    const s = (window as any).__oe.getState();
    const assets = Object.values(s.project.assets);
    s.newProject({ aspect });
    s.addAssets(assets);
    s.setMagnet(true);
  }, aspect);
}

/** Runs `fn(store, idOf)` in the page; idOf(name) → asset id. */
async function build<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    ({ fn, arg }) => {
      const st = () => (window as any).__oe.getState();
      const idOf = (name: string) => {
        const a = Object.values(st().project.assets).find((x: any) => x.name === name) as any;
        if (!a) throw new Error(`asset ${name} not imported`);
        return a.id;
      };
      // eslint-disable-next-line no-new-func
      return new Function('st', 'idOf', 'arg', `return (${fn})(st, idOf, arg)`)(st, idOf, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

async function projectJson(page: Page): Promise<any> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__oe.getState().project)));
}

const projectDurationUs = (p: any): number => Math.max(0, ...p.tracks.flatMap((t: any) => t.clips.map((c: any) => c.start + c.duration)));

interface ExportOut {
  file: string;
  ms: number;
}

async function doExport(page: Page, o: { resolution?: string; fps?: number } = {}): Promise<ExportOut> {
  await page.mouse.move(5, 5); // keep the preview axis (hover line) off the timeline
  await page.getByTestId('export-button').click();
  const dlg = page.getByTestId('export-dialog');
  await expect(dlg).toBeVisible();
  await page.getByTestId('export-resolution').selectOption(o.resolution ?? '720p');
  await page.getByTestId('export-fps').selectOption(String(o.fps ?? 30));
  const t0 = Date.now();
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 300_000);
  const ms = Date.now() - t0;
  exported.push(file);
  await expect(dlg.getByText(/Exported/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  return { file, ms };
}

/** Renders time t in the paused preview and saves the player canvas as PNG. */
async function previewPng(page: Page, tUs: number, name: string): Promise<string> {
  await page.mouse.move(5, 5);
  await page.evaluate((t) => {
    const s = (window as any).__oe.getState();
    s.pause();
    s.clearSelection();
    s.setPreviewTime(null);
    s.setPlayhead(t);
  }, tUs);
  let prev = '';
  let stable = 0;
  await page.waitForTimeout(250);
  for (let i = 0; i < 40; i++) {
    const d = await page.evaluate(() => (document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement).toDataURL('image/png'));
    if (d === prev) {
      if (++stable >= 2) break;
    } else stable = 0;
    prev = d;
    await page.waitForTimeout(200);
  }
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(prev.split(',')[1]!, 'base64'));
  return file;
}

/** Comparison size: 1/12 of the project canvas. */
const cmpSize = (p: any) => ({ w: Math.round(p.settings.width / 12), h: Math.round(p.settings.height / 12) });

/** Expected v-code source frame on the main track at timeline t (null = no clip). −1 = flash. */
function expectedCodeFrame(p: any, tUs: number, trackKind = 'main'): number | null {
  const tr = p.tracks.find((t: any) => t.kind === trackKind);
  const c = tr?.clips.find((c: any) => tUs >= c.start && tUs < c.start + c.duration);
  if (!c) return null;
  const asset = p.assets[c.assetId];
  const src = Math.min(Math.max(0, Math.round(c.inPoint + (tUs - c.start) * c.speed)), asset.duration - 1);
  const f = Math.min(179, Math.floor(((src + 1) * 30) / 1e6));
  return f === 30 ? -1 : f;
}

/** Preview vs export at one time: barcode of both + MAD/PSNR. */
async function checkFrame(page: Page, file: string, p: any, tUs: number, fps: number, label: string, opts: { barcode?: boolean; box?: { x: number; y: number; w: number; h: number } } = {}) {
  const { w, h } = cmpSize(p);
  const n = Math.round((tUs * fps) / 1e6);
  tUs = Math.round((n * 1e6) / fps); // the exact time of the exported frame
  const exp = videoFrame(file, n, w, h);
  const prv = imageRgb(await previewPng(page, tUs, `${label}-${n}`), w, h);
  const c = compare(exp, prv);
  const row: Record<string, unknown> = { t: tUs / 1e6, frame: n, mad: +c.mad.toFixed(2), psnr: +c.psnr.toFixed(1) };
  if (opts.barcode !== false) {
    const big = videoFrame(file, n, w * 2, h * 2);
    const prvBig = imageRgb(path.join(TMP, `${label}-${n}.png`), w * 2, h * 2);
    row.expected = expectedCodeFrame(p, tUs);
    row.exportCode = readBarcode(big, opts.box);
    row.previewCode = readBarcode(prvBig, opts.box);
  }
  record(label, row);
  expect.soft(c.mad, `${label} t=${tUs / 1e6}: preview vs export MAD`).toBeLessThanOrEqual(MAX_MAD);
  expect.soft(c.psnr, `${label} t=${tUs / 1e6}: preview vs export PSNR`).toBeGreaterThanOrEqual(MIN_PSNR);
  if (opts.barcode !== false) {
    expect.soft(row.exportCode, `${label} t=${tUs / 1e6}: export shows the right source frame`).toBe(row.expected);
    expect.soft(row.previewCode, `${label} t=${tUs / 1e6}: preview shows the right source frame`).toBe(row.expected);
  }
  return { exp, prv, ...c };
}

// ---------------------------------------------------------------- RSS

function treeRssMb(): number {
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

// ---------------------------------------------------------------- shared page

let page: Page;

async function freshPage(browser: Browser, init?: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const pg = await ctx.newPage();
  if (init) await pg.addInitScript(init);
  pg.on('pageerror', (e) => console.log('pageerror', e.message));
  await openApp(pg);
  await pg.getByTestId('media-import-input').setInputFiles([AM.code, AM.codeTone, AM.a440, AM.a1k, AM.loud, AM.click, AM.quad, AM.colorHd601, AM.colorSdUntagged].map(amPath));
  await expect.poll(() => pg.evaluate(() => Object.keys((window as any).__oe.getState().project.assets).length), { timeout: 30_000 }).toBe(9);
  return pg;
}

test.describe('export audit', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async ({ browser }) => {
    ensureAuditMedia();
    fs.rmSync(RESULTS, { force: true });
    page = await freshPage(browser);
  });
  test.afterEach(() => cleanup());
  test.afterAll(async () => {
    cleanup();
    await page?.context().close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  // ============================================================ container

  test('container: 3 s project → 90 frames, H.264 High 720×1280 30 fps, AAC 48 kHz stereo, A/V sync', async () => {
    await resetProject(page);
    await build(page, `(st, idOf) => { const c = st().addClip(idOf('${AM.code}'), { at: 0 }); st().trimEnd(c, 3e6); }`);
    const p = await projectJson(page);
    expect(projectDurationUs(p)).toBe(S(3));
    const { file, ms } = await doExport(page, { resolution: '720p', fps: 30 });
    const f = probeStreams(file);
    record('container 30fps', { ms, ...f });
    expect(f.v).toMatchObject({ codec: 'h264', profile: 'High', width: 720, height: 1280, fps: 30, frames: 90 });
    expect(Math.abs(f.v!.duration - 3)).toBeLessThan(1e-3);
    expect(f.a).toMatchObject({ codec: 'aac', profile: 'LC', sampleRate: 48000, channels: 2 });
    expect(f.formatDuration - 3).toBeGreaterThanOrEqual(-1e-3);
    // the AAC encoder's flush tail (silent) makes the audio stream up to ~1344 samples longer
    expect(f.formatDuration - 3).toBeLessThanOrEqual(AAC_TAIL_S);
    expect(Math.abs(f.a!.duration - 3)).toBeLessThanOrEqual(AAC_TAIL_S);

    // flash frame + beep at 1.000 s
    const small = (n: number) => readBarcode(videoFrame(file, n, 90, 160));
    const codes = [29, 30, 31].map(small);
    const pcm = decodeAudio(file);
    const onset = onsetSample(pcm, 0.2);
    const src = onsetSample(decodeAudio(amPath(AM.code)), 0.2); // onset in the source itself (sine starts at 0)
    record('A/V sync (embedded AAC beep)', { codes29_30_31: codes, beepOnsetSample: onset, sourceOnsetSample: src, offsetMs: ((onset - src) / 48).toFixed(3) });
    expect(codes).toEqual([29, -1, 31]);
    expect(Math.abs(onset - src) / 48).toBeLessThanOrEqual(MAX_SYNC_MS);

    // frames vs preview
    for (const t of [0, 0.5, 1.5, 2.9]) await checkFrame(page, file, p, S(t), 30, 'plain clip');
  });

  test('container: 24 / 25 / 50 / 60 fps → exact frame count and the flash on the frame at 1.000 s', async () => {
    await resetProject(page);
    await build(page, `(st, idOf) => { const c = st().addClip(idOf('${AM.code}'), { at: 0 }); st().trimEnd(c, 2e6); }`);
    for (const fps of [24, 25, 50, 60]) {
      const { file, ms } = await doExport(page, { resolution: '720p', fps });
      const f = probeStreams(file);
      const flash = readBarcode(videoFrame(file, fps, 90, 160));
      const before = readBarcode(videoFrame(file, fps - 1, 90, 160));
      const pcm = decodeAudio(file);
      const onset = onsetSample(pcm, 0.2);
      record(`fps ${fps}`, { ms, frames: f.v!.frames, fps: f.v!.fps, vdur: f.v!.duration, flashFrameCode: flash, frameBeforeCode: before, beepOnsetMs: (onset / 48).toFixed(2) });
      expect.soft(f.v!.frames).toBe(2 * fps);
      expect.soft(f.v!.fps).toBeCloseTo(fps, 3);
      expect.soft(Math.abs(f.v!.duration - 2)).toBeLessThan(1e-3);
      expect.soft(flash, `frame ${fps} (t=1.000) is the flash`).toBe(-1);
      expect.soft(before).not.toBe(-1);
      expect.soft(Math.abs(onset / 48 - 1000 - 2 / 48)).toBeLessThanOrEqual(MAX_SYNC_MS);
      cleanup();
    }
  });

  test('container: every ratio × 720p/1080p/2K/4K has the right size; letterbox bars are black', async () => {
    const want: Record<string, Record<string, [number, number]>> = {
      '9:16': { '720p': [720, 1280], '1080p': [1080, 1920], '2k': [1440, 2560], '4k': [2160, 3840] },
      '16:9': { '720p': [1280, 720], '1080p': [1920, 1080], '2k': [2560, 1440], '4k': [3840, 2160] },
      '1:1': { '720p': [720, 720], '1080p': [1080, 1080], '2k': [1440, 1440], '4k': [2160, 2160] },
      '4:5': { '720p': [720, 900], '1080p': [1080, 1350], '2k': [1440, 1800], '4k': [2160, 2700] },
      '3:4': { '720p': [720, 960], '1080p': [1080, 1440], '2k': [1440, 1920], '4k': [2160, 2880] },
    };
    for (const aspect of Object.keys(want)) {
      await resetProject(page, aspect);
      await build(page, `(st, idOf) => { const c = st().addClip(idOf('${AM.code}'), { at: 0 }); st().trimEnd(c, 0.5e6); }`);
      const p = await projectJson(page);
      for (const res of ['720p', '1080p', '2k', '4k']) {
        const { file, ms } = await doExport(page, { resolution: res, fps: 30 });
        const f = probeStreams(file);
        const [W, H] = want[aspect]![res]!;
        const row: Record<string, unknown> = { ms, size: `${f.v?.width}x${f.v?.height}`, want: `${W}x${H}`, profile: f.v?.profile, frames: f.v?.frames };
        if (res === '720p') {
          // the 540×960 source is contain-fitted: pillarbox (or none for 9:16)
          const img = videoFrame(file, 7, Math.round(W / 4), Math.round(H / 4));
          const k = Math.min(W / 540, H / 960);
          const bw = (540 * k) / W;
          const box = { x: (1 - bw) / 2, y: 0, w: bw, h: 1 };
          row.contentWidthFrac = +bw.toFixed(3);
          row.code = readBarcode(img, box);
          if (bw < 0.98) {
            row.leftBar = +lum(meanRgb(img, 0, 0, box.x * 0.8, 1)).toFixed(1);
            row.rightBar = +lum(meanRgb(img, 1 - box.x * 0.8, 0, 1, 1)).toFixed(1);
            expect.soft(row.leftBar as number, `${aspect} left bar black`).toBeLessThan(4);
            expect.soft(row.rightBar as number, `${aspect} right bar black`).toBeLessThan(4);
          }
          expect.soft(row.code, `${aspect} picture in the right place`).toBe(7);
          await checkFrame(page, file, p, Math.round((7 * 1e6) / 30), 30, `ratio ${aspect}`, { box });
        }
        record(`ratio ${aspect} ${res}`, row);
        expect.soft([f.v?.width, f.v?.height], `${aspect} ${res}`).toEqual([W, H]);
        expect.soft(f.v?.frames).toBe(15);
        cleanup();
      }
    }
  });

  // ============================================================ pictures

  test('pictures: split + trim start + trim end → the right source frames', async () => {
    await resetProject(page);
    await build(
      page,
      `(st, idOf) => {
        const a = st().addClip(idOf('${AM.code}'), { at: 0 });
        const b = st().splitClip(a, 1e6);           // a: 0–1 s, b: 1–6 s
        st().trimStart(b, 2e6);                      // drop source 1–2 s of b (magnet ripples it to 1 s)
        st().trimEnd(b, st().project.tracks.find(t => t.kind === 'main').clips[1].start + 1.5e6);
      }`,
    );
    const p = await projectJson(page);
    const clips = p.tracks.find((t: any) => t.kind === 'main').clips.map((c: any) => ({ start: c.start, duration: c.duration, inPoint: c.inPoint }));
    record('split/trim layout', { clips });
    const { file } = await doExport(page);
    expect(probeStreams(file).v!.frames).toBe(Math.ceil((projectDurationUs(p) * 30) / 1e6 - 1e-6));
    for (const t of [0.5, 0.95, 1.0, 1.4, 2.4]) await checkFrame(page, file, p, S(t), 30, 'split+trim');
  });

  test('pictures: speed 2× and 0.5× → source frames advance at the clip speed', async () => {
    await resetProject(page);
    await build(
      page,
      `(st, idOf) => {
        const a = st().addClip(idOf('${AM.code}'), { at: 0 });
        st().trimEnd(a, 2e6);
        st().setSpeed(a, 2);                         // 0–1 s on the timeline, source 0–2 s
        const b = st().addClip(idOf('${AM.code}'), { at: 1e6 });
        st().trimEnd(b, 2e6);                        // b: 1–2 s (source 0–1 s)
        st().setSpeed(b, 0.5);                       // 1–3 s on the timeline
      }`,
    );
    const p = await projectJson(page);
    record('speed layout', { clips: p.tracks.find((t: any) => t.kind === 'main').clips.map((c: any) => ({ start: c.start, duration: c.duration, speed: c.speed })) });
    const { file } = await doExport(page);
    for (const t of [0.25, 0.75, 1.5, 2.5]) await checkFrame(page, file, p, S(t), 30, 'speed');
  });

  test('pictures: a gap is black; an image clip draws its pixels', async () => {
    await resetProject(page);
    await build(
      page,
      `(st, idOf) => {
        const c = st().addClip(idOf('${AM.code}'), { at: 1e6, kind: 'overlay' }); // nothing on main before 1 s
        st().trimEnd(c, 2e6);
        const i = st().addClip(idOf('${AM.quad}'), { at: 0 });                    // image on main 0–…
        st().trimEnd(i, 0.5e6);                                                   // image 0–0.5 s, gap 0.5–1 s
      }`,
    );
    const p = await projectJson(page);
    const { file } = await doExport(page);
    const gap = videoFrame(file, 22, 90, 160); // t = 0.733 s
    const gapLum = lum(meanRgb(gap, 0, 0, 1, 1));
    const img = videoFrame(file, 6, 90, 160); // t = 0.2 s: the square image, contain-fitted (centred band)
    const tl = meanRgb(img, 0.1, 0.25, 0.4, 0.45);
    const br = meanRgb(img, 0.6, 0.55, 0.9, 0.75);
    const above = lum(meanRgb(img, 0, 0, 1, 0.2));
    record('gap + image', { gapLum: +gapLum.toFixed(2), imageTopLeft: tl.map(Math.round), imageBottomRight: br.map(Math.round), barAboveImage: +above.toFixed(1) });
    expect.soft(gapLum, 'gap is black').toBeLessThan(2);
    expect.soft(tl[0]).toBeGreaterThan(200);
    expect.soft(tl[1]).toBeLessThan(40);
    expect.soft(Math.min(...br)).toBeGreaterThan(200);
    expect.soft(above, 'letterbox above the image is black').toBeLessThan(4);
    await checkFrame(page, file, p, S(0.2), 30, 'image clip', { barcode: false });
    await checkFrame(page, file, p, S(22 / 30), 30, 'gap', { barcode: false });
    await checkFrame(page, file, p, S(1.5), 30, 'overlay after gap', { barcode: false });
    const code = readBarcode(videoFrame(file, 45, 180, 320));
    expect.soft(code, 'overlay clip from 1 s shows source frame 15 at 1.5 s').toBe(15);
  });

  test('pictures: overlay with opacity + blend, a hidden track is absent (but still heard)', async () => {
    await resetProject(page);
    const ids = await build<{ ov: string; hid: string }>(
      page,
      `(st, idOf) => {
        const m = st().addClip(idOf('${AM.code}'), { at: 0 });
        st().trimEnd(m, 2e6);
        const o = st().addClip(idOf('${AM.quad}'), { at: 0, kind: 'overlay' });
        st().trimEnd(o, 1e6);
        st().updateClip(o, { transform: { scale: 0.5, x: 0, y: -400 }, blend: 'screen' });
        st().updateClip(o, { transform: { opacity: 0.6 } });
        const h = st().addClip(idOf('${AM.codeTone}'), { at: 0, kind: 'overlay' });
        st().trimEnd(h, 2e6);
        st().updateClip(h, { transform: { scale: 0.4, y: 500 } });
        const ht = st().project.tracks.find(t => t.clips.some(c => c.id === h)).id;
        st().setTrack(ht, { hidden: true });
        st().updateClip(m, { audio: { muted: true } });
        return { ov: o, hid: h };
      }`,
    );
    const p = await projectJson(page);
    const { file } = await doExport(page);
    // with the hidden overlay absent, the barcode band in the middle is the main clip only
    const r1 = await checkFrame(page, file, p, S(0.5), 30, 'overlay screen 60%');
    const r2 = await checkFrame(page, file, p, S(1.5), 30, 'hidden track');
    // the overlay really changed pixels where it sits (top half), and the hidden one did not (bottom)
    const big = videoFrame(file, 15, 90, 160);
    const clean = videoFrame(file, 45, 90, 160);
    const top = Math.abs(lum(meanRgb(big, 0.3, 0.2, 0.7, 0.35)) - lum(meanRgb(clean, 0.3, 0.2, 0.7, 0.35)));
    const bottom = Math.abs(lum(meanRgb(big, 0.3, 0.7, 0.7, 0.85)) - lum(meanRgb(clean, 0.3, 0.7, 0.7, 0.85)));
    const pcm = decodeAudio(file);
    const hz = zeroCrossHz(pcm, 0.2, 1.8);
    const lvl = rmsDb(pcm, 0.2, 1.8);
    record('overlay/hidden', { ids, overlayDeltaTop: +top.toFixed(1), hiddenDeltaBottom: +bottom.toFixed(1), hiddenTrackAudioHz: +hz.toFixed(1), hiddenTrackAudioDb: +lvl.toFixed(2), r1: [r1.mad, r1.psnr], r2: [r2.mad, r2.psnr] });
    expect.soft(top, 'overlay visible').toBeGreaterThan(20);
    expect.soft(bottom, 'hidden overlay absent').toBeLessThan(3);
    expect.soft(Math.abs(hz - 660), 'hidden track still sounds (660 Hz)').toBeLessThan(10);
  });

  test('pictures: filter + adjust, text with stroke/background/shadow', async () => {
    await resetProject(page);
    await build(
      page,
      `(st, idOf) => {
        const m = st().addClip(idOf('${AM.code}'), { at: 0 });
        st().trimEnd(m, 2e6);
        st().updateClip(m, { filter: { id: 'vintage', intensity: 0.8 }, adjust: { brightness: 15, contrast: 20, saturation: -20, temperature: 30, tint: -10, fade: 20, vignette: 60 } });
        const t = st().addTextClip({ at: 0, content: 'AUDIT 123\\nsecond line' });
        st().updateClip(t, { text: { fontSize: 110, color: '#ffdd00', bold: true, stroke: { enabled: true, color: '#000000', width: 6 }, background: { enabled: true, color: '#3050ff', opacity: 0.6 }, shadow: { enabled: true, color: '#000000', blur: 8, offsetX: 6, offsetY: 6 } }, transform: { y: -500, rotation: 8 } });
        st().trimEnd(t, 2e6);
      }`,
    );
    const p = await projectJson(page);
    const { file } = await doExport(page);
    for (const t of [0.4, 1.6]) await checkFrame(page, file, p, S(t), 30, 'filter+adjust+text', { barcode: false });
  });

  test('pictures: in/out animations and transitions (mix, wipe, slide, fade-black) match the preview', async () => {
    await resetProject(page);
    const tr = await build<string[]>(
      page,
      `(st, idOf) => {
        const ids = [];
        for (let i = 0; i < 4; i++) { const c = st().addClip(idOf(i % 2 ? '${AM.codeTone}' : '${AM.code}'), { at: i * 1.5e6 }); st().trimEnd(c, (i + 1) * 1.5e6); ids.push(c); }
        const out = [];
        out.push(st().addTransition(ids[0], 'mix', 0.6e6));
        out.push(st().addTransition(ids[1], 'wipe-left', 0.6e6));
        out.push(st().addTransition(ids[2], 'slide-up', 0.6e6));
        st().setAnimation(ids[0], 'in', 'zoom-in', 0.8e6);
        st().setAnimation(ids[3], 'out', 'slide-left', 0.6e6);
        const t = st().addTextClip({ at: 0, content: 'Rotate in' });
        st().setAnimation(t, 'in', 'rotate', 1e6);
        return out;
      }`,
    );
    const p = await projectJson(page);
    record('transitions layout', { transitions: tr, main: p.tracks.find((t: any) => t.kind === 'main').clips.map((c: any) => [c.start, c.duration]) });
    const { file } = await doExport(page);
    for (const t of [0.2, 0.5, 1.4, 1.6, 2.9, 3.1, 4.4, 4.6, 5.7]) await checkFrame(page, file, p, S(t), 30, 'anim+transition', { barcode: false });
  });

  test('pictures: saturated colours match ffmpeg in preview AND export (BT.601-tagged HD, untagged SD)', async () => {
    await resetProject(page, '16:9');
    await build(
      page,
      `(st, idOf) => {
        const a = st().addClip(idOf('${AM.colorHd601}'), { at: 0 });
        st().trimEnd(a, 0.5e6);
        const b = st().addClip(idOf('${AM.colorSdUntagged}'), { at: 0.5e6 });
        st().trimEnd(b, 1e6);
      }`,
    );
    const p = await projectJson(page);
    const { file } = await doExport(page, { resolution: '720p', fps: 30 });
    // smptebars, top band: 0.54 = green… 0.70 = magenta, 0.82 = red, 0.96 = blue (75 % bars)
    const bars: [string, number][] = [['yellow', 0.21], ['cyan', 0.36], ['green', 0.5], ['magenta', 0.64], ['red', 0.79], ['blue', 0.93]];
    for (const [src, frame, label] of [[AM.colorHd601, 6, 'HD 601-matrix'], [AM.colorSdUntagged, 21, 'SD untagged']] as const) {
      const exp = videoFrame(file, frame, 320, 180);
      const prv = imageRgb(await previewPng(page, Math.round((frame * 1e6) / 30), `color-${frame}`), 320, 180);
      const rows = bars.map(([name, x]) => {
        const ref = referenceRgb(amPath(src), x, 0.3, 'bt601');
        const e = meanRgb(exp, x - 0.015, 0.27, x + 0.015, 0.33).map(Math.round);
        const v = meanRgb(prv, x - 0.015, 0.27, x + 0.015, 0.33).map(Math.round);
        const err = (a: number[]) => Math.max(...a.map((c, i) => Math.abs(c - ref[i]!)));
        return { bar: name, ref, export: e, preview: v, exportErr: err(e), previewErr: err(v) };
      });
      record(`colour ${label}`, { rows });
      for (const r of rows) {
        expect.soft(r.exportErr, `${label} ${r.bar}: export vs ffmpeg BT.601`).toBeLessThanOrEqual(8);
        expect.soft(r.previewErr, `${label} ${r.bar}: preview vs ffmpeg BT.601`).toBeLessThanOrEqual(8);
      }
    }
    void p;
  });

  // ============================================================ sound

  const REF_DB = -15.05; // amplitude 0.25 sine, stereo

  test('sound: per-clip volume dB changes the level; −60 dB is silent', async () => {
    await resetProject(page);
    const vols = [0, -6, 6, -12, -60];
    await build(
      page,
      `(st, idOf, vols) => {
        let tr;
        vols.forEach((v, i) => {
          const c = st().addClip(idOf('${AM.a440}'), tr ? { at: i * 1e6, trackId: tr } : { at: 0 });
          tr = tr ?? st().project.tracks.find(t => t.clips.some(x => x.id === c)).id;
          st().trimEnd(c, (i + 1) * 1e6);
          st().updateClip(c, { audio: { volumeDb: v } });
        });
      }`,
      vols,
    );
    const { file } = await doExport(page);
    const pcm = decodeAudio(file);
    const rows = vols.map((v, i) => ({ volumeDb: v, expectedDb: v <= -60 ? -120 : +(REF_DB + v).toFixed(2), measuredDb: +rmsDb(pcm, i + 0.1, i + 0.9).toFixed(2), volumedetectMean: volumedetect(file, i + 0.1, i + 0.9).mean }));
    record('volume', { rows });
    for (const r of rows) {
      if (r.volumeDb <= -60) expect.soft(r.measuredDb, 'volume −60 dB is silence').toBeLessThan(-80);
      else expect.soft(Math.abs(r.measuredDb - r.expectedDb), `volume ${r.volumeDb} dB`).toBeLessThanOrEqual(DB_TOL);
    }
  });

  test('sound: fade in / fade out ramp linearly in gain', async () => {
    await resetProject(page);
    await build(
      page,
      `(st, idOf) => {
        const c = st().addClip(idOf('${AM.a440}'), { at: 0 });
        st().trimEnd(c, 3e6);
        st().updateClip(c, { audio: { fadeIn: 1e6, fadeOut: 1e6 } });
      }`,
    );
    const { file } = await doExport(page);
    const pcm = decodeAudio(file);
    const pts = [0.25, 0.5, 0.75, 1.5, 2.25, 2.5, 2.75].map((t) => {
      const g = Math.min(1, t, 3 - t);
      return { t, expectedDb: +(REF_DB + 20 * Math.log10(g)).toFixed(2), measuredDb: +rmsDb(pcm, t - 0.025, t + 0.025).toFixed(2) };
    });
    const first = rmsDb(pcm, 0, 0.01);
    const last = rmsDb(pcm, 2.99, 3.0);
    record('fades', { pts, first10ms: +first.toFixed(1), last10ms: +last.toFixed(1) });
    for (const q of pts) expect.soft(Math.abs(q.measuredDb - q.expectedDb), `fade at ${q.t}s`).toBeLessThanOrEqual(1);
    expect.soft(first).toBeLessThan(-45);
    expect.soft(last).toBeLessThan(-45);
  });

  test('sound: a muted clip and a muted track are silent; other tracks still play', async () => {
    await resetProject(page);
    await build(
      page,
      `(st, idOf) => {
        const v = st().addClip(idOf('${AM.codeTone}'), { at: 0 });        // 660 Hz on main…
        st().setTrack(st().project.tracks.find(t => t.kind === 'main').id, { muted: true }); // …muted track
        const a = st().addClip(idOf('${AM.a440}'), { at: 0 });
        st().trimEnd(a, 2e6);
        st().updateClip(a, { audio: { muted: true } });                     // muted clip 0–2 s
        const b = st().addClip(idOf('${AM.a1k}'), { at: 2e6 });
        st().trimEnd(b, 4e6);                                               // audible 1 kHz 2–4 s
      }`,
    );
    const { file } = await doExport(page);
    const pcm = decodeAudio(file);
    const silent = rmsDb(pcm, 0.05, 1.95);
    const hz = zeroCrossHz(pcm, 2.1, 3.9);
    const lvl = rmsDb(pcm, 2.1, 3.9);
    const tail = rmsDb(pcm, 4.0, 4.03); // the AAC flush tail past the project end
    record('mute', { silentDb_0_2: +silent.toFixed(1), audibleHz_2_4: +hz.toFixed(1), audibleDb_2_4: +lvl.toFixed(2), tailDbAfterEnd: +tail.toFixed(1), samples: pcm.left.length });
    expect.soft(tail, 'nothing audible after the project end').toBeLessThan(-50);
    expect.soft(silent, 'muted clip + muted track are silent').toBeLessThan(-80);
    expect.soft(Math.abs(hz - 1000)).toBeLessThan(10);
    expect.soft(Math.abs(lvl - REF_DB)).toBeLessThanOrEqual(DB_TOL);
  });

  test('sound: speed changes the audio duration (2× and 0.5×)', async () => {
    await resetProject(page);
    await build(
      page,
      `(st, idOf) => {
        const a = st().addClip(idOf('${AM.a440}'), { at: 0 });
        st().trimEnd(a, 2e6); st().setSpeed(a, 2);                          // 0–1 s
        const tr = st().project.tracks.find(t => t.clips.some(x => x.id === a)).id;
        const b = st().addClip(idOf('${AM.a440}'), { at: 2e6, trackId: tr });
        st().trimEnd(b, 3e6); st().setSpeed(b, 0.5);                        // 2–4 s
        const v = st().addClip(idOf('${AM.code}'), { at: 0 }); st().updateClip(v, { audio: { muted: true } });
        st().trimEnd(v, 4.5e6);
      }`,
    );
    const p = await projectJson(page);
    const at = p.tracks.find((t: any) => t.kind === 'audio').clips.map((c: any) => [c.start, c.duration, c.speed, c.preservePitch]);
    const { file } = await doExport(page);
    const pcm = decodeAudio(file);
    const loudA = [onsetSample(pcm, 0.05) / 48000];
    const gapDb = rmsDb(pcm, 1.05, 1.95);
    const onB = onsetSample(pcm, 0.05, 1.5) / 48000;
    const endB = lastLoudSample(pcm, 0.05) / 48000;
    let endA = 0;
    for (let i = Math.floor(0.9 * 48000); i < 1.2 * 48000; i++) if (Math.abs(pcm.left[i]!) >= 0.05) endA = i / 48000;
    const hzA = zeroCrossHz(pcm, 0.1, 0.9);
    const hzB = zeroCrossHz(pcm, 2.2, 3.8);
    record('speed audio', { clips: at, startA: loudA[0], endA, gapDb: +gapDb.toFixed(1), startB: onB, endB, hzA: +hzA.toFixed(1), hzB: +hzB.toFixed(1), levelA: +rmsDb(pcm, 0.1, 0.9).toFixed(2), levelB: +rmsDb(pcm, 2.2, 3.8).toFixed(2) });
    expect.soft(Math.abs(endA - 1), '2× clip lasts 1 s').toBeLessThan(0.01);
    expect.soft(gapDb).toBeLessThan(-80);
    expect.soft(Math.abs(onB - 2)).toBeLessThan(0.01);
    expect.soft(Math.abs(endB - 4), '0.5× clip lasts 2 s').toBeLessThan(0.01);
    // pitch: "Change audio pitch" is off by default (preservePitch true) → the tone stays at 440 Hz
    expect.soft(Math.abs(hzA - 440), '2× keeps the pitch (preservePitch)').toBeLessThan(15);
    expect.soft(Math.abs(hzB - 440), '0.5× keeps the pitch (preservePitch)').toBeLessThan(15);
    expect.soft(Math.abs(rmsDb(pcm, 0.1, 0.9) - REF_DB), '2× keeps the level').toBeLessThanOrEqual(1);
    expect.soft(Math.abs(rmsDb(pcm, 2.2, 3.8) - REF_DB), '0.5× keeps the level').toBeLessThanOrEqual(1);
  });

  test('sound: extracted audio (audioLink) is not doubled; the beep stays in sync', async () => {
    await resetProject(page);
    await build(page, `(st, idOf) => { const v = st().addClip(idOf('${AM.codeTone}'), { at: 0 }); st().trimEnd(v, 2e6); }`);
    const plain = await doExport(page);
    const before = rmsDb(decodeAudio(plain.file), 0.2, 1.8);
    await build(page, `(st) => { const v = st().project.tracks.find(t => t.kind === 'main').clips[0].id; return st().toggleExtractAudio([v]); }`);
    const p = await projectJson(page);
    const links = p.tracks.flatMap((t: any) => t.clips.map((c: any) => ({ kind: t.kind, link: c.audioLink ?? null, muted: c.audio?.muted })));
    const ex = await doExport(page);
    const after = rmsDb(decodeAudio(ex.file), 0.2, 1.8);
    // sync of an extracted beep (flash video)
    await resetProject(page);
    await build(page, `(st, idOf) => { const v = st().addClip(idOf('${AM.code}'), { at: 0 }); st().trimEnd(v, 2e6); st().toggleExtractAudio([v]); }`);
    const sy = await doExport(page);
    const onset = onsetSample(decodeAudio(sy.file), 0.2);
    const src = onsetSample(decodeAudio(amPath(AM.code)), 0.2);
    record('audioLink', { links, plainDb: +before.toFixed(2), extractedDb: +after.toFixed(2), extractedBeepOffsetMs: +((onset - src) / 48).toFixed(3) });
    expect.soft(links.filter((l: any) => l.link).length).toBe(2);
    expect.soft(Math.abs(after - before), 'extract does not double (+6 dB) the audio').toBeLessThanOrEqual(DB_TOL);
    expect.soft(Math.abs(before - REF_DB)).toBeLessThanOrEqual(DB_TOL);
    expect.soft(Math.abs(onset - src) / 48).toBeLessThanOrEqual(MAX_SYNC_MS);
  });

  test('sound: a WAV click lands on its sample; overlapping clips are mixed and do not clip', async () => {
    await resetProject(page);
    await build(
      page,
      `(st, idOf) => {
        const a = st().addClip(idOf('${AM.a440}'), { at: 0 }); st().trimEnd(a, 2e6);
        const b = st().addClip(idOf('${AM.a1k}'), { at: 0 }); st().trimEnd(b, 2e6);       // own track (overlap)
        const c = st().addClip(idOf('${AM.click}'), { at: 2e6 }); st().trimEnd(c, 4e6); // click at 2 + 1.5 s
        const l1 = st().addClip(idOf('${AM.loud}'), { at: 4e6 }); st().trimEnd(l1, 6e6);
        const l2 = st().addClip(idOf('${AM.loud}'), { at: 4e6 }); st().trimEnd(l2, 6e6); // 0.8 + 0.8 in phase
      }`,
    );
    const { file } = await doExport(page);
    const pcm: Pcm = decodeAudio(file);
    const mixDb = rmsDb(pcm, 0.1, 1.9);
    const mixPeak = peakAbs(pcm, 0.1, 1.9);
    const click = onsetSample(pcm, 0.3, 2.1);
    const clickSrc = onsetSample(decodeAudio(amPath(AM.click)), 0.3) + 2 * 48000;
    const loudPeak = peakAbs(pcm, 4.1, 5.9);
    const loudDb = rmsDb(pcm, 4.1, 5.9);
    record('mix + click', { mixDb: +mixDb.toFixed(2), expectedMixDb: -12.04, mixPeak: +mixPeak.toFixed(3), clickSample: click, clickExpected: clickSrc, clickOffsetSamples: click - clickSrc, loudPeak: +loudPeak.toFixed(3), loudDb: +loudDb.toFixed(2) });
    expect.soft(Math.abs(mixDb - -12.04), 'two −15 dB tones sum to −12 dB').toBeLessThanOrEqual(DB_TOL);
    expect.soft(mixPeak).toBeLessThan(1);
    expect.soft(Math.abs(click - clickSrc), 'WAV click sample-exact (±2 samples)').toBeLessThanOrEqual(2);
    expect.soft(loudPeak, 'loud overlap does not clip').toBeLessThanOrEqual(1.0);
  });

  // ============================================================ robustness

  test('robustness: cancel mid-export leaves no download and no stuck state; two exports in a row; export after undo', async () => {
    await resetProject(page);
    await page.evaluate(() => {
      const s = (window as any).__oe.getState();
      return s.importFiles;
    });
    await page.getByTestId('media-import-input').setInputFiles([mediaPath('v-long-60s.mp4')]);
    await expect.poll(() => page.evaluate(() => Object.values((window as any).__oe.getState().project.assets).some((a: any) => a.name === 'v-long-60s.mp4'))).toBe(true);
    await build(page, `(st, idOf) => { st().addClip(idOf('v-long-60s.mp4'), { at: 0 }); }`);

    // ---- cancel
    await page.mouse.move(5, 5);
    await page.getByTestId('export-button').click();
    await page.getByTestId('export-resolution').selectOption('1080p');
    let downloads = 0;
    const onDl = () => downloads++;
    page.on('download', onDl);
    await page.getByTestId('export-confirm').click();
    await expect.poll(() => page.getByTestId('export-progress').textContent().then((t) => Number(/(\d+) \//.exec(t ?? '')?.[1] ?? 0)), { timeout: 60_000 }).toBeGreaterThan(60);
    const tCancel = Date.now();
    await page.getByTestId('export-cancel').click();
    await expect(page.getByTestId('export-confirm')).toBeVisible({ timeout: 5_000 });
    const cancelMs = Date.now() - tCancel;
    await expect(page.getByTestId('export-progress')).toHaveCount(0);
    await page.waitForTimeout(3_000);
    page.off('download', onDl);
    const errorShown = await page.getByTestId('export-dialog').getByRole('alert').count();
    await page.keyboard.press('Escape');
    record('cancel', { downloadsAfterCancel: downloads, cancelToIdleMs: cancelMs, errorShown });
    expect(downloads).toBe(0);
    expect(errorShown).toBe(0);

    // ---- two exports in a row of a short project (the long clip trimmed to 2 s)
    await build(page, `(st) => { const c = st().project.tracks.find(t => t.kind === 'main').clips[0].id; st().trimEnd(c, 2e6); }`);
    const e1 = await doExport(page);
    const e2 = await doExport(page);
    const f1 = probeStreams(e1.file);
    const f2 = probeStreams(e2.file);
    const same = compare(videoFrame(e1.file, 40, 90, 160), videoFrame(e2.file, 40, 90, 160));
    record('two in a row', { frames: [f1.v!.frames, f2.v!.frames], frame40Psnr: +same.psnr.toFixed(1) });
    expect(f1.v!.frames).toBe(60);
    expect(f2.v!.frames).toBe(60);
    expect(same.psnr).toBeGreaterThan(40);

    // ---- export after undo: speed 2× then undo → back to 2 s / 60 frames
    await build(page, `(st) => { const c = st().project.tracks.find(t => t.kind === 'main').clips[0].id; st().setSpeed(c, 2); }`);
    const halved = projectDurationUs(await projectJson(page));
    await build(page, `(st) => st().undo()`);
    const restored = projectDurationUs(await projectJson(page));
    const e3 = await doExport(page);
    const f3 = probeStreams(e3.file);
    const vsFirst = compare(videoFrame(e1.file, 40, 90, 160), videoFrame(e3.file, 40, 90, 160));
    record('after undo', { durationAfterSpeed: halved, durationAfterUndo: restored, frames: f3.v!.frames, frame40PsnrVsFirst: +vsFirst.psnr.toFixed(1) });
    expect(halved).toBe(S(1));
    expect(restored).toBe(S(2));
    expect(f3.v!.frames).toBe(60);
    expect(vsFirst.psnr).toBeGreaterThan(40);
  });

  test('robustness: a 60 s 1080p project exports frame-exact within memory', async () => {
    test.setTimeout(360_000);
    await resetProject(page);
    if (!(await page.evaluate(() => Object.values((window as any).__oe.getState().project.assets).some((a: any) => a.name === 'v-long-60s.mp4')))) {
      await page.getByTestId('media-import-input').setInputFiles([mediaPath('v-long-60s.mp4')]);
      await expect.poll(() => page.evaluate(() => Object.values((window as any).__oe.getState().project.assets).some((a: any) => a.name === 'v-long-60s.mp4'))).toBe(true);
    }
    await build(page, `(st, idOf) => { st().addClip(idOf('v-long-60s.mp4'), { at: 0 }); }`);
    const base = treeRssMb();
    let peak = base;
    let heapPeak = 0;
    const timer = setInterval(() => {
      try {
        peak = Math.max(peak, treeRssMb());
      } catch {
        /* ps hiccup */
      }
    }, 1000);
    const heapTimer = setInterval(() => {
      void page
        .evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0)
        .then((h: number) => (heapPeak = Math.max(heapPeak, h)))
        .catch(() => undefined);
    }, 1000);
    let out: ExportOut;
    try {
      out = await doExport(page, { resolution: '1080p', fps: 30 });
    } finally {
      clearInterval(timer);
      clearInterval(heapTimer);
    }
    const f = probeStreams(out.file);
    const pcm = decodeAudio(out.file);
    record('60 s export', { ms: out.ms, realtimeX: +(60_000 / out.ms).toFixed(2), rssBaseMb: base, rssPeakMb: peak, jsHeapPeakMb: Math.round(heapPeak / 1048576), frames: f.v!.frames, vdur: f.v!.duration, adur: f.a?.duration, sizeMb: +(fs.statSync(out.file).size / 1048576).toFixed(1), audioDb: +rmsDb(pcm, 1, 59).toFixed(2) });
    expect(f.v!.frames).toBe(1800);
    expect(Math.abs(f.v!.duration - 60)).toBeLessThan(1e-3);
    expect(peak, 'browser RSS stays under 3 GB').toBeLessThan(3000);
    expect(peak - base, 'export adds less than 1.5 GB').toBeLessThan(1500);
  });
});

test('robustness: WebM fallback when WebCodecs is missing', async ({ browser }) => {
  test.setTimeout(180_000);
  ensureAuditMedia();
  const pg = await freshPage(browser, 'delete window.VideoEncoder; delete window.AudioEncoder;');
  try {
    await resetProject(pg);
    await build(pg, `(st, idOf) => { const c = st().addClip(idOf('${AM.code}'), { at: 0 }); st().trimEnd(c, 2e6); }`);
    const p = await projectJson(pg);
    await pg.mouse.move(5, 5);
    await pg.getByTestId('export-button').click();
    const dlg = pg.getByTestId('export-dialog');
    await pg.getByTestId('export-resolution').selectOption('720p');
    const fmtLabel = await pg.getByTestId('export-format').textContent();
    const file = await waitForDownload(pg, () => pg.getByTestId('export-confirm').click(), 120_000);
    exported.push(file);
    const note = await dlg.getByText(/Saved as WebM/).count();
    const f = probeStreams(file);
    const pcm = decodeAudio(file);
    const onset = onsetSample(pcm, 0.2);
    record('WebM fallback', { name: path.basename(file), ...f, fallbackNote: note, formatLabel: fmtLabel, beepOnsetMs: +(onset / 48).toFixed(1) });
    expect(path.extname(file)).toBe('.webm');
    expect(f.v?.codec).toMatch(/vp8|vp9/);
    expect(note).toBe(1);
    expect(fmtLabel).toBe('WebM');
    expect(Number.isFinite(f.formatDuration), 'WebM has a duration').toBe(true);
    expect.soft(Math.abs(f.formatDuration - 2)).toBeLessThan(0.25);
    expect.soft(f.v!.width).toBe(720);
    // content: a frame in the middle reads a barcode near the right source frame (real time, ±3 frames)
    const code = readBarcode(videoFrame(file, Math.round(f.v!.frames / 2), 180, 320));
    record('WebM content', { middleCode: code, expectedApprox: expectedCodeFrame(p, S(1)) });
  } finally {
    cleanup();
    await pg.context().close();
  }
});

// keep DOWNLOADS_DIR tidy even when a test died before cleanup()
test.afterAll(() => {
  if (!fs.existsSync(DOWNLOADS_DIR)) return;
  for (const f of fs.readdirSync(DOWNLOADS_DIR)) if (/\.(mp4|webm)$/.test(f)) fs.rmSync(path.join(DOWNLOADS_DIR, f), { force: true });
});
