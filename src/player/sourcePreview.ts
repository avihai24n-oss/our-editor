/**
 * Source preview (CapCut: clicking a media-bin item shows that file in the player).
 *
 * A tiny store, separate from the editor store: it is pure UI state, never touches the project,
 * the playhead or the undo history. While `assetId` is set the PreviewEngine is suspended and a
 * SourcePlayer draws the asset itself on the player canvas, with its own <video>/<audio> element
 * (one at a time, released when the mode ends).
 *
 * The mode ends on: Esc, a timeline play, a playhead or clip-selection change (clicking the
 * ruler, a track or a clip), or a pointer-down anywhere outside the player and the media tiles.
 */
import { create } from 'zustand';
import { getAssetUrl } from '../media/registry';
import type { Id } from '../model/types';
import { useEditor } from '../store';
import { peaksReady } from '../timeline/media/waveform';

export interface SourcePreviewState {
  assetId: Id | null;
  playing: boolean;
  /** Source position and duration, in µs. */
  time: number;
  duration: number;
  open: (assetId: Id) => void;
  close: () => void;
  togglePlay: () => void;
  seek: (us: number) => void;
}

/** The SourcePlayer mounted by the Player (one at a time). */
let player: SourcePlayer | null = null;

export const useSourcePreview = create<SourcePreviewState>((set, get) => ({
  assetId: null,
  playing: false,
  time: 0,
  duration: 0,
  open: (assetId) => {
    const asset = useEditor.getState().project.assets[assetId];
    if (!asset || asset.missing) return;
    if (useEditor.getState().playing) useEditor.getState().pause();
    if (get().assetId === assetId) return;
    set({ assetId, playing: false, time: 0, duration: asset.kind === 'image' ? 0 : asset.duration ?? 0 });
  },
  close: () => {
    if (get().assetId !== null) set({ assetId: null, playing: false, time: 0, duration: 0 });
  },
  togglePlay: () => {
    const s = get();
    if (!s.assetId) return;
    const asset = useEditor.getState().project.assets[s.assetId];
    if (!asset || asset.kind === 'image') return;
    set({ playing: !s.playing });
  },
  seek: (us) => player?.seek(us),
}));

/** Live source media elements (e2e, debug). */
export const sourcePreviewElements = (): number => player?.elements ?? 0;

export const sourcePreviewActive = (): boolean => useSourcePreview.getState().assetId !== null;

// ---- leaving the mode from the timeline side
useEditor.subscribe((s, prev) => {
  if (!sourcePreviewActive()) return;
  if ((s.playing && !prev.playing) || s.playhead !== prev.playhead || s.selection !== prev.selection) useSourcePreview.getState().close();
});

if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!sourcePreviewActive()) return;
      const t = e.target as Element | null;
      if (t?.closest?.('.player, [data-testid="media-asset"], .menu')) return;
      useSourcePreview.getState().close();
    },
    true,
  );
}

/**
 * Draws the source on the player canvas. Owned by the Player; follows the store.
 */
export class SourcePlayer {
  private el: HTMLVideoElement | HTMLAudioElement | null = null;
  private img: HTMLImageElement | null = null;
  private kind: 'video' | 'image' | 'audio' | null = null;
  private raf = 0;
  private unsub: () => void;

  constructor(private canvas: HTMLCanvasElement, private onActive: (active: boolean) => void) {
    player = this;
    this.unsub = useSourcePreview.subscribe((s, prev) => {
      if (s.assetId !== prev.assetId) this.load(s.assetId);
      else if (s.playing !== prev.playing) this.setPlaying(s.playing);
    });
    const id = useSourcePreview.getState().assetId;
    if (id) this.load(id);
  }

  dispose(): void {
    if (player === this) player = null;
    this.unsub();
    this.release();
  }

  /** Live media elements (tests, memory readout). */
  get elements(): number {
    return (this.el ? 1 : 0) + (this.img ? 1 : 0);
  }

  /** The canvas backing store was resized (cleared): draw again. */
  redraw(): void {
    if (this.kind) this.draw();
  }

  seek(us: number): void {
    const el = this.el;
    if (!el) return;
    const sec = Math.max(0, Math.min(us / 1e6, (el.duration || 0) - 0.001));
    el.currentTime = sec;
    useSourcePreview.setState({ time: Math.round(sec * 1e6) });
    this.draw();
  }

