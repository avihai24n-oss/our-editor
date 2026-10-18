/**
 * Text layout: font string, word wrapping and the block box. Pure apart from the injected
 * `measure` function (ctx.measureText in the renderer, a fake in tests).
 *
 * Local coordinates: the block is centred on (0, 0); all sizes are project pixels before the
 * clip's transform.scale is applied.
 */
import type { TextStyle } from '../../model/types';

export type Measure = (text: string) => number;

export interface TextLine {
  text: string;
  width: number;
  /** Left edge of the line, local px. */
  x: number;
  /** Vertical centre of the line, local px. */
  y: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** Block size including padding. */
  width: number;
  height: number;
  lineHeightPx: number;
  padding: number;
}

export function fontString(s: Pick<TextStyle, 'italic' | 'bold' | 'fontSize' | 'fontFamily'>): string {
  const family = /[\s,]/.test(s.fontFamily) && !/["']/.test(s.fontFamily) && !s.fontFamily.includes(',') ? `"${s.fontFamily}"` : s.fontFamily;
  return `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${Math.max(1, s.fontSize)}px ${family}, system-ui, sans-serif`;
}

/** Greedy word wrap. Words longer than maxWidth are broken by character. */
export function wrapLine(text: string, maxWidth: number, measure: Measure): string[] {
  if (text === '' || measure(text) <= maxWidth) return [text];
  const words = text.split(/(\s+)/); // keep separators
  const out: string[] = [];
  let cur = '';
  const pushLongWord = (word: string) => {
    let piece = '';
    for (const ch of word) {
      if (piece && measure(piece + ch) > maxWidth) {
        out.push(piece);
        piece = ch;
      } else piece += ch;
    }
    return piece;
  };
  for (const w of words) {
    if (!w) continue;
    const next = cur + w;
    if (measure(next) <= maxWidth) {
      cur = next;
      continue;
    }
    if (/^\s+$/.test(w)) {
      // a space that does not fit ends the line
      if (cur) out.push(cur.trimEnd());
      cur = '';
      continue;
    }
    if (cur.trim()) out.push(cur.trimEnd());
    cur = measure(w) > maxWidth ? pushLongWord(w) : w;
  }
  if (cur.trim() || out.length === 0) out.push(cur.trimEnd());
  return out;
}

export function layoutText(style: TextStyle, rawLines: string[], measure: Measure, maxWidth: number): TextLayout {
  const lineHeightPx = style.fontSize * (style.lineHeight > 0 ? style.lineHeight : 1.2);
  const padding = style.background.enabled ? Math.round(style.fontSize * 0.3) : Math.round(style.fontSize * 0.1);
  const wrapped = rawLines.flatMap((l) => wrapLine(l, Math.max(style.fontSize, maxWidth - padding * 2), measure));
  const widths = wrapped.map((t) => measure(t));
  const contentW = Math.max(style.fontSize * 0.5, ...widths);
  const width = contentW + padding * 2;
  const height = wrapped.length * lineHeightPx + padding * 2;
  const top = -height / 2 + padding;
  const lines = wrapped.map((text, i) => {
    const w = widths[i] ?? 0;
    const x = style.align === 'left' ? -contentW / 2 : style.align === 'right' ? contentW / 2 - w : -w / 2;
    return { text, width: w, x, y: top + (i + 0.5) * lineHeightPx };
  });
  return { lines, width, height, lineHeightPx, padding };
}
