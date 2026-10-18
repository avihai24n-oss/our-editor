/**
 * Library → timeline drag-and-drop contract (HTML5 DnD).
 *
 * Primary (SPEC §4): dataTransfer type `application/x-our-editor` with JSON
 *   { kind: 'asset', assetId } | { kind: 'text' } | { kind: 'transition', type }.
 * Also accepted: `application/x-our-editor-asset` whose data is the bare asset id (or the same JSON).
 * OS files dropped on the timeline are imported, then placed.
 */
import { TRANSITIONS } from '../model/catalog';
import type { Id, TransitionType } from '../model/types';

export const DND_MIME = 'application/x-our-editor';
export const DND_ASSET_MIME = 'application/x-our-editor-asset';

export type LibraryPayload =
  | { kind: 'asset'; assetId: Id }
  | { kind: 'text'; preset?: string }
  | { kind: 'transition'; type: TransitionType };

const TRANSITION_TYPES = new Set<string>(TRANSITIONS.map((t) => t.id));

/** True when a dragover carries something the timeline accepts (types only; data is hidden then). */
export function acceptsDrag(types: readonly string[]): boolean {
  return types.includes(DND_MIME) || types.includes(DND_ASSET_MIME) || types.includes('Files');
}

/** True when the drag carries OS files. */
export const isFileDrag = (types: readonly string[]): boolean =>
  types.includes('Files') && !types.includes(DND_MIME) && !types.includes(DND_ASSET_MIME);

export function parsePayloadJson(raw: string): LibraryPayload | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'asset' && typeof o.assetId === 'string' && o.assetId) return { kind: 'asset', assetId: o.assetId };
  if (o.kind === 'text') return typeof o.preset === 'string' && o.preset ? { kind: 'text', preset: o.preset } : { kind: 'text' };
  if (o.kind === 'transition' && typeof o.type === 'string' && TRANSITION_TYPES.has(o.type)) {
    return { kind: 'transition', type: o.type as TransitionType };
  }
  return null;
}

/** Reads the payload at drop time. `getData` is `dataTransfer.getData`. */
export function readPayload(getData: (type: string) => string): LibraryPayload | null {
  const main = safe(getData, DND_MIME);
  if (main) {
    const p = parsePayloadJson(main);
    if (p) return p;
  }
  const asset = safe(getData, DND_ASSET_MIME).trim();
  if (asset) {
    if (asset.startsWith('{')) return parsePayloadJson(asset);
    return { kind: 'asset', assetId: asset };
  }
  return null;
}

function safe(getData: (type: string) => string, type: string): string {
  try {
    return getData(type) ?? '';
  } catch {
    return '';
  }
}
