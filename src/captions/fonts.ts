/**
 * Registers the bundled caption fonts (src/captions/fonts/*.woff2, see fontFiles.ts) with the
 * document and starts loading them, so canvas text has them and the export's
 * `document.fonts.ready` waits for them. A no-op outside a browser (unit tests).
 */
import { FONT_FILES } from './fontFiles';

let started = false;
let ready: Promise<void> = Promise.resolve();

/** Registers every caption font face once; resolves when they have loaded (or failed). */
export function loadCaptionFonts(): Promise<void> {
  if (started) return ready;
  started = true;
  const doc = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }) : null;
  if (!doc?.fonts || typeof FontFace === 'undefined') return ready;
  // one face per file: a variable font serves the whole weight range it was listed with
  const byUrl = new Map<string, { family: string; min: number; max: number; range: string }>();
  for (const f of FONT_FILES) {
    const key = `${f.family}|${f.url}`;
    const e = byUrl.get(key);
    if (e) {
      e.min = Math.min(e.min, f.weight);
      e.max = Math.max(e.max, f.weight);
    } else byUrl.set(key, { family: f.family, min: f.weight, max: f.weight, range: f.range });
  }
  const loads: Promise<unknown>[] = [];
  for (const [key, e] of byUrl) {
    const url = key.slice(e.family.length + 1);
    const face = new FontFace(e.family, `url(${url}) format("woff2")`, {
      weight: e.min === e.max ? String(e.min) : `${e.min} ${e.max}`,
      unicodeRange: e.range,
      display: 'block',
    });
    doc.fonts.add(face);
    loads.push(face.load().catch(() => undefined));
  }
  ready = Promise.all(loads).then(() => undefined);
  return ready;
}

loadCaptionFonts();
