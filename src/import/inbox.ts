/**
 * Media-pool inbox: lets an agent or a shell script put local files into a project's Media pool
 * while the editor is open (projects live in this browser's IndexedDB, so nothing outside the page
 * can write them). `scripts/add-media.sh` drops a request in ~/.our-editor/inbox; the dev server
 * (vite-plugins/localFiles.js) lists it; this poller opens or creates the named project, loads every
 * file through the normal import (same dedupe, probe and persistence as the Import button), saves,
 * and acks the request with a result the script prints.
 *
 * A request can also PLACE media-pool clips on the timeline (`place`, see PlaceOp): at a time or
 * right after the last clip of a track, on an existing track or a new track directly above one.
 * Each placement is one undo step; the result says exactly where every clip landed.
 */
import { useAppRoute } from '../home/route';
import type { AspectRatio, Id, Project, Track } from '../model/types';
import { useEditor } from '../store';
import * as ops from '../store/ops';
import { saveNow } from '../store/autosave';
import { listProjects } from '../store/persistence';
import { emitAppEvent, requestAssetHighlight, showToast } from '../ui/appEvents';
import { mimeOfPath } from './capcut/convert';

interface InboxRequest {
  id: string;
  project: string;
  aspect: AspectRatio | null;
  files: string[];
  place?: PlaceOp[];
}

/**
 * One clip to put on the timeline. `asset` = a media-pool file name (exact, else the only name that
 * contains it). Where:
 * - `track`: a track id, or "main" / "overlay" (first track of that kind), or { newAbove: <track id |
 *   "$prev" = the track of the previous placement in this request> } for a NEW track directly above;
 *   default: a free track of the right kind.
 * - `at`: seconds, or { afterTrackEnd: <track id | "$prev"> } = where that track's last clip ends
 *   (evaluated when this clip is placed), or "$prevStart" = the same start as the previous placement
 *   (takes stacked for comparison); default: the end of the track it goes on.
 */
export interface PlaceOp {
  asset: string;
  track?: string | { newAbove: string };
  at?: number | '$prevStart' | { afterTrackEnd: string };
}

export interface Placed {
  asset: string;
  clipId: Id;
  trackId: Id;
  /** 0 = main track; higher = further up the stack. */
  trackIndex: number;
  trackKind: string;
  start: number;
  end: number;
}

export interface InboxResult {
  ok: boolean;
  project: string;
  projectId: string;
  created: boolean;
  added: string[];
  alreadyInPool: string[];
  placed?: Placed[];
  errors: string[];
}

const ASPECTS: readonly AspectRatio[] = ['9:16', '16:9', '1:1', '4:5', '3:4'];
const fileUrl = (p: string) => `/__local/file?path=${encodeURIComponent(p)}`;
const baseName = (p: string) => p.split('/').pop() || p;

/** Opens the project with this name (exact, then case-insensitive), or creates it. */
async function openOrCreate(name: string, aspect: AspectRatio | null): Promise<{ created: boolean }> {
  const route = useAppRoute.getState();
  const open = useEditor.getState().project;
  if (!name || open.name === name) {
    route.show('editor');
    return { created: false };
  }
  const all = await listProjects();
  const hit = all.find((p) => p.name === name) ?? all.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (hit && (await route.open(hit.id))) return { created: false };
  await route.create({ name, aspect: aspect && ASPECTS.includes(aspect) ? aspect : undefined });
  return { created: true };
}

