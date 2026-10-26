/**
 * Video scopes strip under the player (DaVinci Color page style): Waveform, RGB Parade,
 * Vectorscope (75 % targets + skin tone line) and Histogram of the graded frame on screen.
 * Toggled from the player bar ("Scopes"); each scope can be shown / hidden. Live while scrubbing
 * and playing (colorView.ts analyses at most ~12 frames per second).
 */
import { useEffect, useRef, useState } from 'react';
import { scopeIntensity, SKIN_LINE_DEG, VECTOR_SIZE, VECTOR_TARGETS, vectorPos, SCOPE_LEVELS, type ScopeData } from '../../engine/color/scopes';
import { onScopes, SCOPE_KINDS, useColorView, type ScopeKind } from './colorView';
import './scopes.css';

type Draw = (c: HTMLCanvasElement, d: ScopeData) => void;

const LEVEL_LINES = [0, 64, 128, 192, 255];

function ensure(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c.getContext('2d');
}

function levelGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  for (const l of LEVEL_LINES) {
    const y = Math.round((1 - l / 255) * (h - 1)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

/** One waveform block (cols × 256) of `wave` into `img` at x offset `ox`, tinted `tint`. */
function waveBlock(img: ImageData, ox: number, wave: Uint32Array, cols: number, gain: number, tint: [number, number, number]) {
  const W = img.width;
  const L = SCOPE_LEVELS;
  const px = img.data;
  for (let x = 0; x < cols; x++)
    for (let l = 0; l < L; l++) {
      const v = scopeIntensity(wave[x * L + l]!, gain);
      if (!v) continue;
      const o = ((L - 1 - l) * W + ox + x) * 4;
      px[o] = Math.min(255, px[o]! + tint[0] * v);
      px[o + 1] = Math.min(255, px[o + 1]! + tint[1] * v);
      px[o + 2] = Math.min(255, px[o + 2]! + tint[2] * v);
      px[o + 3] = 255;
    }
}

const colGain = (d: ScopeData) => 40 / Math.max(1, (d.height * d.width) / d.cols);

const drawWaveform: Draw = (c, d) => {
  const ctx = ensure(c, d.cols, SCOPE_LEVELS);
  if (!ctx) return;
  const img = ctx.createImageData(d.cols, SCOPE_LEVELS);
  waveBlock(img, 0, d.waveY, d.cols, colGain(d), [190, 255, 200]);
  ctx.putImageData(img, 0, 0);
  levelGrid(ctx, d.cols, SCOPE_LEVELS);
};

const PARADE_GAP = 4;
const drawParade: Draw = (c, d) => {
  const W = d.cols * 3 + PARADE_GAP * 2;
  const ctx = ensure(c, W, SCOPE_LEVELS);
  if (!ctx) return;
  const img = ctx.createImageData(W, SCOPE_LEVELS);
  const g = colGain(d);
  waveBlock(img, 0, d.waveR, d.cols, g, [255, 70, 70]);
  waveBlock(img, d.cols + PARADE_GAP, d.waveG, d.cols, g, [70, 255, 90]);
  waveBlock(img, (d.cols + PARADE_GAP) * 2, d.waveB, d.cols, g, [90, 140, 255]);
  ctx.putImageData(img, 0, 0);
  levelGrid(ctx, W, SCOPE_LEVELS);
};

let vecTint: Uint8ClampedArray | null = null;
/** Per-cell display colour of the vectorscope trace (the chroma of that cell at mid luma). */
function vectorTint(): Uint8ClampedArray {
  if (vecTint) return vecTint;
  const V = VECTOR_SIZE;
  const t = new Uint8ClampedArray(V * V * 3);
  for (let y = 0; y < V; y++)
    for (let x = 0; x < V; x++) {
      const cb = (x + 0.5) / V - 0.5;
      const cr = 0.5 - (y + 0.5) / V;
      const Y = 0.6;
      const r = Y + 1.5748 * cr;
      const b = Y + 1.8556 * cb;
      const g = (Y - 0.2126 * r - 0.0722 * b) / 0.7152;
      const o = (y * V + x) * 3;
      // desaturated towards white so the trace stays readable
      t[o] = 255 * Math.min(1, Math.max(0, 0.45 + 0.55 * r));
      t[o + 1] = 255 * Math.min(1, Math.max(0, 0.45 + 0.55 * g));
      t[o + 2] = 255 * Math.min(1, Math.max(0, 0.45 + 0.55 * b));
    }
  vecTint = t;
  return t;
}

let vecLayer: HTMLCanvasElement | null = null;
const VEC_OUT = 256;
const drawVector: Draw = (c, d) => {
  const V = VECTOR_SIZE;
  const ctx = ensure(c, VEC_OUT, VEC_OUT);
  if (!ctx) return;
  vecLayer ??= document.createElement('canvas');
  const lctx = ensure(vecLayer, V, V);
  if (!lctx) return;
  const img = lctx.createImageData(V, V);
  const tint = vectorTint();
  const gain = 600 / Math.max(1, d.width * d.height);
  for (let i = 0; i < V * V; i++) {
    const v = scopeIntensity(d.vector[i]!, gain);
    if (!v) continue;
    img.data[i * 4] = tint[i * 3]! * v;
    img.data[i * 4 + 1] = tint[i * 3 + 1]! * v;
    img.data[i * 4 + 2] = tint[i * 3 + 2]! * v;
    img.data[i * 4 + 3] = 255;
  }
  lctx.putImageData(img, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, VEC_OUT, VEC_OUT);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(vecLayer, 0, 0, VEC_OUT, VEC_OUT);
  // graticule
  const k = VEC_OUT / V;
  const cx = VEC_OUT / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cx, VEC_OUT / 2 - 1, 0, Math.PI * 2);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, VEC_OUT);
  ctx.moveTo(0, cx);
  ctx.lineTo(VEC_OUT, cx);
  ctx.stroke();
  // skin tone line
  const a = (SKIN_LINE_DEG * Math.PI) / 180;
  ctx.strokeStyle = 'rgba(255,200,150,0.55)';
  ctx.beginPath();
  ctx.moveTo(cx, cx);
  ctx.lineTo(cx + Math.cos(a) * (VEC_OUT / 2), cx - Math.sin(a) * (VEC_OUT / 2));
  ctx.stroke();
  // 75 % targets
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of VECTOR_TARGETS) {
    const [x, y] = vectorPos(t.rgb[0], t.rgb[1], t.rgb[2]);
    const px = x * k;
    const py = y * k;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px - 6, py - 6, 12, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const dx = px - cx;
    const dy = py - cx;
    const n = Math.hypot(dx, dy) || 1;
    ctx.fillText(t.id, px + (dx / n) * 20, py + (dy / n) * 20);
  }
};

