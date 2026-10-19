import { describe, expect, it } from 'vitest';
import {
  ANIM_CATEGORIES,
  ANIMATION_CATALOG,
  EASE,
  IDENTITY_FRAME,
  animationFrame,
  animationsFor,
  composeFrames,
  findAnimation,
  mirrorFrame,
  noise,
  phasesFor,
  type AnimDef,
  type AnimFrame,
  type AnimPhase,
} from './animations';

const SCALARS = ['dx', 'dy', 'scale', 'sx', 'sy', 'skewX', 'skewY', 'pivotX', 'pivotY', 'rotation', 'alpha', 'blur', 'brightness', 'hue', 'glow', 'rgbSplit', 'slices', 'reveal'] as const;
type Scalar = (typeof SCALARS)[number];
const ANGLES: Scalar[] = ['rotation', 'hue'];

/** Angle difference folded into (−180, 180]. */
const angleDiff = (a: number, b: number) => {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return Math.abs(d);
};

function expectIdentity(f: AnimFrame, where: string) {
  for (const key of SCALARS) {
    if (key === 'pivotX' || key === 'pivotY') continue; // a pivot does nothing at sx = sy = 1, skew = 0
    const v = f[key];
    const id = IDENTITY_FRAME[key];
    const diff = ANGLES.includes(key) ? angleDiff(v, id) : Math.abs(v - id);
    expect(diff, `${where} ${key}=${v}`).toBeLessThan(1e-6);
  }
  expect(f.mask, `${where} mask`).toBeNull();
}

function expectFinite(f: AnimFrame, where: string) {
  for (const key of SCALARS) expect(Number.isFinite(f[key]), `${where} ${key}=${f[key]}`).toBe(true);
  expect(Number.isFinite(f.seed)).toBe(true);
  for (const m of f.mask ?? []) {
    const nums = m.kind === 'rect' ? [m.x, m.y, m.w, m.h] : m.kind === 'circle' ? [m.cx, m.cy, m.r] : m.pts.flat();
    for (const n of nums) expect(Number.isFinite(n), `${where} mask`).toBe(true);
  }
}

const isIdentity = (f: AnimFrame) =>
  SCALARS.every((k) => k === 'pivotX' || k === 'pivotY' || (ANGLES.includes(k) ? angleDiff(f[k], IDENTITY_FRAME[k]) : Math.abs(f[k] - IDENTITY_FRAME[k])) < 1e-6) && !f.mask;

/** Max step-to-step change per field, sampled at N steps. */
const TOL: Record<Scalar, number> = {
  dx: 0.01,
  dy: 0.01,
  scale: 0.01,
  sx: 0.01,
  sy: 0.01,
  skewX: 0.5,
  skewY: 0.5,
  pivotX: 0,
  pivotY: 0,
  rotation: 1,
  alpha: 0.01,
  blur: 0.5,
  brightness: 0.01,
  hue: 1,
  glow: 0.01,
  rgbSplit: 0.5,
  slices: 0.5,
  reveal: 0.01,
};

function label(d: AnimDef) {
  return `${d.phase}:${d.id}`;
}

