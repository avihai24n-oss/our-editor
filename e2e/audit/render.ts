/**
 * Helpers for the render / player audit (e2e/audit-render.spec.ts).
 *
 * - `ensureRenderMedia()` builds synthetic media with ffmpeg into e2e/audit-media/ (git-ignored):
 *   frame-coded testsrc2 clips (a 10-bit frame-number strip + an identity band under the
 *   testsrc2 picture) and flat-colour PNGs whose pixels are known exactly.
 * - `refFrame()` extracts a reference frame with ffmpeg (downscaled RGB) for comparisons.
 * - Page helpers read the real player canvas (the preview the user sees) in PROJECT coordinates.
 */
import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // e2e/
export const AUDIT_DIR = path.join(here, 'audit-media');

/** Source geometry of the frame-coded clips (contain-fits a 1080×1920 canvas exactly, ×4). */
export const CODE = {
  w: 270,
  h: 480,
  /** testsrc2 occupies rows 0..400; identity band 400..420; 10 bit cells (27 px wide) 420..480. */
  picH: 400,
  bandY: 410,
  bitsY: 450,
  cell: 27,
  bits: 10,
  fps: 30,
} as const;

export const RENDER_AM = {
  /** 12 s, 30 fps, testsrc2 + frame code, RED identity band, 440 Hz stereo audio. */
  codeA: 'code-a.mp4',
  /** 12 s, 30 fps, testsrc2 + frame code, BLUE identity band, 660 Hz stereo audio. */
  codeB: 'code-b.mp4',
  /** 3 s, 30 fps, frame code, GREEN band, NO audio stream. */
  codeSilent: 'code-silent.mp4',
  /** 1080×1920 flat rgb(200,100,50). */
  imgA: 'flat-a.png',
  /** 1080×1920 flat rgb(100,150,200). */
  imgB: 'flat-b.png',
  /** 1080×1080 flat white. */
  imgWhite: 'flat-white-square.png',
  /** 1080×1920 quadrants: TL red, TR green, BL blue, BR white. */
  imgQuad: 'quad.png',
  /** 1920×1080 flat rgb(0,200,0) (landscape, for letter/pillar boxing). */
  imgLand: 'flat-land.png',
  /** 4 s 330 Hz mp3. */
  tone: 'tone-4s.mp3',
} as const;

export const COLORS = {
  a: [200, 100, 50],
  b: [100, 150, 200],
  white: [255, 255, 255],
  land: [0, 200, 0],
} as const;

function ff(args: string[]) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
}

function codeClip(file: string, seconds: number, band: [number, number, number], audioHz: number | null) {
  const bit = `255*mod(floor(N/pow(2,floor(X/${CODE.cell}))),2)`;
  const strip =
    `color=black:s=${CODE.w}x80:r=${CODE.fps}:d=${seconds},format=rgb24,` +
    `geq=r='if(lt(Y,20),${band[0]},${bit})':g='if(lt(Y,20),${band[1]},${bit})':b='if(lt(Y,20),${band[2]},${bit})'`;
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=${CODE.w}x${CODE.picH}:r=${CODE.fps}:d=${seconds},format=rgb24`, '-f', 'lavfi', '-i', strip];
  if (audioHz) args.push('-f', 'lavfi', '-i', `sine=f=${audioHz}:d=${seconds}:sample_rate=48000`);
  args.push('-filter_complex', '[0][1]vstack,format=yuv420p[v]', '-map', '[v]');
  if (audioHz) args.push('-map', '2', '-c:a', 'aac', '-ac', '2', '-b:a', '128k');
  args.push('-c:v', 'libx264', '-g', '15', '-crf', '16', '-movflags', '+faststart', '-shortest', path.join(AUDIT_DIR, file));
  ff(args);
}

function flat(file: string, w: number, h: number, rgb: readonly number[]) {
  // geq on rgb24 writes the exact values (the lavfi colour source goes through YUV: 200,100,50 → 197,100,48)
  const src = `color=black:s=${w}x${h},format=rgb24,geq=r=${rgb[0]}:g=${rgb[1]}:b=${rgb[2]}`;
  ff(['-f', 'lavfi', '-i', src, '-frames:v', '1', '-pix_fmt', 'rgb24', path.join(AUDIT_DIR, file)]);
}

/** Builds the audit media once (skips files that already exist). */
export function ensureRenderMedia(): void {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const need = (f: string) => !fs.existsSync(path.join(AUDIT_DIR, f));
  if (need(RENDER_AM.codeA)) codeClip(RENDER_AM.codeA, 12, [255, 0, 0], 440);
  if (need(RENDER_AM.codeB)) codeClip(RENDER_AM.codeB, 12, [0, 0, 255], 660);
  if (need(RENDER_AM.codeSilent)) codeClip(RENDER_AM.codeSilent, 3, [0, 255, 0], null);
  if (need(RENDER_AM.imgA)) flat(RENDER_AM.imgA, 1080, 1920, COLORS.a);
  if (need(RENDER_AM.imgB)) flat(RENDER_AM.imgB, 1080, 1920, COLORS.b);
  if (need(RENDER_AM.imgWhite)) flat(RENDER_AM.imgWhite, 1080, 1080, COLORS.white);
  if (need(RENDER_AM.imgLand)) flat(RENDER_AM.imgLand, 1920, 1080, COLORS.land);
  if (need(RENDER_AM.imgQuad)) {
    const q = `color=black:s=1080x1920,format=rgb24,geq=r='if(lt(Y,960),if(lt(X,540),255,0),if(lt(X,540),0,255))':g='if(lt(Y,960),if(lt(X,540),0,255),if(lt(X,540),0,255))':b='if(lt(Y,960),0,255)'`;
    ff(['-f', 'lavfi', '-i', q, '-frames:v', '1', '-pix_fmt', 'rgb24', path.join(AUDIT_DIR, RENDER_AM.imgQuad)]);
  }
  if (need(RENDER_AM.tone)) ff(['-f', 'lavfi', '-i', 'sine=f=330:d=4:sample_rate=44100', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(AUDIT_DIR, RENDER_AM.tone)]);
}

export const auditPath = (f: string) => path.join(AUDIT_DIR, f);

/** Reference frame `n` of a clip (exact frame index), downscaled to w×h RGB with area averaging. */
export function refFrame(file: string, n: number, w: number, h: number, cropH?: number): Uint8Array {
  const crop = cropH ? `crop=iw:${cropH}:0:0,` : '';
  const out = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', auditPath(file), '-vf', `select=eq(n\\,${n}),${crop}scale=${w}:${h}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return new Uint8Array(out);
}