const drawHistogram: Draw = (c, d) => {
  const W = 256;
  const H = 160;
  const ctx = ensure(c, W, H);
  if (!ctx) return;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  let max = 1;
  for (const h of [d.histR, d.histG, d.histB]) for (let i = 1; i < 255; i++) max = Math.max(max, h[i]!);
  const yOf = (n: number) => H - Math.min(H, (n / max) * (H - 6));
  ctx.globalCompositeOperation = 'lighter';
  const fills: [Uint32Array, string][] = [
    [d.histR, 'rgba(255,60,60,0.75)'],
    [d.histG, 'rgba(60,230,80,0.75)'],
    [d.histB, 'rgba(70,120,255,0.8)'],
  ];
  for (const [h, col] of fills) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo(i + 0.5, yOf(h[i]!));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 256; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, i + 0.5, yOf(d.histY[i]!));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  for (const x of [64, 128, 192]) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
  }
};

const DRAW: Record<ScopeKind, Draw> = { waveform: drawWaveform, parade: drawParade, vector: drawVector, histogram: drawHistogram };

function ScopeView({ kind, label }: { kind: ScopeKind; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState('');
  useEffect(
    () =>
      onScopes((d) => {
        const c = ref.current;
        if (!c) return;
        DRAW[kind](c, d);
        const s = d.stats;
        const pct = (v: number) => Math.round((v / 255) * 100);
        const txt =
          kind === 'waveform' || kind === 'histogram'
            ? `Y ${pct(s.y.min)}–${pct(s.y.max)}%`
            : kind === 'parade'
              ? `R ${pct(s.r.max)} G ${pct(s.g.max)} B ${pct(s.b.max)}%`
              : '';
        setStats((p) => (p === txt ? p : txt));
      }),
    [kind],
  );
  const levels = kind === 'waveform' || kind === 'parade';
  return (
    <div className={`scope scope--${kind}`} data-testid={`scope-${kind}`}>
      <div className="scope__head">
        <span className="scope__title">{label}</span>
        <span className="scope__stats">{stats}</span>
      </div>
      <div className="scope__body">
        {levels && (
          <div className="scope__levels" aria-hidden>
            {[100, 75, 50, 25, 0].map((v) => (
              <span key={v}>{v}</span>
            ))}
          </div>
        )}
        <canvas ref={ref} className="scope__canvas" />
      </div>
    </div>
  );
}

export function ScopesPanel() {
  const kinds = useColorView((s) => s.kinds);
  const toggleKind = useColorView((s) => s.toggleKind);
  const setScopes = useColorView((s) => s.setScopes);
  return (
    <div className="scopes" data-testid="scopes-panel">
      <div className="scopes__bar">
        <span className="scopes__title">Scopes</span>
        {SCOPE_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            className={`scopes__chip${kinds.includes(k.id) ? ' is-on' : ''}`}
            aria-pressed={kinds.includes(k.id)}
            onClick={() => toggleKind(k.id)}
            data-testid={`scope-toggle-${k.id}`}
          >
            {k.label}
          </button>
        ))}
        <span className="scopes__spacer" />
        <button type="button" className="icon-btn scopes__close" title="Hide scopes" aria-label="Hide scopes" onClick={() => setScopes(false)}>
          ×
        </button>
      </div>
      <div className="scopes__row">
        {SCOPE_KINDS.filter((k) => kinds.includes(k.id)).map((k) => (
          <ScopeView key={k.id} kind={k.id} label={k.label} />
        ))}
        {!kinds.length && <div className="scopes__empty">Pick a scope above</div>}
      </div>
    </div>
  );
}
