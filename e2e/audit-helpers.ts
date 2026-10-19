/**
 * Measurement helpers for e2e/audit-export.spec.ts: synthetic media with known content, and
 * ffmpeg/ffprobe readers for exported files (stream facts, exact frames, PCM audio).
 *
 * The audit media lives in e2e/.audit-media/ (git-ignored) and is generated on first use:
 *  - v-code.mp4       540×960 30 fps 6 s. Every frame carries its frame number as an 8-bit barcode
 *                     (8 blocks across the middle band, MSB left) over an RGB gradient; frame 30
 *                     (t = 1.000 s) is a full white FLASH. Audio: silence + a 20 ms 1 kHz BEEP at
 *                     exactly 1.000 s (AAC, as a phone video would have).
 *  - v-code-tone.mp4  same picture (no flash), 4 s, steady 660 Hz tone at amplitude 0.25 (AAC).
 *  - a-440.wav / a-1k.wav   8 s sines at amplitude 0.25 (RMS −15.05 dBFS), PCM 48 kHz stereo.
 *  - a-loud.wav       4 s 440 Hz at amplitude 0.8 (two of these overlap past 0 dBFS).
 *  - a-click.wav      4 s silence + a 2 ms 1 kHz burst at exactly 1.500 s (PCM, no priming).
 *  - img-quad.png     600×600, four flat quadrants (red, green, blue, white).
 *  - c-hd-601matrix.mp4  1920×1080 smptebars tagged with the BT.601 matrix only (no primaries /
 *                     transfer) — ffmpeg's default; Chromium's <video> reads it as BT.709.
 *  - c-sd-untagged.mp4   640×360 smptebars with no colour tags — WebCodecs reads it as BT.709.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const AUDIT_MEDIA = path.join(here, '.audit-media');

export const AM = {
  code: 'v-code.mp4',
  codeTone: 'v-code-tone.mp4',
  a440: 'a-440.wav',
  a1k: 'a-1k.wav',
  loud: 'a-loud.wav',
  click: 'a-click.wav',
  quad: 'img-quad.png',
  colorHd601: 'c-hd-601matrix.mp4',
  colorSdUntagged: 'c-sd-untagged.mp4',
} as const;

export const amPath = (f: string) => path.join(AUDIT_MEDIA, f);

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });

/** geq expressions for the barcode picture. flashFrame < 0 = no flash. */
function codeGeq(flashFrame: number): string {
  const band = "between(Y,0.42*H,0.58*H)*gt(mod(X,W/8),W/40)*lt(mod(X,W/8),W/8-W/40)";
  const bit = 'mod(floor(N/pow(2,7-floor(X*8/W))),2)';
  const flash = `eq(N,${flashFrame})`;
  const ch = (bg: string) => `if(${flash},255,if(${band},if(${bit},230,20),${bg}))`;
  return `geq=r='${ch('40+150*X/W')}':g='${ch('40+150*Y/H')}':b='${ch('90')}'`;
}

export function ensureAuditMedia(): void {
  fs.mkdirSync(AUDIT_MEDIA, { recursive: true });
  const need = (f: string) => !fs.existsSync(amPath(f));
  const x264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-crf', '12', '-preset', 'veryfast'];
  if (need(AM.code))
    ff([
      '-f', 'lavfi', '-i', 'color=black:s=540x960:r=30:d=6',
      '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*1000*t)*gte(t,1)*lt(t,1.02)|0.8*sin(2*PI*1000*t)*gte(t,1)*lt(t,1.02)':s=48000:d=6",
      '-vf', codeGeq(30), ...x264, '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', amPath(AM.code),
    ]);
  if (need(AM.codeTone))
    ff([
      '-f', 'lavfi', '-i', 'color=black:s=540x960:r=30:d=4',
      '-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*660*t)|0.25*sin(2*PI*660*t)':s=48000:d=4",
      '-vf', codeGeq(-1), ...x264, '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', amPath(AM.codeTone),
    ]);
  const wav = (file: string, expr: string, d: number) => need(file) && ff(['-f', 'lavfi', '-i', `aevalsrc='${expr}|${expr}':s=48000:d=${d}`, '-c:a', 'pcm_s16le', amPath(file)]);
  wav(AM.a440, '0.25*sin(2*PI*440*t)', 8);
  wav(AM.a1k, '0.25*sin(2*PI*1000*t)', 8);
  wav(AM.loud, '0.8*sin(2*PI*440*t)', 4);
  wav(AM.click, '0.9*sin(2*PI*1000*t)*gte(t,1.5)*lt(t,1.502)', 4);
  if (need(AM.colorHd601))
    ff(['-f', 'lavfi', '-i', 'smptebars=size=1920x1080:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', 'colormatrix=bt470bg', '-movflags', '+faststart', amPath(AM.colorHd601)]);
  if (need(AM.colorSdUntagged))
    ff([
      '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-bsf:v', 'h264_metadata=matrix_coefficients=2:colour_primaries=2:transfer_characteristics=2', '-movflags', '+faststart', amPath(AM.colorSdUntagged),
    ]);
  if (need(AM.quad))
    ff([
      '-f', 'lavfi', '-i', 'color=black:s=600x600:d=1', '-frames:v', '1',
      '-vf', "geq=r='if(lt(Y,H/2),if(lt(X,W/2),230,20),if(lt(X,W/2),20,230))':g='if(lt(Y,H/2),if(lt(X,W/2),20,230),if(lt(X,W/2),20,230))':b='if(lt(Y,H/2),20,230)'",
      amPath(AM.quad),
    ]);
}

