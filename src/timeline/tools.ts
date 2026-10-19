/**
 * Timeline tool modes (CapCut desktop's cursor dropdown, docs/research/07-tool-modes.md):
 * Select (A), Split (B), Select leftward ([) and Select rightward (]).
 *
 * One table drives the toolbar dropdown, the toolbar icon, the timeline cursor and the shortcut
 * keys (through the commands in ./shortcutDefs). Plus the pure decisions behind the tools: where
 * the split blade cuts, and what a leftward / rightward click selects. No React, no DOM.
 */
import { clipEnd, pxToUs, snapToFrame } from '../model/time';
import type { Clip, Id, Project, Us } from '../model/types';
import { SNAP_PX } from './geometry';
import type { Command } from './shortcutDefs';

export type Tool = 'select' | 'split' | 'selectLeft' | 'selectRight';

export interface ToolDef {
  id: Tool;
  /** Name in the dropdown (CapCut's wording). */
  label: string;
  /** Icon name in ../ui/Icon. */
  icon: 'select' | 'split-tool' | 'select-left' | 'select-right';
  /** The shortcut command that switches to this tool. */
  command: Command;
  /** CSS `cursor` value over the track area while this tool is active. */
  cursor: string;
}

// ---------------------------------------------------------------- cursors

/**
 * An SVG cursor as a CSS value: `url("data:…") x y, fallback`. 32×32, drawn twice (a dark halo
 * under a white stroke) so it reads on light clips and on the dark lane alike.
 */
export function svgCursor(body: string, hotX: number, hotY: number, fallback: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32' fill='none' stroke-linecap='round' stroke-linejoin='round'>` +
    `<g stroke='black' stroke-width='3.5' opacity='.85'>${body}</g>` +
    `<g stroke='white' stroke-width='1.5'>${body}</g></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
}

/** Razor blade: a vertical cutting line (the hotspot sits on it) with a blade at the top. */
const BLADE =
  // blade body with its centre slot
  `<path d='M11 2h10v7l-5 4-5-4z'/><path d='M16 4.5v3'/>` +
  // the cut line, hotspot at (16, 18)
  `<path d='M16 13v17'/>`;

/** Arrow + a bar and a chevron pointing left / right (CapCut's select leftward / rightward). */
const ARROW = `<path d='M9 3v17l4.2-4 3 7 2.6-1.1-3-7H21z'/>`;
const LEFT = `${ARROW}<path d='M30 18v12'/><path d='M27 24h-7m2.5-2.5L20 24l2.5 2.5'/>`;
const RIGHT = `${ARROW}<path d='M20 18v12'/><path d='M23 24h7m-2.5-2.5L30 24l-2.5 2.5'/>`;

export const TOOLS: readonly ToolDef[] = [
  { id: 'select', label: 'Select', icon: 'select', command: 'toolSelect', cursor: 'default' },
  { id: 'split', label: 'Split', icon: 'split-tool', command: 'toolSplit', cursor: svgCursor(BLADE, 16, 18, 'crosshair') },
  { id: 'selectLeft', label: 'Select leftward', icon: 'select-left', command: 'selectLeft', cursor: svgCursor(LEFT, 9, 3, 'w-resize') },
  { id: 'selectRight', label: 'Select rightward', icon: 'select-right', command: 'selectRight', cursor: svgCursor(RIGHT, 9, 3, 'e-resize') },
];

export const toolDef = (t: Tool): ToolDef => TOOLS.find((d) => d.id === t) ?? TOOLS[0]!;

/** Clips can be dragged and trimmed only with the Select tool (and moved after a side click). */
export const toolTrims = (t: Tool): boolean => t === 'select';

// ---------------------------------------------------------------- split blade

/**
 * Where the split blade cuts `clip` for a pointer at time `raw`: on a frame boundary, pulled onto
 * the playhead when it is within SNAP_PX (and snapping is on). Null when the cut would land on the
 * clip's own edge (nothing to split there).
 */
export function bladeTime(clip: Pick<Clip, 'start' | 'duration'>, raw: Us, playhead: Us, zoom: number, fps: number, snap: boolean): Us | null {
  let t = snapToFrame(Math.max(0, raw), fps);
  if (snap && Math.abs(raw - playhead) <= pxToUs(SNAP_PX, zoom)) t = playhead;
  return t > clip.start && t < clipEnd(clip as Clip) ? t : null;
}

// ---------------------------------------------------------------- select leftward / rightward

/**
 * The clips Select leftward / rightward takes at time `t`, on every unlocked track: leftward =
 * clips that start before `t`; rightward = clips that end after `t` (a clip crossing `t` belongs to
 * both). Same rule as the [ / ] keys at the playhead.
 */
export function clipsOnSide(project: Project, t: Us, side: 'left' | 'right'): Id[] {
  return project.tracks
    .filter((tr) => !tr.locked)
    .flatMap((tr) => tr.clips.filter((c) => (side === 'left' ? c.start < t : clipEnd(c) > t)).map((c) => c.id));
}

/** The side a tool selects, or null for tools that do not select by side. */
export const toolSide = (t: Tool): 'left' | 'right' | null => (t === 'selectLeft' ? 'left' : t === 'selectRight' ? 'right' : null);
