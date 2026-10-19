/**
 * The preview engine: owns the player canvas, the media pool, the audio engine and the clock.
 *
 * - Paused: re-renders whenever the project or playhead changes (and when a seek lands).
 * - Playing: a requestAnimationFrame loop reads the clock (AudioContext time when audio is
 *   running), renders getFrameState(project, t), keeps media elements in sync, and writes the
 *   playhead to the store ~30×/s. An external playhead change while playing (scrub) re-anchors.
 *
 * Idle rules: nothing runs while paused except one-shot renders after a change. When the tab is
 * hidden the engine pauses playback and frees every media element and the audio voices (the
 * AudioContext is suspended); when it is visible again one frame is rendered and only the
 * elements that frame needs come back. Registered as the "preview" cache so the memory watchdog
 * can flush it.
 */
import { getFrameState, type MediaDrawOp } from '../engine/frameState';
import { createColorGrader, onLutsChange, type ColorGrader } from '../engine/color';
import { createLayerProvider, renderFrame, type DrawnBox } from '../engine/render';
import { registerCache } from '../media/memory';
import { onAssetUrlsChange } from '../media/registry';
import { projectDuration } from '../model/time';
import type { Id, Us } from '../model/types';
import { useEditor, type EditorState } from '../store';
import { AudioEngine } from './audioEngine';
import { PlaybackClock, perfNow } from './clock';
import { MediaPool } from './mediaPool';

const PRELOAD_AHEAD_US = 800_000;
const STORE_WRITE_MS = 33;

let active: PreviewEngine | null = null;
/** The mounted engine (debug readout, e2e). */
export const activePreviewEngine = (): PreviewEngine | null => active;

export interface PreviewEngineOptions {
  onBoxes?: (boxes: DrawnBox[]) => void;
}

export class PreviewEngine {
  private ctx: CanvasRenderingContext2D | null;
  private pool: MediaPool;
  private audio = new AudioEngine();
  private clock = new PlaybackClock(perfNow);
  private layers = createLayerProvider();
  /** Colour pass (WebGL2, CPU fallback). Created on the first render; undefined = not yet tried. */
  private grader: ColorGrader | null | undefined = undefined;
  private raf = 0;
  private pendingRender = 0;
  private unsub: (() => void)[] = [];
  private lastWritten: Us = -1;
  private lastWriteAt = 0;
  private lastPreloadAt = 0;
  private playToken = 0;
  private disposed = false;
  /** Target pixels per project pixel. */
  private scale = 1;

  constructor(private canvas: HTMLCanvasElement, private opts: PreviewEngineOptions = {}) {
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.pool = new MediaPool(() => this.invalidate());
    this.pool.setProject(useEditor.getState().project);
  }

  start(): void {
    active = this;
    this.unsub.push(useEditor.subscribe((s, prev) => this.onStore(s, prev)));
    this.unsub.push(onAssetUrlsChange(() => this.invalidate()));
    this.unsub.push(onLutsChange(() => this.invalidate()));
    if (typeof document !== 'undefined') {
      const onVis = () => this.onVisibility(document.visibilityState === 'hidden');
      document.addEventListener('visibilitychange', onVis);
      this.unsub.push(() => document.removeEventListener('visibilitychange', onVis));
    }
    this.unsub.push(
      registerCache(
        'preview',
        () => this.flush(),
        () => {
          const p = this.pool.stats();
          return { entries: p.videos + p.images + this.audio.voiceCount, bytes: 0 };
        },
      ),
    );
    if (useEditor.getState().playing) void this.startPlayback();
    else this.invalidate();
  }

