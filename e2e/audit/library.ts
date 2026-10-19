/**
 * Helpers for the functional audit of the Library (e2e/audit-library.spec.ts): store snapshots,
 * IndexedDB inspection, player-canvas pixel signatures and generated fixtures.
 *
 * Every check reads the real effect: `window.__oe` (the dev-only store handle), the IndexedDB
 * database "our-editor", the timeline DOM and the player canvas pixels (getImageData).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediaPath } from '../helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const FIX_DIR = path.join(os.tmpdir(), 'oe-audit-fixtures');

/** Generated fixtures (ffmpeg): a second textured image, a garbage ".mp4", a text file. */
export function fixtures(): { texture: string; broken: string; notes: string; long: string } {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const texture = path.join(FIX_DIR, 'b-texture.png');
  if (!fs.existsSync(texture)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=1', '-frames:v', '1', texture]);
  }
  const broken = path.join(FIX_DIR, 'broken.mp4');
  if (!fs.existsSync(broken)) fs.writeFileSync(broken, Buffer.alloc(64 * 1024, 7));
  const notes = path.join(FIX_DIR, 'notes.txt');
  if (!fs.existsSync(notes)) fs.writeFileSync(notes, 'not media');
  // the 60 s 1080x1920 clip (big file); generated into test-media/ when it is missing
  let long: string;
  try {
    long = mediaPath('v-long-60s.mp4');
  } catch {
    long = path.join(path.dirname(mediaPath('v-vertical-5s.mp4')), 'v-long-60s.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=60',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', long,
    ]);
  }
  return { texture, broken, notes, long };
}

export async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__oe);
  await expect(page.getByTestId('left-panel')).toBeVisible();
}

/** Reload and wait until the stored project is back in the store (assets restored). */
export async function reloadAndWait(page: Page, assetCount: number) {
  // the autosave writes 0.8 s after the last change, at most once every 2 s
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction((n) => {
    const oe = (window as any).__oe;
    return !!oe && Object.keys(oe.getState().project.assets).length === n;
  }, assetCount, { timeout: 20_000 });
}

/** Waits until the autosave has written the current project. */
export async function waitSaved(page: Page) {
  await page.waitForFunction(
    () => {
      const s = (window as any).__oe.getState();
      return !s.saveStatus.saving && s.saveStatus.lastSavedAt !== null && s.saveStatus.lastSavedAt >= s.project.updatedAt;
    },
    null,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(150);
}

export interface AssetInfo {
  id: string;
  name: string;
  kind: string;
  duration: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  missing: boolean;
  blobKey: string;
}

export const assets = (page: Page): Promise<AssetInfo[]> =>
  page.evaluate(() =>
    (Object.values((window as any).__oe.getState().project.assets) as any[]).map((a) => ({
      id: a.id, name: a.name, kind: a.kind, duration: a.duration, width: a.width, height: a.height, hasAudio: a.hasAudio, missing: !!a.missing, blobKey: a.blobKey,
    })),
  );

export const assetByName = async (page: Page, name: string) => (await assets(page)).find((a) => a.name === name)!;

export interface ClipInfo {
  id: string;
  type: string;
  name: string;
  start: number;
  duration: number;
  trackId: string;
  trackKind: string;
  assetId?: string;
  filter: string | null;
  adjust?: Record<string, number>;
  text?: any;
}

export const clips = (page: Page): Promise<ClipInfo[]> =>
  page.evaluate(() =>
    ((window as any).__oe.getState().project.tracks as any[]).flatMap((t) =>
      t.clips.map((c: any) => ({
        id: c.id, type: c.type, name: c.name, start: c.start, duration: c.duration, trackId: t.id, trackKind: t.kind, assetId: c.assetId,
        filter: c.filter ? c.filter.id : null, adjust: c.adjust, text: c.text,
      })),
    ),
  );

export const transitions = (page: Page): Promise<{ id: string; type: string; fromClipId: string; toClipId: string; trackKind: string }[]> =>
  page.evaluate(() =>
    ((window as any).__oe.getState().project.tracks as any[]).flatMap((t) => t.transitions.map((x: any) => ({ id: x.id, type: x.type, fromClipId: x.fromClipId, toClipId: x.toClipId, trackKind: t.kind }))),
  );

export const state = (page: Page, fn: string) => page.evaluate((f) => new Function('s', `return (${f})(s)`)((window as any).__oe.getState()), fn);

export const setPlayhead = (page: Page, us: number) => page.evaluate((t) => (window as any).__oe.getState().setPlayhead(t), us);
export const select = (page: Page, ids: string[]) => page.evaluate((x) => (window as any).__oe.getState().select(x), ids);

// ---------------------------------------------------------------- IndexedDB

/** Keys of the media blobs stored in IndexedDB. */
export const blobKeys = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open('our-editor');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('blobs', 'readonly');
          const r = tx.objectStore('blobs').getAllKeys();
          r.onsuccess = () => {
            resolve((r.result as string[]).map(String).sort());
            db.close();
          };
          r.onerror = () => reject(r.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );

/** Deletes one stored blob behind the app's back (simulates lost / cleared site data). */
export const deleteStoredBlob = (page: Page, key: string): Promise<void> =>
  page.evaluate(
    (k) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('our-editor');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').delete(k);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    key,
  );

// ---------------------------------------------------------------- pixels

export type Sig = number[];

/**
 * Pixel signature of the player canvas: the mean RGB of a 16 × 16 grid of cells (768 numbers,
 * 0..255), plus `bright` / `colour` counts used by a few checks. Read with getImageData.
 */
export async function canvasSig(page: Page): Promise<Sig> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { width: w, height: h } = c;
    const d = ctx.getImageData(0, 0, w, h).data;
    const G = 16;
    const sum = new Array(G * G * 3).fill(0);
    const n = new Array(G * G).fill(0);
    for (let y = 0; y < h; y += 2) {
      const gy = Math.min(G - 1, Math.floor((y / h) * G));
      for (let x = 0; x < w; x += 2) {
        const gx = Math.min(G - 1, Math.floor((x / w) * G));
        const i = (y * w + x) * 4;
        const cell = gy * G + gx;
        sum[cell * 3] += d[i]!;
        sum[cell * 3 + 1] += d[i + 1]!;
        sum[cell * 3 + 2] += d[i + 2]!;
        n[cell]++;
      }
    }
    return sum.map((v, i) => v / Math.max(1, n[Math.floor(i / 3)]!));
  });
}