// ---------------------------------------------------------------- page side

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Opens the app, imports the given audit files, and resets the document to an empty main track. */
export async function setupAudit(page: Page, files: string[]): Promise<Record<string, string>> {
  await page.goto('/');
  await expect(page.getByTestId('player-canvas')).toBeVisible();
  await page.waitForFunction(() => !!(window as any).__oe);
  const input = page.getByTestId('media-import-input');
  await input.first().setInputFiles(files.map(auditPath));
  await expect
    .poll(() => page.evaluate((n) => Object.keys((window as any).__oe.getState().project.assets).length >= n, files.length), { timeout: 30_000 })
    .toBe(true);
  // park the mouse away from the timeline so the hover preview axis never overrides the playhead
  await page.mouse.move(5, 5);
  return page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const p = structuredClone(s.project);
    p.tracks = p.tracks.filter((t: any) => t.kind === 'main');
    p.tracks[0].clips = [];
    p.tracks[0].transitions = [];
    s.setProject(p);
    const ids: Record<string, string> = {};
    for (const a of Object.values(s.project.assets) as any[]) ids[a.name] = a.id;
    return ids;
  });
}

/** Waits until the preview has landed every pending seek and drawn the result. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const busy = () =>
      [...document.querySelectorAll('video')].some((v) => v.src && (v.seeking || v.readyState < 2));
    for (let i = 0; i < 200; i++) {
      await raf();
      if (!busy()) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    for (let i = 0; i < 4; i++) await raf();
    // images decode async
    for (const img of document.images) if (!img.complete) await img.decode().catch(() => undefined);
    for (let i = 0; i < 3; i++) await raf();
  });
}

export async function seek(page: Page, us: number): Promise<void> {
  await page.evaluate((t) => {
    const s = (window as any).__oe.getState();
    s.setPreviewTime(null);
    s.setPlayhead(t);
  }, us);
  await settle(page);
}

export type RGB = [number, number, number];

/** Average RGB of a (2r+1)² block around project point (x, y) on the player canvas. */
export async function pixel(page: Page, x: number, y: number, r = 1): Promise<RGB> {
  return page.evaluate(
    ({ x, y, r }) => {
      const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
      const W = (window as any).__oe.getState().project.settings.width;
      const k = c.width / W;
      const cx = Math.min(c.width - 1 - r, Math.max(r, Math.round(x * k)));
      const cy = Math.min(c.height - 1 - r, Math.max(r, Math.round(y * k)));
      const d = c.getContext('2d')!.getImageData(cx - r, cy - r, 2 * r + 1, 2 * r + 1).data;
      const s = [0, 0, 0];
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        s[0]! += d[i]!;
        s[1]! += d[i + 1]!;
        s[2]! += d[i + 2]!;
      }
      return s.map((v) => Math.round(v / n)) as [number, number, number];
    },
    { x, y, r },
  );
}

/** Canvas backing-store size and the project size. */
export async function canvasInfo(page: Page): Promise<{ cw: number; ch: number; W: number; H: number; k: number }> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
    const st = (window as any).__oe.getState().project.settings;
    return { cw: c.width, ch: c.height, W: st.width, H: st.height, k: c.width / st.width };
  });
}

