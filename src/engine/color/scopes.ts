/**
 * Video scopes from RGBA pixels (the graded frame the player shows, read back at reduced size):
 * Waveform (Rec.709 luma Y′ per column), RGB Parade (R′, G′, B′ per column), Vectorscope
 * (BT.709 Cb / Cr) and Histogram (R, G, B, Y′). Pure and allocation-free after the first call
 * (pass the previous ScopeData back in to reuse its buffers). Values are 8-bit code values.
 */

export const SCOPE_LEVELS = 256;
export const VECTOR_SIZE = 192;

export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
}

export interface ScopeData {
  /** Analysed picture size. */
  width: number;
  height: number;
  /** Waveform / parade columns. */
  cols: number;
  /** cols × 256 counts, row = code value (0 bottom). */
  waveY: Uint32Array;
  waveR: Uint32Array;
  waveG: Uint32Array;
  waveB: Uint32Array;
  /** VECTOR_SIZE² counts; x = Cb (left −0.5 … right +0.5), y = Cr (top +0.5 … bottom −0.5). */
  vector: Uint32Array;
  histR: Uint32Array;
  histG: Uint32Array;
  histB: Uint32Array;
  histY: Uint32Array;
  stats: { r: ChannelStats; g: ChannelStats; b: ChannelStats; y: ChannelStats; pixels: number };
}

/** Rec.709 luma of 8-bit R′G′B′ (rounded code value). */
export const lumaCode = (r: number, g: number, b: number): number => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);

/** BT.709 colour difference (Cb, Cr), each −0.5..0.5, from 0..1 R′G′B′. */
export function cbcr(r: number, g: number, b: number): [number, number] {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [(b - y) / 1.8556, (r - y) / 1.5748];
}

/** Vectorscope pixel of a 0..1 R′G′B′ colour (same mapping as computeScopes). */
export function vectorPos(r: number, g: number, b: number, size = VECTOR_SIZE): [number, number] {
  const [cb, cr] = cbcr(r, g, b);
  return [(cb + 0.5) * size, (0.5 - cr) * size];
}

function alloc(cols: number, prev?: ScopeData | null): Omit<ScopeData, 'width' | 'height' | 'stats'> {
  const n = cols * SCOPE_LEVELS;
  if (prev && prev.cols === cols) {
    for (const a of [prev.waveY, prev.waveR, prev.waveG, prev.waveB, prev.vector, prev.histR, prev.histG, prev.histB, prev.histY]) a.fill(0);
    return prev;
  }
  return {
    cols,
    waveY: new Uint32Array(n),
    waveR: new Uint32Array(n),
    waveG: new Uint32Array(n),
    waveB: new Uint32Array(n),
    vector: new Uint32Array(VECTOR_SIZE * VECTOR_SIZE),
    histR: new Uint32Array(SCOPE_LEVELS),
    histG: new Uint32Array(SCOPE_LEVELS),
    histB: new Uint32Array(SCOPE_LEVELS),
    histY: new Uint32Array(SCOPE_LEVELS),
  };
}

/** Every scope at once (one pass over the pixels). `cols` defaults to the picture width (max 512). */
export function computeScopes(data: Uint8ClampedArray, width: number, height: number, prev?: ScopeData | null, cols = Math.min(512, width)): ScopeData {
  const c = Math.max(1, Math.min(cols, width));
  const s = alloc(c, prev);
  const L = SCOPE_LEVELS;
  const V = VECTOR_SIZE;
  const st = { r: [255, 0, 0], g: [255, 0, 0], b: [255, 0, 0], y: [255, 0, 0] };
  const upd = (a: number[], v: number) => {
    if (v < a[0]!) a[0] = v;
    if (v > a[1]!) a[1] = v;
    a[2]! += v;
  };
  const colOf = new Int32Array(width);
  for (let x = 0; x < width; x++) colOf[x] = Math.min(c - 1, Math.floor((x * c) / width));
  for (let y = 0; y < height; y++) {
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const Y = lumaCode(r, g, b);
      const col = colOf[x]!;
      s.waveY[col * L + Y]!++;
      s.waveR[col * L + r]!++;
      s.waveG[col * L + g]!++;
      s.waveB[col * L + b]!++;
      s.histR[r]!++;
      s.histG[g]!++;
      s.histB[b]!++;
      s.histY[Y]!++;
      const yf = Y / 255;
      const vx = Math.min(V - 1, Math.max(0, Math.floor(((b / 255 - yf) / 1.8556 + 0.5) * V)));
      const vy = Math.min(V - 1, Math.max(0, Math.floor((0.5 - (r / 255 - yf) / 1.5748) * V)));
      s.vector[vy * V + vx]!++;
      upd(st.r, r);
      upd(st.g, g);
      upd(st.b, b);
      upd(st.y, Y);
    }
  }
  const n = Math.max(1, width * height);
  const fin = (a: number[]): ChannelStats => ({ min: a[0]!, max: a[1]!, mean: a[2]! / n });
  return {
    ...s,
    width,
    height,
    stats: { r: fin(st.r), g: fin(st.g), b: fin(st.b), y: fin(st.y), pixels: width * height },
  };
}

/** Intensity of a scope cell with `count` hits, 0..1 (log-like, `gain` = brightness). */
export const scopeIntensity = (count: number, gain: number): number => (count <= 0 ? 0 : 1 - Math.exp(-count * gain));

/** 75 % colour bar targets on the vectorscope (R, Mg, B, Cy, G, Yl), in 0..1 R′G′B′. */
export const VECTOR_TARGETS: { id: string; rgb: [number, number, number] }[] = [
  { id: 'R', rgb: [0.75, 0, 0] },
  { id: 'Mg', rgb: [0.75, 0, 0.75] },
  { id: 'B', rgb: [0, 0, 0.75] },
  { id: 'Cy', rgb: [0, 0.75, 0.75] },
  { id: 'G', rgb: [0, 0.75, 0] },
  { id: 'Yl', rgb: [0.75, 0.75, 0] },
];

/** Skin tone ("I") line angle on the vectorscope: 123° counter-clockwise from +Cb. */
export const SKIN_LINE_DEG = 123;