// ---------------------------------------------------------------- ffprobe

export interface StreamFacts {
  formatDuration: number;
  v: { codec: string; profile: string; width: number; height: number; fps: number; frames: number; duration: number; pixFmt: string; colorPrimaries?: string } | null;
  a: { codec: string; profile: string; sampleRate: number; channels: number; duration: number } | null;
}

export function probeStreams(file: string): StreamFacts {
  const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  const j = JSON.parse(out) as { format: { duration?: string }; streams: Record<string, string | number | undefined>[] };
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const rate = (r: unknown) => {
    const [n, d] = String(r ?? '0/1').split('/').map(Number);
    return n && d ? n / d : 0;
  };
  return {
    formatDuration: Number(j.format.duration ?? NaN),
    v: v
      ? {
          codec: String(v.codec_name),
          profile: String(v.profile),
          width: Number(v.width),
          height: Number(v.height),
          fps: rate(v.avg_frame_rate),
          frames: Number(v.nb_read_frames ?? v.nb_frames),
          duration: Number(v.duration),
          pixFmt: String(v.pix_fmt),
          colorPrimaries: v.color_primaries as string | undefined,
        }
      : null,
    a: a
      ? { codec: String(a.codec_name), profile: String(a.profile), sampleRate: Number(a.sample_rate), channels: Number(a.channels), duration: Number(a.duration) }
      : null,
  };
}

// ---------------------------------------------------------------- pictures

export interface Rgb {
  w: number;
  h: number;
  data: Buffer; // rgb24
}

/** Decodes frame `n` (exact, by index) of a video, scaled to w×h, as RGB. */
export function videoFrame(file: string, n: number, w: number, h: number): Rgb {
  const data = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),scale=${w}:${h}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (data.length !== w * h * 3) throw new Error(`frame ${n} of ${path.basename(file)}: got ${data.length} bytes`);
  return { w, h, data };
}

/** Decodes an image file (PNG from the preview canvas), scaled to w×h, as RGB. */
export function imageRgb(file: string, w: number, h: number): Rgb {
  const data = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${w}:${h}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return { w, h, data };
}

/** Mean absolute difference (0..255) and PSNR (dB) between two same-size RGB images. */
export function compare(a: Rgb, b: Rgb): { mad: number; psnr: number } {
  if (a.data.length !== b.data.length) throw new Error('size mismatch');
  let sad = 0;
  let sse = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = a.data[i]! - b.data[i]!;
    sad += Math.abs(d);
    sse += d * d;
  }
  const n = a.data.length;
  const mse = sse / n;
  return { mad: sad / n, psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse) };
}

/** Mean RGB of a normalised rectangle. */
export function meanRgb(img: Rgb, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const xa = Math.floor(x0 * img.w);
  const xb = Math.max(xa + 1, Math.floor(x1 * img.w));
  const ya = Math.floor(y0 * img.h);
  const yb = Math.max(ya + 1, Math.floor(y1 * img.h));
  const s = [0, 0, 0];
  let n = 0;
  for (let y = ya; y < yb; y++)
    for (let x = xa; x < xb; x++) {
      const i = (y * img.w + x) * 3;
      s[0]! += img.data[i]!;
      s[1]! += img.data[i + 1]!;
      s[2]! += img.data[i + 2]!;
      n++;
    }
  return [s[0]! / n, s[1]! / n, s[2]! / n];
}

export const lum = (c: [number, number, number]) => (c[0] + c[1] + c[2]) / 3;

/**
 * Reads the 8-bit barcode of v-code.mp4 from an image, given the normalised rectangle where the
 * source picture sits in it (default: the whole image). Returns -1 for the white flash, null if
 * the bars are not crisp (a transition, a blend…).
 */
