/**
 * YUV→RGB matrix agreement between the preview (<video>) and the export (WebCodecs).
 *
 * The two decoders read a stream's colour tags differently (measured in Chromium, 2026-10-19,
 * docs/AUDIT-export.md § colour):
 * - <video> uses the stream's matrix only when its primaries AND transfer are tagged too;
 *   otherwise it picks by frame height (< 720 → BT.601, else BT.709). A 1080p clip tagged "BT.601 matrix"
 *   only (ffmpeg's default for smptebars/testsrc) is shown with BT.709: red 191,0,1 → 208,19,1.
 * - WebCodecs (Mediabunny's decoder, the export) uses the matrix tag whenever it is set, and
 *   BT.709 for untagged streams, even SD ones.
 * The intended matrix is the tag when present (what ffmpeg and the spec say), else the same
 * height rule the browser's own player uses for untagged video. Whichever path deviates gets a 3×3
 * correction on its decoded RGB, so preview and export both show the intended colours.
 */
export type Matrix = 'bt601' | 'bt709';

export interface ColorTags {
  /** VideoColorSpace names: 'bt709', 'bt470bg', 'smpte170m', … or null when untagged. */
  matrix: string | null;
  primaries: string | null;
  transfer: string | null;
  width: number;
  height: number;
}

const known = (m: string | null): Matrix | null => (m === 'bt709' ? 'bt709' : m === 'bt470bg' || m === 'smpte170m' ? 'bt601' : null);
/**
 * Untagged convention, Chromium's: frame height < 720 → BT.601, else BT.709 (measured: 640×360 →
 * 601; 540×960, 1920×1080 → 709 — so a portrait 540×960 counts as "HD").
 */
export const sizeDefault = (t: Pick<ColorTags, 'width' | 'height'>): Matrix => (t.height >= 720 ? 'bt709' : 'bt601');

/** What the stream means. null = a matrix we do not correct (BT.2020, RGB…). */
export function intendedMatrix(t: ColorTags): Matrix | null {
  if (t.matrix && !known(t.matrix)) return null;
  return known(t.matrix) ?? sizeDefault(t);
}
/** How Chromium's <video> decodes it. */
export function elementMatrix(t: ColorTags): Matrix | null {
  if (t.matrix && !known(t.matrix)) return null;
  return t.primaries && t.transfer ? (known(t.matrix) ?? sizeDefault(t)) : sizeDefault(t);
}
/** How WebCodecs (VideoDecoder → canvas) decodes it. */
export function webCodecsMatrix(t: ColorTags): Matrix | null {
  if (t.matrix && !known(t.matrix)) return null;
  return known(t.matrix) ?? 'bt709';
}

const K: Record<Matrix, [number, number]> = { bt601: [0.299, 0.114], bt709: [0.2126, 0.0722] };

/** RGB → (Y, Pb, Pr) rows for a matrix. */
function forward(m: Matrix): number[] {
  const [kr, kb] = K[m];
  const kg = 1 - kr - kb;
  const y = [kr, kg, kb];
  const pb = [-kr / (2 * (1 - kb)), -kg / (2 * (1 - kb)), (1 - kb) / (2 * (1 - kb))];
  const pr = [(1 - kr) / (2 * (1 - kr)), -kg / (2 * (1 - kr)), -kb / (2 * (1 - kr))];
  return [...y, ...pb, ...pr];
}
/** (Y, Pb, Pr) → RGB rows. */
function inverse(m: Matrix): number[] {
  const [kr, kb] = K[m];
  const kg = 1 - kr - kb;
  return [1, 0, 2 * (1 - kr), 1, (-2 * kb * (1 - kb)) / kg, (-2 * kr * (1 - kr)) / kg, 1, 2 * (1 - kb), 0];
}
const mul = (a: number[], b: number[]) => {
  const o = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c]! += a[r * 3 + k]! * b[k * 3 + c]!;
  return o;
};

/**
 * 3×3 that turns RGB decoded with matrix `decodedAs` into RGB with matrix `intended` (same
 * YUV, same range: the offsets cancel). null when nothing needs fixing.
 */
export function correctionMatrix(decodedAs: Matrix | null, intended: Matrix | null): number[] | null {
  if (!decodedAs || !intended || decodedAs === intended) return null;
  return mul(inverse(intended), forward(decodedAs));
}

/** Applies a 3×3 to RGBA bytes in place. */
export function applyMatrix(px: Uint8ClampedArray, m: readonly number[]): void {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  for (let p = 0; p < px.length; p += 4) {
    const r = px[p]!;
    const gg = px[p + 1]!;
    const bb = px[p + 2]!;
    px[p] = a * r + b * gg + c * bb;
    px[p + 1] = d * r + e * gg + f * bb;
    px[p + 2] = g * r + h * gg + i * bb;
  }
}

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** Applies a correction to a whole canvas context. */
export function correctCanvas(ctx: AnyCtx, w: number, h: number, m: readonly number[]): void {
  const img = ctx.getImageData(0, 0, w, h);
  applyMatrix(img.data, m);
  ctx.putImageData(img, 0, 0);
}

/** Reads a video file's colour tags (header only) with Mediabunny. null when it has no video. */
export async function readColorTags(blob: Blob): Promise<ColorTags | null> {
  try {
    const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny');
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return null;
      const cs = await track.getColorSpace();
      return { matrix: cs.matrix ?? null, primaries: cs.primaries ?? null, transfer: cs.transfer ?? null, width: track.codedWidth, height: track.codedHeight };
    } finally {
      input.dispose();
    }
  } catch {
    return null;
  }
}

const tagCache = new Map<string, Promise<ColorTags | null>>();
/** Colour tags per asset, read once. `load` gives the file. */
export function colorTagsFor(assetId: string, load: () => Promise<Blob | null>): Promise<ColorTags | null> {
  let p = tagCache.get(assetId);
  if (!p) {
    p = load().then((b) => (b ? readColorTags(b) : null)).catch(() => null);
    tagCache.set(assetId, p);
  }
  return p;
}