async function runRequest(req: InboxRequest): Promise<InboxResult> {
  const errors: string[] = [];
  const { created } = await openOrCreate(req.project.trim(), req.aspect);
  const files: File[] = [];
  for (const p of req.files) {
    try {
      const r = await fetch(fileUrl(p));
      if (!r.ok) throw new Error(r.status === 403 ? 'path not allowed (must be under ~/Desktop/ai or ~/Movies/CapCut)' : `HTTP ${r.status}`);
      const blob = await r.blob();
      files.push(new File([blob], baseName(p), { type: mimeOfPath(p), lastModified: Date.parse(r.headers.get('Last-Modified') ?? '') || 0 }));
    } catch (e) {
      errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const ed = useEditor.getState();
  const before = new Set(Object.keys(ed.project.assets));
  const res = files.length ? await ed.importFiles(files) : { assetIds: [], errors: [], reused: [], relinked: [] };
  errors.push(...res.errors);
  const placed = req.place?.length ? placeAll(req.place, errors) : undefined;
  await saveNow(true);
  const s = useEditor.getState();
  const nameOf = (id: string) => s.project.assets[id]?.name ?? id;
  emitAppEvent('libraryShow', { tab: 'media' });
  if (res.assetIds.length) requestAssetHighlight(res.assetIds);
  return {
    ok: errors.length === 0,
    project: s.project.name,
    projectId: s.project.id,
    created,
    added: res.assetIds.filter((id) => !before.has(id) || res.relinked.includes(id)).map(nameOf),
    alreadyInPool: res.reused.map(nameOf),
    ...(placed ? { placed } : {}),
    errors,
  };
}

const S = (sec: number) => Math.round(sec * 1e6);
const trackEnd = (t: Track) => t.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

function findAsset(p: Project, name: string): Id | string {
  const all = Object.values(p.assets);
  const exact = all.filter((a) => a.name === name);
  if (exact.length) return exact[exact.length - 1]!.id;
  const part = all.filter((a) => a.name.includes(name));
  if (part.length === 1) return part[0]!.id;
  return part.length ? `"${name}" matches ${part.length} files: be exact` : `"${name}" is not in the media pool`;
}

/** Runs the placements in order; each is one undo step. Errors are collected, the rest still run. */
function placeAll(list: PlaceOp[], errors: string[]): Placed[] {
  const out: Placed[] = [];
  let prevTrack: Id | null = null;
  let prevStart: number | null = null;
  const ref = (id: string): Id | null => (id === '$prev' ? prevTrack : id);
  for (const op of list) {
    const ed = useEditor.getState();
    const assetId = findAsset(ed.project, op.asset);
    if (!ed.project.assets[assetId]) {
      errors.push(`place: ${assetId}`);
      continue;
    }
    try {
      const clipId = ed.editProject((d, ctx) => {
        const asset = d.assets[assetId]!;
        const kind = asset.kind === 'audio' ? 'audio' : 'overlay';
        let track: Track | undefined;
        if (typeof op.track === 'object') {
          const base = d.tracks.findIndex((t) => t.id === ref(op.track && typeof op.track === 'object' ? op.track.newAbove : ''));
          if (base < 0) throw new Error(`no track "${op.track.newAbove}" to add a track above`);
          track = ops.addTrack(d, kind === 'audio' ? 'audio' : (d.tracks[base]!.kind === 'main' ? 'overlay' : (d.tracks[base]!.kind as 'overlay')), base + 1);
        } else if (op.track === 'main' || op.track === 'overlay') track = d.tracks.find((t) => t.kind === op.track);
        else if (op.track) {
          track = d.tracks.find((t) => t.id === op.track);
          if (!track) throw new Error(`no track "${op.track}"`);
        }
        let at: number;
        if (typeof op.at === 'number') at = S(op.at);
        else if (op.at === '$prevStart') {
          if (prevStart === null) throw new Error('"$prevStart" needs a previous placement');
          at = prevStart;
        }
        else if (op.at && typeof op.at === 'object') {
          const t = d.tracks.find((x) => x.id === ref(op.at && typeof op.at === 'object' ? op.at.afterTrackEnd : ''));
          if (!t) throw new Error(`no track "${op.at.afterTrackEnd}" for afterTrackEnd`);
          at = trackEnd(t);
        } else at = track ? trackEnd(track) : 0;
        if (track?.locked) throw new Error('that track is locked');
        const id = ops.addClipFromAsset(d, assetId, { at, ...(track ? { trackId: track.id } : { kind: kind === 'audio' ? undefined : 'overlay' }) }, ctx);
        if (!id) throw new Error('the editor refused the clip');
        return id;
      });
      const p = useEditor.getState().project;
      const ti = p.tracks.findIndex((t) => t.clips.some((c) => c.id === clipId));
      const c = p.tracks[ti]!.clips.find((x) => x.id === clipId)!;
      prevTrack = p.tracks[ti]!.id;
      prevStart = c.start;
      out.push({ asset: p.assets[assetId]!.name, clipId, trackId: prevTrack, trackIndex: ti, trackKind: p.tracks[ti]!.kind, start: c.start / 1e6, end: (c.start + c.duration) / 1e6 });
    } catch (e) {
      errors.push(`place "${op.asset}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

let running = false;

/** One poll: runs every pending request in order. Skipped while a project is loading. */
async function pollOnce(): Promise<void> {
  if (running || useAppRoute.getState().busy) return;
  running = true;
  try {
    const r = await fetch('/__local/inbox');
    if (!r.ok) return;
    const pending = (await r.json()) as InboxRequest[];
    for (const req of pending) {
      let result: InboxResult;
      try {
        result = await runRequest(req);
      } catch (e) {
        const p = useEditor.getState().project;
        result = { ok: false, project: p.name, projectId: p.id, created: false, added: [], alreadyInPool: [], errors: [e instanceof Error ? e.message : String(e)] };
      }
      await fetch(`/__local/inbox/done?id=${encodeURIComponent(req.id)}`, { method: 'POST', body: JSON.stringify(result) });
      const n = result.added.length;
      showToast(result.ok ? `${n} file${n === 1 ? '' : 's'} added to "${result.project}"` : `Inbox import: ${result.errors[0]}`);
    }
  } catch {
    /* server without the plugin (static build): nothing to do */
  } finally {
    running = false;
  }
}

/** Polls the inbox every 2 s (a hidden tab is throttled by the browser). Returns a stop function. */
export function startInboxPolling(intervalMs = 2000): () => void {
  void pollOnce();
  const t = window.setInterval(() => void pollOnce(), intervalMs);
  return () => window.clearInterval(t);
}
