/**
 * Media-pool inbox: lets an agent or a shell script put local files into a project's Media pool
 * while the editor is open (projects live in this browser's IndexedDB, so nothing outside the page
 * can write them). `scripts/add-media.sh` drops a request in ~/.our-editor/inbox; the dev server
 * (vite-plugins/localFiles.js) lists it; this poller opens or creates the named project, loads every
 * file through the normal import (same dedupe, probe and persistence as the Import button), saves,
 * and acks the request with a result the script prints.
 */
import { useAppRoute } from '../home/route';
import type { AspectRatio } from '../model/types';
import { useEditor } from '../store';
import { saveNow } from '../store/autosave';
import { listProjects } from '../store/persistence';
import { emitAppEvent, requestAssetHighlight, showToast } from '../ui/appEvents';
import { mimeOfPath } from './capcut/convert';

interface InboxRequest {
  id: string;
  project: string;
  aspect: AspectRatio | null;
  files: string[];
}

export interface InboxResult {
  ok: boolean;
  project: string;
  projectId: string;
  created: boolean;
  added: string[];
  alreadyInPool: string[];
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
    errors,
  };
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
