import { describe, expect, it } from 'vitest';
import {
  CURVE_PRESETS,
  curveIntegral,
  curveIntegralInverse,
  curveMean,
  curveSpeedAt,
  curveYToSpeed,
  extendCurve,
  normalizeCurve,
  presetCurve,
  sliceCurve,
  speedToCurveY,
  type SpeedCurve,
} from './speedCurve';
import { localTimeForSourceOffset, sourceOffsetAt, sourceSpan, sourceTimeAt, speedAtTime } from './time';

/** Deterministic PRNG (mulberry32) for property tests. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plain composite-Simpson integral of the speed, independent of the GL table. */
function simpson(curve: SpeedCurve, a: number, b: number, n = 20000): number {
  const h = (b - a) / n;
  let s = curveSpeedAt(curve, a) + curveSpeedAt(curve, b);
  for (let i = 1; i < n; i++) s += curveSpeedAt(curve, a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

function randomCurve(r: () => number): SpeedCurve {
  const n = 2 + Math.floor(r() * 7);
  const xs = [0, 1, ...Array.from({ length: n - 2 }, () => 0.02 + r() * 0.96)].sort((a, b) => a - b);
  return { preset: 'custom', points: xs.map((x) => ({ x, v: Math.pow(10, r() * 2 - 1) })) };
}

describe('speed curve evaluation', () => {
  it('passes through every point and is flat there', () => {
    for (const p of CURVE_PRESETS) {
      const c = presetCurve(p.id);
      for (const q of c.points) expect(curveSpeedAt(c, q.x)).toBeCloseTo(q.v, 9);
    }
  });

  it('stays between neighbouring point values (no overshoot with flat points)', () => {
    const r = rng(1);
    for (let k = 0; k < 50; k++) {
      const c = randomCurve(r);
      for (let i = 0; i < c.points.length - 1; i++) {
        const a = c.points[i]!;
        const b = c.points[i + 1]!;
        for (let j = 0; j <= 10; j++) {
          const v = curveSpeedAt(c, a.x + ((b.x - a.x) * j) / 10);
          expect(v).toBeGreaterThanOrEqual(Math.min(a.v, b.v) - 1e-9);
          expect(v).toBeLessThanOrEqual(Math.max(a.v, b.v) + 1e-9);
        }
      }
    }
  });

  it('flat 1x curve integrates to x', () => {
    const c = presetCurve('custom');
    for (const x of [0, 0.1, 0.33, 0.5, 0.9, 1]) expect(curveIntegral(c, x)).toBeCloseTo(x, 12);
    expect(curveMean(c)).toBeCloseTo(1, 12);
  });

  it('constant curve at v integrates to v·x', () => {
    const c: SpeedCurve = { preset: 'custom', points: [{ x: 0, v: 3 }, { x: 0.4, v: 3 }, { x: 1, v: 3 }] };
    expect(curveIntegral(c, 0.7)).toBeCloseTo(2.1, 12);
  });

  it('property: F(x) equals a Simpson integral of the speed (random curves and presets)', () => {
    const r = rng(42);
    const curves = [...CURVE_PRESETS.map((p) => presetCurve(p.id)), ...Array.from({ length: 40 }, () => randomCurve(r))];
    for (const c of curves) {
      for (let k = 0; k < 6; k++) {
        const x = r();
        const ref = simpson(c, 0, x);
        expect(Math.abs(curveIntegral(c, x) - ref)).toBeLessThan(1e-7 * Math.max(1, ref));
      }
      expect(Math.abs(curveMean(c) - simpson(c, 0, 1))).toBeLessThan(1e-7);
    }
  });

  it('property: F is strictly increasing and the inverse round-trips', () => {
    const r = rng(7);
    for (let k = 0; k < 60; k++) {
      const c = randomCurve(r);
      let prev = -1;
      for (let i = 0; i <= 50; i++) {
        const f = curveIntegral(c, i / 50);
        expect(f).toBeGreaterThan(prev);
        prev = f;
      }
      for (let j = 0; j < 8; j++) {
        const x = r();
        expect(curveIntegralInverse(c, curveIntegral(c, x))).toBeCloseTo(x, 9);
        const y = r() * curveMean(c);
        expect(curveIntegral(c, curveIntegralInverse(c, y))).toBeCloseTo(y, 9);
      }
    }
  });

  it('extrapolates with the end speeds outside [0, 1]', () => {
    const c = presetCurve('flash-in'); // 3x … 1x
    expect(curveSpeedAt(c, -0.5)).toBe(3);
    expect(curveSpeedAt(c, 1.5)).toBe(1);
    expect(curveIntegral(c, 1.2) - curveIntegral(c, 1)).toBeCloseTo(0.2, 12);
    expect(curveIntegral(c, -0.1)).toBeCloseTo(-0.3, 12);
    expect(curveIntegralInverse(c, curveMean(c) + 0.5)).toBeCloseTo(1.5, 12);
  });

  it('log axis of the editor: 0.1x bottom, 1x middle, 10x top', () => {
    expect(speedToCurveY(0.1)).toBeCloseTo(0, 12);
    expect(speedToCurveY(1)).toBeCloseTo(0.5, 12);
    expect(speedToCurveY(10)).toBeCloseTo(1, 12);
    for (const v of [0.1, 0.3, 1, 2.7, 10]) expect(curveYToSpeed(speedToCurveY(v))).toBeCloseTo(v, 9);
  });
});

describe('presets', () => {
  it('has CapCut’s seven curve tiles (after None) in order', () => {
    expect(CURVE_PRESETS.map((p) => p.label)).toEqual(['Custom', 'Montage', 'Hero', 'Bullet', 'Jump cut', 'Flash in', 'Flash out']);
  });
  it('custom starts as five flat 1x beats', () => {
    expect(presetCurve('custom').points).toEqual([0, 0.25, 0.5, 0.75, 1].map((x) => ({ x, v: 1 })));
  });
  it('shapes: bullet dips, jump cut peaks, flash in slows down, flash out speeds up', () => {
    const at = (id: Parameters<typeof presetCurve>[0], x: number) => curveSpeedAt(presetCurve(id), x);
    expect(at('bullet', 0.48)).toBeLessThan(0.3);
    expect(at('bullet', 0.1)).toBeGreaterThan(2.5);
    expect(at('jump-cut', 0.5)).toBeGreaterThan(2.9);
    expect(at('jump-cut', 0.1)).toBeLessThan(0.4);
    expect(at('flash-in', 0.1)).toBeGreaterThan(at('flash-in', 0.9));
    expect(at('flash-out', 0.1)).toBeLessThan(at('flash-out', 0.9));
    expect(at('montage', 0.43)).toBeGreaterThan(3.5);
    expect(at('montage', 0.68)).toBeLessThan(0.3);
    expect(at('hero', 0.3)).toBeGreaterThan(2.5);
    expect(at('hero', 0.48)).toBeLessThan(0.35);
  });
  it('a copy is independent of the table', () => {
    const c = presetCurve('hero');
    c.points[1]!.v = 9;
    expect(presetCurve('hero').points[1]!.v).toBe(2.7);
  });
  it('normalizeCurve sorts, clamps to 0.1–10 and pins the ends', () => {
    const c = normalizeCurve({ preset: 'custom', points: [{ x: 0.9, v: 50 }, { x: 0.1, v: 0.01 }, { x: 0.5, v: 1 }] });
    expect(c.points).toEqual([{ x: 0, v: 0.1 }, { x: 0.5, v: 1 }, { x: 1, v: 10 }]);
  });
});

describe('slicing and extending (split / trim)', () => {
  it('property: a slice reproduces the original speed and integral exactly', () => {
    const r = rng(99);
    for (let k = 0; k < 60; k++) {
      const c = k < CURVE_PRESETS.length ? presetCurve(CURVE_PRESETS[k]!.id) : randomCurve(r);
      const a = r() * 0.6;
      const b = a + 0.05 + r() * (1 - a - 0.05);
      const s = sliceCurve(c, a, b);
      expect(s.points[0]!.x).toBe(0);
      expect(s.points.at(-1)!.x).toBe(1);
      const w = b - a;
      for (let j = 0; j <= 20; j++) {
        const u = j / 20;
        expect(curveSpeedAt(s, u)).toBeCloseTo(curveSpeedAt(c, a + u * w), 9);
      }
      // ∫ over the slice (in original units) = F(b) − F(a)
      expect(curveMean(s) * w).toBeCloseTo(curveIntegral(c, b) - curveIntegral(c, a), 9);
      // slicing a slice again is still exact
      const s2 = sliceCurve(s, 0.25, 0.75);
      expect(curveSpeedAt(s2, 0.5)).toBeCloseTo(curveSpeedAt(c, a + 0.5 * w), 9);
    }
  });

  it('left + right pieces of a split add up to the whole', () => {
    const c = presetCurve('montage');
    const x = 0.55;
    const left = sliceCurve(c, 0, x);
    const right = sliceCurve(c, x, 1);
    expect(curveMean(left) * x + curveMean(right) * (1 - x)).toBeCloseTo(curveMean(c), 10);
  });

  it('extendCurve keeps the original part identical in output time', () => {
    const c = presetCurve('hero');
    const D = 2_000_000;
    const e = extendCurve(c, D, 300_000, 500_000);
    const D2 = D + 800_000;
    for (let j = 0; j <= 10; j++) {
      const tau = (j / 10) * D;
      expect(curveSpeedAt(e, (300_000 + tau) / D2)).toBeCloseTo(curveSpeedAt(c, tau / D), 9);
    }
    // a piece cut in the middle of a ramp (non-zero end slopes) still extends exactly flat
    const cut = sliceCurve(presetCurve('flash-out'), 0.2, 0.5);
    const ext = extendCurve(cut, 1_000_000, 400_000, 600_000);
    for (const x of [0, 0.1, 0.2, 0.28]) expect(curveSpeedAt(ext, x)).toBeCloseTo(cut.points[0]!.v, 9);
    for (const x of [0.72, 0.8, 0.9, 1]) expect(curveSpeedAt(ext, x)).toBeCloseTo(cut.points.at(-1)!.v, 9);
    for (let j = 0; j <= 10; j++) expect(curveSpeedAt(ext, (400_000 + j * 100_000) / 2_000_000)).toBeCloseTo(curveSpeedAt(cut, j / 10), 9);
    // the added parts run at the end speeds
    expect(curveSpeedAt(e, 0)).toBeCloseTo(1, 9);
    expect(curveSpeedAt(e, 1)).toBeCloseTo(1, 9);
  });
});

describe('clip time mapping (model/time)', () => {
  const base = { start: 1_000_000, inPoint: 500_000, duration: 4_000_000, speed: 1 };

  it('standard speed: src = inPoint + τ·speed', () => {
    const c = { ...base, speed: 2, speedCurve: null };
    expect(sourceTimeAt(c, 2_000_000)).toBe(2_500_000);
    expect(sourceSpan(c)).toBe(8_000_000);
    expect(localTimeForSourceOffset(c, 3_000_000)).toBe(1_500_000);
    expect(speedAtTime(c, 0)).toBe(2);
  });

  it('a clip without the field (old project) maps like standard speed', () => {
    expect(sourceTimeAt({ ...base, speed: 0.5 }, 3_000_000)).toBe(1_500_000);
  });

  it('curve: src(τ) = D·F(τ/D); span = D·mean; inverse round-trips', () => {
    const curve = presetCurve('bullet');
    const c = { ...base, speedCurve: curve };
    const D = base.duration;
    expect(sourceSpan(c)).toBe(Math.round(D * curveMean(curve)));
    const r = rng(3);
    for (let k = 0; k < 30; k++) {
      const tau = r() * D;
      const ref = D * simpson(curve, 0, tau / D, 4000);
      expect(Math.abs(sourceOffsetAt(c, tau) - ref)).toBeLessThan(1);
      expect(Math.abs(sourceTimeAt(c, base.start + tau) - Math.round(base.inPoint + ref))).toBeLessThanOrEqual(1);
      expect(localTimeForSourceOffset(c, sourceOffsetAt(c, tau))).toBeCloseTo(tau, 3);
      expect(speedAtTime(c, base.start + tau)).toBeCloseTo(curveSpeedAt(curve, tau / D), 12);
    }
  });

  it('property: numeric integral of speedAtTime matches sourceTimeAt for every preset', () => {
    for (const p of CURVE_PRESETS) {
      const c = { ...base, speedCurve: presetCurve(p.id) };
      const n = 8000;
      const h = c.duration / n;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const t = c.start + (i + 0.5) * h;
        acc += speedAtTime(c, t) * h; // midpoint rule
      }
      expect(Math.abs(c.inPoint + acc - sourceTimeAt(c, c.start + c.duration))).toBeLessThan(5);
    }
  });
});
