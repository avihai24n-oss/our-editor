/**
 * Adobe / Resolve `.cube` LUT files: parse, generate, and sample with trilinear interpolation.
 *
 * Format: optional TITLE, DOMAIN_MIN / DOMAIN_MAX, then LUT_3D_SIZE N (2..256) followed by N³
 * lines "r g b" with RED changing fastest, then green, then blue. LUT_1D_SIZE N files (N lines,
 * per-channel) are accepted and expanded to a 33³ cube. `#` starts a comment.
 */

export interface Lut3D {
  title: string;
  size: number;
  /** size³ RGB triplets, red fastest: index = r + g·N + b·N². Output values (usually 0..1). */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

export class CubeParseError extends Error {}

const MAX_3D = 129;
const EXPANDED_1D = 33;

export function parseCube(text: string): Lut3D {
  let title = '';
  let size3 = 0;
  let size1 = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]!;
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!line) continue;
    const c = line.charCodeAt(0);
    const isNum = (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43; // digit - . +
    if (!isNum) {
      const [key, ...rest] = line.split(/\s+/);
      const k = key!.toUpperCase();
      if (k === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
      else if (k === 'LUT_3D_SIZE') size3 = parseInt(rest[0] ?? '', 10);
      else if (k === 'LUT_1D_SIZE') size1 = parseInt(rest[0] ?? '', 10);
      else if (k === 'DOMAIN_MIN') domainMin = triple(rest, li);
      else if (k === 'DOMAIN_MAX') domainMax = triple(rest, li);
      // other keywords (LUT_3D_INPUT_RANGE, LUT_1D_INPUT_RANGE …) are ignored
      else if (k === 'LUT_3D_INPUT_RANGE' || k === 'LUT_1D_INPUT_RANGE') {
        const lo = Number(rest[0]);
        const hi = Number(rest[1]);
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          domainMin = [lo, lo, lo];
          domainMax = [hi, hi, hi];
        }
      }
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 3) throw new CubeParseError(`Line ${li + 1}: expected three numbers`);
    for (let i = 0; i < 3; i++) {
      const v = Number(parts[i]);
      if (!Number.isFinite(v)) throw new CubeParseError(`Line ${li + 1}: "${parts[i]}" is not a number`);
      values.push(v);
    }
  }
  for (let i = 0; i < 3; i++) if (!(domainMax[i]! > domainMin[i]!)) throw new CubeParseError('DOMAIN_MAX must be greater than DOMAIN_MIN');

  if (size3) {
    if (!(size3 >= 2 && size3 <= MAX_3D)) throw new CubeParseError(`LUT_3D_SIZE ${size3} is out of range (2–${MAX_3D})`);
    const want = size3 * size3 * size3 * 3;
    if (values.length !== want) throw new CubeParseError(`Expected ${want / 3} entries for a ${size3}³ LUT, found ${values.length / 3}`);
    return { title, size: size3, data: Float32Array.from(values), domainMin, domainMax };
  }
  if (size1) {
    if (!(size1 >= 2 && size1 <= 65536)) throw new CubeParseError(`LUT_1D_SIZE ${size1} is out of range`);
    if (values.length !== size1 * 3) throw new CubeParseError(`Expected ${size1} entries for a 1D LUT, found ${values.length / 3}`);
    return expand1D(title, values, size1, domainMin, domainMax);
  }
  throw new CubeParseError('Not a .cube LUT: LUT_3D_SIZE or LUT_1D_SIZE is missing');
}

function triple(rest: string[], li: number): [number, number, number] {
  const v = rest.slice(0, 3).map(Number);
  if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) throw new CubeParseError(`Line ${li + 1}: expected three numbers`);
  return [v[0]!, v[1]!, v[2]!];
}

/** Per-channel 1D LUT → equivalent 33³ cube with a 0..1 domain. */
function expand1D(title: string, v: number[], n: number, dmin: number[], dmax: number[]): Lut3D {
  const N = EXPANDED_1D;
  const lookup = (ch: number, x: number) => {
    const t = ((x - dmin[ch]!) / (dmax[ch]! - dmin[ch]!)) * (n - 1);
    const i = Math.max(0, Math.min(n - 2, Math.floor(t)));
    const f = Math.max(0, Math.min(1, t - i));
    return v[i * 3 + ch]! * (1 - f) + v[(i + 1) * 3 + ch]! * f;
  };
  const data = new Float32Array(N * N * N * 3);
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++) {
        const o = (r + g * N + b * N * N) * 3;
        const x = (k: number, ch: number) => dmin[ch]! + (k / (N - 1)) * (dmax[ch]! - dmin[ch]!);
        data[o] = lookup(0, x(r, 0));
        data[o + 1] = lookup(1, x(g, 1));
        data[o + 2] = lookup(2, x(b, 2));
      }
  return { title, size: N, data, domainMin: [dmin[0]!, dmin[1]!, dmin[2]!], domainMax: [dmax[0]!, dmax[1]!, dmax[2]!] };
}

/** Writes a 3D .cube file (tests, e2e fixtures, built-in looks). */
export function writeCube(size: number, fn: (r: number, g: number, b: number) => [number, number, number], title = 'Generated'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const o = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        lines.push(o.map((x) => x.toFixed(6)).join(' '));
      }
  return lines.join('\n') + '\n';
}

export const identityCube = (size = 17): string => writeCube(size, (r, g, b) => [r, g, b], 'Identity');

/** Trilinear lookup of an RGB triplet (0..1 input, mapped through the domain). */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const N = lut.size;
  const d = lut.data;
  const coord = (v: number, ch: number) => {
    const t = ((v - lut.domainMin[ch]!) / (lut.domainMax[ch]! - lut.domainMin[ch]!)) * (N - 1);
    return Math.max(0, Math.min(N - 1, t));
  };
  const x = coord(r, 0);
  const y = coord(g, 1);
  const z = coord(b, 2);
  const x0 = Math.min(N - 2, Math.floor(x));
  const y0 = Math.min(N - 2, Math.floor(y));
  const z0 = Math.min(N - 2, Math.floor(z));
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const at = (i: number, j: number, k: number) => d[((x0 + i) + (y0 + j) * N + (z0 + k) * N * N) * 3 + ch]!;
    const c00 = at(0, 0, 0) * (1 - fx) + at(1, 0, 0) * fx;
    const c10 = at(0, 1, 0) * (1 - fx) + at(1, 1, 0) * fx;
    const c01 = at(0, 0, 1) * (1 - fx) + at(1, 0, 1) * fx;
    const c11 = at(0, 1, 1) * (1 - fx) + at(1, 1, 1) * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    out[ch] = c0 * (1 - fz) + c1 * fz;
  }
  return out;
}
