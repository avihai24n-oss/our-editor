/**
 * Shared types for the compositor (Builder C). DOM-light: only canvas types, so the same code
 * runs on a visible <canvas> (player) and an OffscreenCanvas (export, later a Worker).
 */
import type { Id } from '../../model/types';
import type { ColorGrader } from '../color/grader';
import type { MediaDrawOp } from '../frameState';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A decoded picture ready to draw, with its intrinsic pixel size. */
export interface SourceImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/**
 * Where the compositor gets pixels for a media op.
 * - SourceImage: draw it.
 * - 'missing': the asset is lost → draw the "Media lost" placeholder.
 * - null: not ready yet (loading / seeking) → draw nothing.
 */
export interface FrameSources {
  get(op: MediaDrawOp): SourceImage | 'missing' | null;
}

/** Gives the compositor a scratch layer of the target size (for per-clip colour passes). */
export interface LayerProvider {
  get(width: number, height: number): Ctx2D | null;
}

/**
 * Where a clip ended up on the canvas, in PROJECT pixels (not target pixels).
 * Used by the player for click hit-testing and the selection box.
 */
export interface DrawnBox {
  clipId: Id;
  /** Centre of the visible box. */
  cx: number;
  cy: number;
  /** Size after scale (always positive). */
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rotation: number;
}

export interface RenderOptions {
  /** Target pixels per project pixel (player: display size; export: output size / project size). */
  scale: number;
  sources: FrameSources;
  layers?: LayerProvider;
  /** Colour pass (WebGL2 or CPU). Absent = the legacy CSS-filter approximation. */
  grader?: ColorGrader | null;
  /** Is this LUT loaded? Default: lutLibrary.requestLut (starts loading it and says no). */
  lutReady?: (id: string) => boolean;
}
