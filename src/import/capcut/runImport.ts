/**
 * Browser side of the CapCut import: fetch the draft through the dev / preview server plugin
 * (vite-plugins/localFiles.js), convert it, load every media file through the normal import
 * pipeline (probe, IndexedDB blob, object URL), then load and save the project.
 */
import { importFile } from '../../media/import';
import { allClipsDeep } from '../../model/compound';
import type { Id, MediaAsset, Project } from '../../model/types';
import { useEditor } from '../../store';
import { saveNow } from '../../store/autosave';
import { projectViolations } from '../../store/invariants';
import { convertCapcutDraft, mimeOfPath, type CapcutImportReport } from './convert';
import type { CcDraft } from './types';

export interface CapcutImportProgress {
  done: number;
  total: number;
  file: string;
}

export interface CapcutImportOutcome {
  report: CapcutImportReport;
  violations: string[];
}

interface ProjectResponse {
  id: string;
  folder: string;
  name: string;
  draft: CcDraft;
  resolved: Record<string, string | null>;
}

const fileUrl = (p: string) => `/__local/file?path=${encodeURIComponent(p)}`;

/** True when the open project has at least one clip (import would replace it). */
export const projectHasContent = (p: Project): boolean => p.tracks.some((t) => t.clips.length > 0);

export async function importCapcutProject(id: string, onProgress?: (p: CapcutImportProgress) => void): Promise<CapcutImportOutcome> {
  const res = await fetch(`/__local/capcut/project?id=${encodeURIComponent(id)}`);
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(res.status === 404 && !msg.includes('error') ? 'The local file server is not running here (restart vite).' : `CapCut draft "${id}": ${msg || res.status}`);
  }
  const data = (await res.json()) as ProjectResponse;
  const { project, assets, report } = convertCapcutDraft(data.draft, (raw) => data.resolved[raw] ?? null, { name: data.name });

  const idMap = new Map<Id, MediaAsset>();
  let done = 0;
  for (const ref of assets) {
    onProgress?.({ done, total: assets.length, file: ref.name });
    if (!ref.missing) {
      try {
        const r = await fetch(fileUrl(ref.path));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const file = new File([blob], ref.name, { type: mimeOfPath(ref.path), lastModified: Date.parse(r.headers.get('Last-Modified') ?? '') || 0 });
        idMap.set(ref.id, await importFile(file));
      } catch (e) {
        report.items.push({ level: 'dropped', where: 'Media', what: `Could not load ${ref.path}: ${e instanceof Error ? e.message : String(e)} — kept as "Media lost".` });
        report.counts.missingFiles += 1;
      }
    }
    done += 1;
  }
  onProgress?.({ done, total: assets.length, file: '' });

  // swap in the probed assets and point every clip at them
  const assetsOut: Record<Id, MediaAsset> = {};
  for (const ref of assets) {
    const real = idMap.get(ref.id);
    assetsOut[real?.id ?? ref.id] = real ?? { ...project.assets[ref.id]!, missing: true };
  }
  project.assets = assetsOut;
  const remap = (aid: Id) => idMap.get(aid)?.id ?? aid;
  for (const c of allClipsDeep(project)) {
    if (c.type === 'video' || c.type === 'audio' || c.type === 'image') c.assetId = remap(c.assetId);
    if ((c.type === 'video' || c.type === 'image') && c.canvas.assetId) c.canvas.assetId = remap(c.canvas.assetId);
  }
  // the probed media can be a hair shorter than CapCut's figure: keep every read inside the file
  for (const c of allClipsDeep(project)) {
    if (c.type !== 'video' && c.type !== 'audio') continue;
    const a = project.assets[c.assetId];
    if (!a || a.missing || !a.duration) continue;
    const span = Math.round(c.duration * (c.speedCurve ? 1 : c.speed));
    const over = c.inPoint + span - a.duration;
    if (over > 0) {
      c.inPoint = Math.max(0, c.inPoint - over);
      if (c.inPoint + span > a.duration) c.duration = Math.max(1, Math.floor((a.duration - c.inPoint) / (c.speedCurve ? 1 : c.speed)));
      if (over > 33_334) report.items.push({ level: 'approx', where: c.name, what: `The file is ${(over / 1e6).toFixed(3)} s shorter than CapCut says; the in-point moved back.` });
    }
  }

  useEditor.getState().setProject(project);
  await saveNow(true);
  const s = useEditor.getState();
  return { report, violations: projectViolations(s.project, { magnet: s.magnet }) };
}