  private release(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
      this.el = null;
    }
    if (this.img) {
      this.img.src = '';
      this.img = null;
    }
    this.kind = null;
  }

  private load(assetId: Id | null): void {
    this.release();
    if (!assetId) {
      this.onActive(false);
      return;
    }
    const asset = useEditor.getState().project.assets[assetId];
    const url = getAssetUrl(assetId);
    this.onActive(true);
    if (!asset) return;
    this.kind = asset.kind;
    const redraw = () => this.draw();
    if (asset.kind === 'image') {
      if (url) {
        const img = new Image();
        img.onload = redraw;
        img.src = url;
        this.img = img;
      }
    } else {
      const el = document.createElement(asset.kind === 'video' ? 'video' : 'audio');
      el.preload = 'auto';
      if (el instanceof HTMLVideoElement) {
        el.playsInline = true;
        el.muted = false;
      }
      el.addEventListener('loadeddata', redraw);
      el.addEventListener('seeked', redraw);
      el.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(el.duration)) useSourcePreview.setState({ duration: Math.round(el.duration * 1e6) });
      });
      el.addEventListener('ended', () => useSourcePreview.setState({ playing: false, time: Math.round(el.duration * 1e6) }));
      if (url) el.src = url;
      this.el = el;
    }
    this.draw();
  }

  private setPlaying(playing: boolean): void {
    const el = this.el;
    if (!el) return;
    if (playing) {
      if (el.ended || el.currentTime >= (el.duration || 0) - 0.01) el.currentTime = 0;
      void el.play().catch(() => useSourcePreview.setState({ playing: false }));
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this.tick);
    } else {
      el.pause();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      useSourcePreview.setState({ time: Math.round(el.currentTime * 1e6) });
      this.draw();
    }
  }

  private tick = (): void => {
    const el = this.el;
    if (!el || !useSourcePreview.getState().playing) return;
    useSourcePreview.setState({ time: Math.round(el.currentTime * 1e6) });
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width: W, height: H } = this.canvas;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const fit = (sw: number, sh: number, src: CanvasImageSource) => {
      if (!sw || !sh) return;
      const k = Math.min(W / sw, H / sh);
      const w = sw * k;
      const h = sh * k;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
    };
    if (this.kind === 'image' && this.img?.complete) fit(this.img.naturalWidth, this.img.naturalHeight, this.img);
    else if (this.kind === 'video' && this.el instanceof HTMLVideoElement && this.el.readyState >= 2) fit(this.el.videoWidth, this.el.videoHeight, this.el);
    else if (this.kind === 'audio') this.drawAudio(ctx, W, H);
    ctx.restore();
  }

  private drawAudio(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const s = useSourcePreview.getState();
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, W, H);
    // music note
    ctx.fillStyle = '#8a8f98';
    ctx.font = `${Math.round(Math.min(W, H) * 0.18)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♫', W / 2, H * 0.36);
    // waveform with the played part highlighted
    const peaks = s.assetId ? peaksReady(s.assetId) : null;
    const bars = 64;
    const top = H * 0.5;
    const bh = H * 0.16;
    const x0 = W * 0.08;
    const bw = (W * 0.84) / bars;
    const progress = s.duration > 0 ? s.time / s.duration : 0;
    let max = 0;
    const vals: number[] = [];
    for (let i = 0; i < bars; i++) {
      let m = 0.15;
      if (peaks && peaks.data.length) {
        const per = peaks.data.length / bars;
        m = 0;
        for (let j = Math.floor(i * per); j < Math.min(peaks.data.length, Math.floor((i + 1) * per)); j++) m = Math.max(m, peaks.data[j]!);
      }
      vals.push(m);
      max = Math.max(max, m);
    }
    vals.forEach((v, i) => {
      const h = Math.max(2, (max > 0 ? v / max : 0.1) * bh);
      ctx.fillStyle = (i + 0.5) / bars <= progress ? '#4fd1c5' : '#5b616b';
      ctx.fillRect(x0 + i * bw + bw * 0.15, top + (bh - h) / 2, bw * 0.7, h);
    });
  }
}