describe('animation catalogue', () => {
  it('has a large library: ≥30 In, ≥30 Out, ≥15 Combo, ≥12 text Loop', () => {
    const count = (p: AnimPhase) => ANIMATION_CATALOG.filter((d) => d.phase === p).length;
    expect(count('in')).toBeGreaterThanOrEqual(30);
    expect(count('out')).toBeGreaterThanOrEqual(30);
    expect(count('combo')).toBeGreaterThanOrEqual(15);
    expect(count('loop')).toBeGreaterThanOrEqual(12);
  });

  it('ids are unique per phase and every def has a label and a category', () => {
    for (const phase of ['in', 'out', 'combo', 'loop'] as const) {
      const ids = ANIMATION_CATALOG.filter((d) => d.phase === phase).map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    for (const d of ANIMATION_CATALOG) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.categories.length).toBeGreaterThan(0);
    }
  });

  it('every category chip has animations in In and Out', () => {
    for (const c of ANIM_CATEGORIES) {
      expect(ANIMATION_CATALOG.some((d) => d.phase === 'in' && d.categories.includes(c.id)), c.id).toBe(true);
      expect(ANIMATION_CATALOG.some((d) => d.phase === 'out' && d.categories.includes(c.id)), c.id).toBe(true);
    }
  });

  it('keeps every v1 id in both In and Out (old projects keep working)', () => {
    for (const id of ['fade', 'zoom-in', 'zoom-out', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'rotate', 'blur']) {
      expect(findAnimation('in', id), id).toBeDefined();
      expect(findAnimation('out', id), id).toBeDefined();
    }
  });

  it('covers the CapCut families the brief asks for', () => {
    const ids = new Set(ANIMATION_CATALOG.filter((d) => d.phase === 'in').map((d) => d.id));
    for (const id of [
      'fade', 'zoom-in', 'zoom-out', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'rotate', 'flip', 'swing', 'shake', 'jelly',
      'bounce', 'drop-down', 'fly-in', 'stretch', 'blur', 'rotate-entry', 'flash', 'glow', 'rgb-split', 'slice', 'jitter', 'wipe-right',
      'circle', 'iris', 'mid-split', 'flip-3d', 'door', 'typewriter',
    ])
      expect(ids.has(id), id).toBe(true);
  });

  it('text-only animations are offered only to text; Loop only to text; Combo only to video/image', () => {
    expect(phasesFor('video')).toEqual(['in', 'out', 'combo']);
    expect(phasesFor('image')).toEqual(['in', 'out', 'combo']);
    expect(phasesFor('text')).toEqual(['in', 'out', 'loop']);
    expect(animationsFor('in', 'video').some((d) => d.id === 'typewriter')).toBe(false);
    expect(animationsFor('in', 'text').some((d) => d.id === 'typewriter')).toBe(true);
    expect(animationsFor('loop', 'text').length).toBeGreaterThanOrEqual(12);
  });
});

describe('every animation function', () => {
  for (const d of ANIMATION_CATALOG) {
    describe(label(d), () => {
      it('rest state at its ends (In ends at identity, Out starts at identity, Combo/Loop both)', () => {
        if (d.phase === 'in') expectIdentity(d.frame(1), `${label(d)} p=1`);
        if (d.phase === 'out') expectIdentity(d.frame(0), `${label(d)} p=0`);
        if (d.phase === 'combo' || d.phase === 'loop') {
          expectIdentity(d.frame(0), `${label(d)} p=0`);
          expectIdentity(d.frame(1), `${label(d)} p=1`);
        }
      });

      it('no NaN / Infinity anywhere, including out-of-range progress', () => {
        for (let i = -2; i <= 202; i++) {
          const f = d.frame(i / 200);
          const bad = SCALARS.find((k) => !Number.isFinite(f[k]));
          if (bad || !Number.isFinite(f.seed)) expectFinite(f, `${label(d)} p=${i / 200}`);
        }
        expectFinite(d.frame(0.5), `${label(d)} p=0.5`);
        expectFinite(animationFrame(d.phase, d.id, Number.NaN), `${label(d)} NaN`);
      });

      it('actually animates', () => {
        let moved = false;
        for (let i = 1; i < 50 && !moved; i++) moved = !isIdentity(d.frame(i / 50));
        expect(moved).toBe(true);
      });

      it(d.jumpy ? 'jumps only within an envelope that reaches rest' : 'is continuous', () => {
        const N = 4000;
        let prev = d.frame(0);
        const worst: Partial<Record<Scalar, { diff: number; p: number }>> = {};
        for (let i = 1; i <= N; i++) {
          const f = d.frame(i / N);
          if (!d.jumpy) {
            for (const key of SCALARS) {
              const diff = ANGLES.includes(key) ? angleDiff(f[key], prev[key]) : Math.abs(f[key] - prev[key]);
              if (diff > (worst[key]?.diff ?? 0)) worst[key] = { diff, p: i / N };
            }
          }
          prev = f;
        }
        for (const key of SCALARS) {
          const w = worst[key];
          if (w) expect(w.diff, `${label(d)} ${key} jumps at p=${w.p}`).toBeLessThanOrEqual(TOL[key]);
        }
        if (d.jumpy) {
          // approaching rest, the glitch fades out
          const near = d.phase === 'in' ? d.frame(0.999) : d.phase === 'out' ? d.frame(0.001) : d.frame(0.001);
          expect(near.rgbSplit).toBeLessThan(2);
          expect(near.slices).toBeLessThan(2);
          expect(Math.abs(near.dx)).toBeLessThan(0.01);
        }
      });
    });
  }
});

