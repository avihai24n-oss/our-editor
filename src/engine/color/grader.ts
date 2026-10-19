/**
 * Colour pass front door. `createColorGrader()` gives the WebGL2 grader, or the CPU grader
 * (same maths, ./math.ts) when WebGL2 is unavailable. Both take the clip's source picture and
 * return a graded picture of the requested size for the 2D compositor to draw.
 */
import type { Lut3D } from './cube';
import { GlGrader } from './glGrader';
import { clamp01, gradePixel, luma, type PixelEnv } from './math';
import { K, needsNeighbours, type GradeParams } from './params';
import { getLoadedLut } from './lutLibrary';

export interface GradeRequest {
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  /** Visible part of the source, as uv fractions (x, y, w, h). */
  crop: { x: number; y: number; w: number; h: number };
  /** Size of the graded picture in pixels. */
  outWidth: number;
  outHeight: number;
  /** Clip box width / height (for vignette, grain, mask and kernel radii). */
  aspect: number;
  params: GradeParams;
}

export interface ColorGrader {
  readonly kind: 'webgl2' | 'cpu';
  /** The graded picture (valid until the next call), or null when grading failed. */
  grade(req: GradeRequest): CanvasImageSource | null;
  dispose(): void;
}

type Ctx2 = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function make2d(w: number, h: number): Ctx2 | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c.getContext('2d', { willReadFrequently: true });
    }
  } catch {
    /* no canvas */
  }
  return null;
}

/** Bilinear sample of a single-channel buffer at uv (0..1). */
function sampleBuf(buf: Float32Array, w: number, h: number, u: number, v: number): number {
  const x = Math.min(w - 1, Math.max(0, u * w - 0.5));
  const y = Math.min(h - 1, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = buf[y0 * w + x0]! * (1 - fx) + buf[y0 * w + x1]! * fx;
  const b = buf[y1 * w + x0]! * (1 - fx) + buf[y1 * w + x1]! * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Grades RGBA pixels in place (straight alpha). The buffer covers the whole clip box, so the
 * pixel centre uv is the clip uv. Used by the CPU grader and the library tile previews.
 */
export function gradeImageData(data: Uint8ClampedArray, w: number, h: number, params: GradeParams, aspect = w / h, lut?: Lut3D | null): void {
  let Y: Float32Array | null = null;
  if (needsNeighbours(params)) {
    Y = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) Y[i] = luma([data[i * 4]! / 255, data[i * 4 + 1]! / 255, data[i * 4 + 2]! / 255]);
  }
  const rs = [K.SHARPEN_RADIUS / aspect, K.SHARPEN_RADIUS];
  const rc = [K.CLARITY_RADIUS / aspect, K.CLARITY_RADIUS];
  const env: PixelEnv = { u: 0, v: 0, aspect, lut: lut ?? null };
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const o = (y * w + x) * 4;
      env.u = u;
      env.v = v;
      if (Y) {
        const s = (du: number, dv: number) => sampleBuf(Y!, w, h, u + du, v + dv);
        const c0 = s(0, 0);
        env.detailSharpen = params.sharpen ? c0 - (s(rs[0]!, 0) + s(-rs[0]!, 0) + s(0, rs[1]!) + s(0, -rs[1]!)) / 4 : 0;
        if (params.clarity) {
          let sum = 0;
          for (let i = 0; i < 8; i++) {
            const a = i * 0.7853981634;
            const dx = Math.cos(a) * rc[0]!;
            const dy = Math.sin(a) * rc[1]!;
            sum += s(dx, dy) + s(dx / 2, dy / 2);
          }
          env.detailClarity = c0 - sum / 16;
        } else env.detailClarity = 0;
      }
      const c = gradePixel([data[o]! / 255, data[o + 1]! / 255, data[o + 2]! / 255], params, env);
      data[o] = Math.round(clamp01(c[0]) * 255);
      data[o + 1] = Math.round(clamp01(c[1]) * 255);
      data[o + 2] = Math.round(clamp01(c[2]) * 255);
    }
  }
}

/** CPU fallback. Grades at most CPU_MAX_PX pixels per call (upscaled by the compositor). */
const CPU_MAX_PX = 640 * 640;

export class CpuGrader implements ColorGrader {
  readonly kind = 'cpu' as const;
  private ctx: Ctx2 | null = null;

  constructor(private getLut: (id: string) => Lut3D | undefined = getLoadedLut) {}

  grade(req: GradeRequest): CanvasImageSource | null {
    let w = Math.max(1, Math.round(req.outWidth));
    let h = Math.max(1, Math.round(req.outHeight));
    if (w * h > CPU_MAX_PX) {
      const k = Math.sqrt(CPU_MAX_PX / (w * h));
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
    this.ctx ??= make2d(w, h);
    const ctx = this.ctx;
    if (!ctx) return null;
    if (ctx.canvas.width !== w) ctx.canvas.width = w;
    if (ctx.canvas.height !== h) ctx.canvas.height = h;
    const { crop: c, sourceWidth: sw, sourceHeight: sh } = req;
    ctx.clearRect(0, 0, w, h);
    try {
      ctx.drawImage(req.source, c.x * sw, c.y * sh, Math.max(1, c.w * sw), Math.max(1, c.h * sh), 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const lut = req.params.lut ? this.getLut(req.params.lut.id) : null;
      gradeImageData(img.data, w, h, req.params, req.aspect, lut);
      ctx.putImageData(img, 0, 0);
    } catch (e) {
      console.warn('CPU colour pass failed', e);
      return null;
    }
    return ctx.canvas as CanvasImageSource;
  }

  dispose(): void {
    this.ctx = null;
  }
}

export interface CreateGraderOptions {
  /** Force the CPU path (tests, comparisons). */
  cpu?: boolean;
}

/** WebGL2 grader, else the CPU grader, else null (no canvas at all, e.g. unit tests). */
export function createColorGrader(opts: CreateGraderOptions = {}): ColorGrader | null {
  if (!opts.cpu) {
    const gl = GlGrader.create(getLoadedLut);
    if (gl) return gl;
  }
  if (!make2d(1, 1)) return null;
  return new CpuGrader();
}