export function readBarcode(img: Rgb, box = { x: 0, y: 0, w: 1, h: 1 }): number | null {
  const all = lum(meanRgb(img, box.x + box.w * 0.05, box.y + box.h * 0.05, box.x + box.w * 0.95, box.y + box.h * 0.35));
  if (all > 245) return -1;
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const cx = box.x + box.w * ((i + 0.5) / 8);
    const cy = box.y + box.h * 0.5;
    const l = lum(meanRgb(img, cx - box.w * 0.02, cy - box.h * 0.03, cx + box.w * 0.02, cy + box.h * 0.03));
    if (l > 70 && l < 180) return null;
    v = v * 2 + (l >= 180 ? 1 : 0);
  }
  return v;
}

// ---------------------------------------------------------------- audio

export interface Pcm {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

/** Decodes the audio of a file to 48 kHz float stereo (honours the MP4 edit list). */
export function decodeAudio(file: string): Pcm {
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 512 * 1024 * 1024 });
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const n = all.length / 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = all[2 * i]!;
    right[i] = all[2 * i + 1]!;
  }
  return { sampleRate: 48000, left, right };
}

/** RMS in dBFS of both channels between t0 and t1 (seconds). −120 for digital silence. */
export function rmsDb(p: Pcm, t0: number, t1: number): number {
  const a = Math.max(0, Math.floor(t0 * p.sampleRate));
  const b = Math.min(p.left.length, Math.floor(t1 * p.sampleRate));
  let s = 0;
  for (let i = a; i < b; i++) s += p.left[i]! * p.left[i]! + p.right[i]! * p.right[i]!;
  const n = Math.max(1, (b - a) * 2);
  const r = Math.sqrt(s / n);
  return r <= 1e-6 ? -120 : 20 * Math.log10(r);
}

export function peakAbs(p: Pcm, t0 = 0, t1 = Infinity): number {
  const a = Math.max(0, Math.floor(t0 * p.sampleRate));
  const b = Math.min(p.left.length, Math.floor(t1 * p.sampleRate));
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(p.left[i]!), Math.abs(p.right[i]!));
  return m;
}

/** First sample index whose |value| passes `threshold`, or -1. */
export function onsetSample(p: Pcm, threshold: number, fromSec = 0): number {
  for (let i = Math.floor(fromSec * p.sampleRate); i < p.left.length; i++) if (Math.abs(p.left[i]!) >= threshold) return i;
  return -1;
}

/** Last sample index whose |value| passes `threshold`, or -1. */
export function lastLoudSample(p: Pcm, threshold: number): number {
  for (let i = p.left.length - 1; i >= 0; i--) if (Math.abs(p.left[i]!) >= threshold) return i;
  return -1;
}

/** Dominant frequency between t0 and t1 by zero-crossing count (fine for pure tones). */
export function zeroCrossHz(p: Pcm, t0: number, t1: number): number {
  const a = Math.floor(t0 * p.sampleRate);
  const b = Math.floor(t1 * p.sampleRate);
  let z = 0;
  for (let i = a + 1; i < b; i++) if ((p.left[i - 1]! < 0) !== (p.left[i]! < 0)) z++;
  return z / 2 / ((b - a) / p.sampleRate);
}

/** ffmpeg volumedetect over [t0, t1) of the file: mean and max volume in dB. */
export function volumedetect(file: string, t0 = 0, t1 = 1e9): { mean: number; max: number } {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `atrim=${t0}:${t1},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const num = (k: string) => Number(new RegExp(`${k}:\\s*(-?[\\d.]+|-inf) dB`).exec(r.stderr)?.[1]?.replace('-inf', '-120') ?? NaN);
  return { mean: num('mean_volume'), max: num('max_volume') };
}

/** Mean RGB of a small patch of frame 0 of a source, decoded by ffmpeg with an explicit matrix. */
export function referenceRgb(file: string, fx: number, fy: number, matrix: 'bt601' | 'bt709'): [number, number, number] {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim().split(',').map(Number) as [number, number];
  const cw = Math.round(w * 0.04);
  const ch = Math.round(h * 0.04);
  const buf = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1',
    '-vf', `crop=${cw}:${ch}:${Math.round(w * fx - cw / 2)}:${Math.round(h * fy - ch / 2)},scale=1:1:flags=area:in_color_matrix=${matrix}:in_range=tv,format=rgb24`,
    '-f', 'rawvideo', '-',
  ]);
  return [buf[0]!, buf[1]!, buf[2]!];
}