/** The whole canvas downscaled to w×h RGB (area-averaged by the browser's high-quality scaler). */
export async function canvasRGB(page: Page, w: number, h: number, crop?: { y0: number; y1: number }): Promise<number[]> {
  return page.evaluate(
    ({ w, h, crop }) => {
      const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
      const t = document.createElement('canvas');
      t.width = w;
      t.height = h;
      const g = t.getContext('2d')!;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const sy = crop ? crop.y0 * c.height : 0;
      const sh = crop ? (crop.y1 - crop.y0) * c.height : c.height;
      g.drawImage(c, 0, sy, c.width, sh, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      const out: number[] = [];
      for (let i = 0; i < d.length; i += 4) out.push(d[i]!, d[i + 1]!, d[i + 2]!);
      return out;
    },
    { w, h, crop },
  );
}

/** Mean absolute error between two RGB arrays. */
export function mae(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.abs(a[i]! - b[i]!);
  return s / n;
}

/** In-page source of the frame-code decoder (string so it can be injected into evaluate). */
export const DECODE_SRC = `
(function decodeCode(c, W) {
  // W = project width. The frame-coded clip contain-fits a 9:16 canvas exactly at scale 1.
  const g = c.getContext('2d');
  const k = c.width / ${CODE.w};
  const row = g.getImageData(0, Math.round(${CODE.bitsY} * k), c.width, 1).data;
  let n = 0;
  for (let b = 0; b < ${CODE.bits}; b++) {
    const x = Math.round((b * ${CODE.cell} + ${CODE.cell / 2}) * k);
    const l = (row[x * 4] + row[x * 4 + 1] + row[x * 4 + 2]) / 3;
    if (l > 128) n |= 1 << b;
  }
  const band = g.getImageData(Math.round(${CODE.w / 2} * k), Math.round(${CODE.bandY} * k), 1, 1).data;
  const id = band[0] > 128 && band[2] < 128 ? 'A' : band[2] > 128 && band[0] < 128 ? 'B' : band[1] > 128 ? 'S' : '?';
  const full = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, cnt = 0;
  for (let i = 0; i < full.length; i += 4 * 97) { sum += full[i] + full[i + 1] + full[i + 2]; cnt++; }
  return { frame: n, id, luma: sum / cnt / 3 };
})
`;

/** Decodes the frame number + clip identity shown on the player canvas right now. */
export async function shownFrame(page: Page): Promise<{ frame: number; id: string; luma: number }> {
  return page.evaluate((src) => {
    const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
    // eslint-disable-next-line no-eval
    const f = (0, eval)(src);
    return f(c, (window as any).__oe.getState().project.settings.width);
  }, DECODE_SRC);
}

export const near = (got: readonly number[], want: readonly number[], tol: number) =>
  got.every((v, i) => Math.abs(v - want[i]!) <= tol);

export interface ColorStats {
  count: number;
  /** Bounding box of the matching pixels, project px (NaN when none). */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Fraction of the region that matches. */
  frac: number;
}

/** Pixels within `tol` (per channel) of `rgb` in a project-px region of the player canvas. */
export async function colorStats(
  page: Page,
  rgb: readonly number[],
  tol: number,
  region?: { x0: number; y0: number; x1: number; y1: number },
): Promise<ColorStats> {
  return page.evaluate(
    ({ rgb, tol, region }) => {
      const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
      const W = (window as any).__oe.getState().project.settings.width;
      const k = c.width / W;
      const x0 = Math.max(0, Math.floor((region?.x0 ?? 0) * k));
      const y0 = Math.max(0, Math.floor((region?.y0 ?? 0) * k));
      const x1 = Math.min(c.width, Math.ceil(region ? region.x1 * k : c.width));
      const y1 = Math.min(c.height, Math.ceil(region ? region.y1 * k : c.height));
      const d = c.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let count = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const w = x1 - x0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (Math.abs(d[i]! - rgb[0]!) <= tol && Math.abs(d[i + 1]! - rgb[1]!) <= tol && Math.abs(d[i + 2]! - rgb[2]!) <= tol) {
          count++;
          const x = x0 + (p % w);
          const y = y0 + Math.floor(p / w);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const f = (v: number) => (Number.isFinite(v) ? v / k : NaN);
      return { count, minX: f(minX), maxX: f(maxX + 1), minY: f(minY), maxY: f(maxY + 1), frac: count / ((x1 - x0) * (y1 - y0) || 1) };
    },
    { rgb: [...rgb], tol, region },
  );
}

/** Runs store code in the page: `fn(state, ids)`; returns its result. */
export async function store<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    ({ fn, arg }) => {
      const s = (window as any).__oe.getState();
      // eslint-disable-next-line no-new-func
      return new Function('s', 'arg', 'oe', fn)(s, arg, (window as any).__oe);
    },
    { fn, arg },
  );
}