/** Counts canvas pixels that satisfy a colour predicate (written as JS source over r, g, b). */
export async function countPixels(page: Page, predicate: string): Promise<number> {
  return page.evaluate((src) => {
    const f = new Function('r', 'g', 'b', `return ${src}`) as (r: number, g: number, b: number) => boolean;
    const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (f(d[i]!, d[i + 1]!, d[i + 2]!)) n++;
    return n;
  }, predicate);
}

/** Mean absolute difference between two signatures (0..255). */
export const sigDiff = (a: Sig, b: Sig): number => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
export const sigMean = (a: Sig): number => a.reduce((s, v) => s + v, 0) / a.length;

/**
 * Waits until the canvas stops changing (two equal reads 120 ms apart) and returns it. Moves the
 * mouse off the timeline first, so the hover preview axis cannot override the playhead frame.
 */
export async function settledSig(page: Page, opts: { notEqual?: Sig; minDiff?: number; timeout?: number } = {}): Promise<Sig> {
  await page.mouse.move(2, 2);
  await page.evaluate(() => (window as any).__oe.getState().setPreviewTime(null));
  const until = Date.now() + (opts.timeout ?? 8000);
  let prev = await canvasSig(page);
  for (;;) {
    await page.waitForTimeout(120);
    const cur = await canvasSig(page);
    const stable = sigDiff(prev, cur) < 0.05;
    const changed = !opts.notEqual || sigDiff(cur, opts.notEqual) >= (opts.minDiff ?? 1);
    if (stable && changed) return cur;
    if (Date.now() > until) return cur;
    prev = cur;
  }
}

// ---------------------------------------------------------------- UI

export const tile = (page: Page, name: string): Locator => page.locator(`[data-testid="media-asset"][data-asset-name="${name}"]`);
export const tileNames = (page: Page): Promise<string[]> =>
  page.locator('[data-testid="media-asset"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-asset-name') ?? ''));

/** Bar heights (0..1) of an audio tile's waveform. */
export const waveBars = (page: Page, name: string): Promise<number[]> =>
  tile(page, name).locator('.atile__wave span').evaluateAll((els) => els.map((e) => parseFloat((e as HTMLElement).style.height) / 100));

/** Clicks the hover "+" of a tile (hovers first, like a user). */
export async function plusOn(page: Page, name: string) {
  await tile(page, name).hover();
  await tile(page, name).locator('.atile__add').click();
}

export async function openTab(page: Page, id: string) {
  await page.getByTestId(`library-tab-${id}`).click();
  await expect(page.getByTestId(`library-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
}

/** Clicks the preset tile with this label (its preview button). */
export async function clickPreset(page: Page, testId: string, label: string) {
  await page.locator(`[data-testid="${testId}"]`).filter({ has: page.locator('.ptile__name', { hasText: new RegExp(`^${label}$`) }) }).locator('.ptile__preview').click();
}

/** Labels of every preset tile with this test id, in order. */
export const presetLabels = (page: Page, testId: string): Promise<string[]> =>
  page.locator(`[data-testid="${testId}"] .ptile__name`).allTextContents();
