/** Parsing / formatting for inspector number fields. Pure. */

/** "100%", " -12.5dB", "1,5x", "−3" → number; null when there is no number in it. */
export function parseNumber(text: string): number | null {
  const t = text.replace(/−/g, '-').replace(',', '.').trim();
  if (/^-?∞/.test(t) || /^-inf/i.test(t)) return -Infinity;
  const m = t.match(/-?\d*\.?\d+(e-?\d+)?/i);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** Percent of a 0..1 value for display (opacity, intensity). */
export const toPct = (v: number): number => Math.round(v * 100);
export const fromPct = (v: number): number => Math.min(1, Math.max(0, v / 100));
