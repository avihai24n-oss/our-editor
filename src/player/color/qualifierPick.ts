/** Qualifier eyedropper maths (pure): the HSL key ranges for a picked colour. */
import { luma, rgbToHsv } from '../../engine/color/math';
import type { QualifierSettings } from '../../model/colorPage';

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Qualifier ranges for a picked colour (0..1 RGB). `extend` = Shift: grow the current ranges to include it. */
export function qualifierFromPick(rgb: [number, number, number], cur: QualifierSettings, extend: boolean): QualifierSettings {
  const [h, s] = rgbToHsv(rgb);
  const S = s * 100;
  const L = luma(rgb) * 100;
  const chroma = Math.max(...rgb) - Math.min(...rgb);
  if (extend && cur.enabled) {
    // hue: the shortest arc that covers the current window and the new hue
    let hue = cur.hue;
    if (cur.hue.on && chroma > 0.04) {
      const d = ((h - cur.hue.center + 540) % 360) - 180; // signed distance −180..180
      const half = cur.hue.width / 2;
      if (Math.abs(d) > half) {
        const lo = d < 0 ? d : -half;
        const hi = d > 0 ? d : half;
        hue = { ...cur.hue, center: r1((((cur.hue.center + (lo + hi) / 2) % 360) + 360) % 360), width: r1(Math.min(360, hi - lo)) };
      }
    }
    return {
      ...cur,
      hue,
      sat: { ...cur.sat, low: r1(clampN(Math.min(cur.sat.low, S - 5), 0, 100)), high: r1(clampN(Math.max(cur.sat.high, S + 5), 0, 100)) },
      lum: { ...cur.lum, low: r1(clampN(Math.min(cur.lum.low, L - 5), 0, 100)), high: r1(clampN(Math.max(cur.lum.high, L + 5), 0, 100)) },
    };
  }
  return {
    ...cur,
    enabled: true,
    showMatte: cur.showMatte,
    hue: { on: chroma > 0.04, center: r1(h), width: 30, soft: 20 },
    sat: { on: true, low: r1(clampN(S - 25, 0, 100)), high: r1(clampN(S + 25, 0, 100)), soft: 10 },
    lum: { on: true, low: r1(clampN(L - 30, 0, 100)), high: r1(clampN(L + 30, 0, 100)), soft: 10 },
  };
}