describe('specific motion', () => {
  it('Fade In is linear: 25 % progress = 25 % opacity; Fade Out mirrors it', () => {
    expect(animationFrame('in', 'fade', 0.25).alpha).toBeCloseTo(0.25);
    expect(animationFrame('out', 'fade', 0.25).alpha).toBeCloseTo(0.75);
  });

  it('slides enter from the far side and exit the named way', () => {
    expect(animationFrame('in', 'slide-left', 0).dx).toBeCloseTo(1); // from the right
    expect(animationFrame('out', 'slide-left', 1).dx).toBeCloseTo(-1); // to the left
    expect(animationFrame('in', 'slide-right', 0).dx).toBeCloseTo(-1);
    expect(animationFrame('in', 'slide-up', 0).dy).toBeCloseTo(1);
    expect(animationFrame('out', 'slide-down', 1).dy).toBeCloseTo(1);
    // cubic ease-out: at half time the slide is 87.5 % done
    expect(animationFrame('in', 'slide-left', 0.5).dx).toBeCloseTo(0.125);
  });

  it('zoom In grows into place; Zoom In (Out) keeps growing', () => {
    expect(animationFrame('in', 'zoom-in', 0).scale).toBeCloseTo(0.5);
    expect(animationFrame('out', 'zoom-in', 1).scale).toBeCloseTo(1.5);
    expect(animationFrame('out', 'zoom-out', 1).scale).toBeCloseTo(0.5);
  });

  it('wipes and reveals grow their mask', () => {
    const w = animationFrame('in', 'wipe-right', 0.5).mask!;
    expect(w[0]).toMatchObject({ kind: 'rect', x: 0, y: 0, h: 1 });
    expect((w[0] as { w: number }).w).toBeCloseTo(0.875);
    const o = animationFrame('out', 'wipe-right', 0.5).mask!;
    expect((o[0] as { x: number }).x).toBeCloseTo(0.125); // removes from the left, continuing right
    const c = animationFrame('in', 'circle', 0).mask!;
    expect(c[0]).toMatchObject({ kind: 'circle', cx: 0.5, cy: 0.5, r: 0 });
    const m = animationFrame('in', 'mid-split', 0).mask![0] as { x: number; w: number };
    expect(m.x).toBeCloseTo(0.5);
    expect(m.w).toBeCloseTo(0);
  });

  it('3D flips squash to edge-on', () => {
    expect(animationFrame('in', 'flip', 0).sx).toBeCloseTo(0);
    expect(animationFrame('in', 'door', 0).pivotX).toBe(-0.5);
    expect(animationFrame('in', 'flip-v', 0).sy).toBeCloseTo(0);
  });

  it('typewriter reveals characters', () => {
    expect(animationFrame('in', 'typewriter', 0.4).reveal).toBeCloseTo(0.4);
    expect(animationFrame('out', 'typewriter', 0.4).reveal).toBeCloseTo(0.6);
  });

  it('glitch is deterministic (preview = export)', () => {
    expect(animationFrame('in', 'glitch-intro', 0.3)).toEqual(animationFrame('in', 'glitch-intro', 0.3));
    expect(noise(3, 4)).toBe(noise(3, 4));
    expect(Math.abs(noise(3, 4))).toBeLessThanOrEqual(1);
  });

  it('unknown ids are at rest', () => {
    expectIdentity(animationFrame('in', 'no-such-animation', 0.3), 'unknown');
  });
});

describe('helpers', () => {
  it('easings start at 0 and end at 1', () => {
    for (const [name, e] of Object.entries(EASE)) {
      expect(e(0), name).toBeCloseTo(0);
      expect(e(1), name).toBeCloseTo(1);
    }
  });

  it('mirrorFrame flips directions only', () => {
    expect(mirrorFrame({ dx: 0.3, dy: -0.2, rotation: 10, alpha: 0.5, scale: 2 })).toEqual({ dx: -0.3, dy: 0.2, rotation: -10, alpha: 0.5, scale: 2 });
  });

  it('composeFrames: offsets add, multipliers multiply, masks intersect, reveal takes the min', () => {
    const a = { ...IDENTITY_FRAME, dx: 0.1, scale: 2, alpha: 0.5, mask: [{ kind: 'rect' as const, x: 0, y: 0, w: 0.5, h: 1 }], reveal: 0.5 };
    const b = { ...IDENTITY_FRAME, dx: 0.2, scale: 1.5, alpha: 0.5, rotation: 10, reveal: 0.8 };
    const { frame, masks } = composeFrames([a, b]);
    expect(frame.dx).toBeCloseTo(0.3);
    expect(frame.scale).toBeCloseTo(3);
    expect(frame.alpha).toBeCloseTo(0.25);
    expect(frame.rotation).toBe(10);
    expect(frame.reveal).toBe(0.5);
    expect(masks).toHaveLength(1);
  });
});