  dispose(): void {
    if (active === this) active = null;
    this.disposed = true;
    this.unsub.forEach((u) => u());
    this.unsub = [];
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.pendingRender);
    this.pool.dispose();
    this.audio.dispose();
    this.grader?.dispose();
    this.grader = null;
  }

  /** Which colour pass the player uses (debug readout, e2e). */
  get colorPass(): 'webgl2' | 'cpu' | 'none' {
    return this.grader ? this.grader.kind : 'none';
  }

  /** CSS size of the canvas box; the backing store follows (× devicePixelRatio, capped at project size). */
  resize(cssW: number, cssH: number, dpr: number): void {
    const { width: W, height: H } = useEditor.getState().project.settings;
    if (cssW <= 0 || cssH <= 0) return;
    const k = Math.min(1, (cssW * dpr) / W, (cssH * dpr) / H);
    const bw = Math.max(1, Math.round(W * k));
    const bh = Math.max(1, Math.round(H * k));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.scale = bw / W;
    this.invalidate();
  }

  /** Re-render the current playhead on the next animation frame (paused mode). */
  invalidate(): void {
    if (this.disposed || this.clock.isRunning || this.pendingRender) return;
    // a hidden tab draws nothing (and must not recreate decoders); visibilitychange re-renders
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.pendingRender = requestAnimationFrame(() => {
      this.pendingRender = 0;
      if (this.clock.isRunning) return;
      const st = useEditor.getState();
      const end = projectDuration(st.project);
      // preview axis: while hovering the timeline, show the hovered frame instead of the playhead's
      const t = st.previewTime ?? st.playhead;
      // at the very end show the last frame instead of an empty canvas
      this.renderAt(end > 0 && t >= end ? Math.max(0, end - 1) : t, false);
    });
  }

  /** Live media elements (tests, debug readout). */
  stats(): { videos: number; images: number; voices: number; looping: boolean } {
    return { ...this.pool.stats(), voices: this.audio.voiceCount, looping: this.raf !== 0 || this.pendingRender !== 0 };
  }

  /** Tab hidden: stop playback and free every decoder. Visible again: draw the current frame. */
  onVisibility(hidden: boolean): void {
    if (this.disposed) return;
    if (hidden) {
      if (useEditor.getState().playing) useEditor.getState().pause(); // → stopPlayback
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      cancelAnimationFrame(this.pendingRender);
      this.pendingRender = 0;
      this.pool.releaseAll();
      this.audio.releaseAll();
    } else {
      this.invalidate();
    }
  }

  /** Memory watchdog: free everything off screen, keep drawing the current frame. */
  private flush(): void {
    if (this.clock.isRunning) return;
    this.pool.releaseAll();
    this.audio.releaseAll();
    this.invalidate();
  }

  // ---------------------------------------------------------------- store

  private onStore(s: EditorState, prev: EditorState): void {
    if (s.project !== prev.project) this.pool.setProject(s.project);
    if (s.playing !== prev.playing) {
      if (s.playing) void this.startPlayback();
      else this.stopPlayback();
      return;
    }
    if (s.playing && this.clock.isRunning) {
      // someone else moved the playhead while playing → seek
      if (s.playhead !== prev.playhead && s.playhead !== this.lastWritten) this.clock.seek(s.playhead);
      return;
    }
    if (
      s.project !== prev.project ||
      s.playhead !== prev.playhead ||
      s.previewTime !== prev.previewTime ||
      s.project.settings !== prev.project.settings
    )
      this.invalidate();
  }

  // ---------------------------------------------------------------- playback

  private async startPlayback(): Promise<void> {
    const token = ++this.playToken;
    const from = useEditor.getState().playhead;
    // start on the performance clock immediately; switch to the audio clock once it runs
    this.clock = new PlaybackClock(perfNow);
    this.clock.start(from);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    const ok = await this.audio.resume();
    if (ok && token === this.playToken && this.clock.isRunning) this.clock.setSource(() => this.audio.now());
  }

  private stopPlayback(): void {
    this.playToken++;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.clock.isRunning) this.clock.stop();
    this.audio.stopAll();
    this.pool.pauseAll();
    this.invalidate();
  }

  private tick = (): void => {
    if (this.disposed || !this.clock.isRunning) return;
    const s = useEditor.getState();
    const end = projectDuration(s.project);
    let t = this.clock.time();
    if (t >= end) {
      t = end;
      this.writePlayhead(t, true);
      s.pause(); // → stopPlayback via subscription
      return;
    }
    this.renderAt(t, true);
    this.writePlayhead(t, false);
    this.raf = requestAnimationFrame(this.tick);
  };

  private writePlayhead(t: Us, force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastWriteAt < STORE_WRITE_MS) return;
    this.lastWriteAt = now;
    this.lastWritten = Math.max(0, Math.round(t));
    useEditor.getState().setPlayhead(this.lastWritten);
  }

  // ---------------------------------------------------------------- render

  private renderAt(t: Us, playing: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const project = useEditor.getState().project;
    const fps = project.settings.fps;
    const fs = getFrameState(project, t);
    const media = fs.ops.filter((o): o is MediaDrawOp => o.kind === 'media');
    this.pool.sync(media, t, playing, fps);

    const keep = new Set<Id>(media.map((o) => o.clipId));
    if (playing) {
      this.audio.sync(fs.audio, fps);
      const now = performance.now();
      if (now - this.lastPreloadAt > 200) {
        this.lastPreloadAt = now;
        const ahead = getFrameState(project, t + PRELOAD_AHEAD_US).ops.filter((o): o is MediaDrawOp => o.kind === 'media');
        const upcoming = ahead.filter((o) => !keep.has(o.clipId));
        this.pool.preload(upcoming);
        upcoming.forEach((o) => keep.add(o.clipId));
        this.pool.idle(keep);
      }
    } else {
      this.pool.idle(keep);
    }

    if (this.grader === undefined) this.grader = createColorGrader();
    const boxes = renderFrame(ctx, fs, { scale: this.scale, sources: this.pool, layers: this.layers, grader: this.grader });
    this.opts.onBoxes?.(boxes);
  }
}
