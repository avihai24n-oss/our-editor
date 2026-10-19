/**
 * Model invariants of a Project, checked by the fuzz test (src/store/fuzz.test.ts), the store tests
 * and — through the dev-only `window.__oeCheck` handle — by the e2e audit (e2e/audit-timeline.spec.ts).
 * Pure: returns a list of human-readable violations (empty = healthy).
 */
import { LIMITS } from '../model/catalog';
import { trackAccepts } from '../model/project';
import { clipEnd, frameUs } from '../model/time';
import type { Project } from '../model/types';

export interface InvariantCtx {
  /** Main-track magnet on: the main track must be packed from 0 with no gaps. */
  magnet: boolean;
  /** Selected clip ids (must exist and sit on unlocked tracks). */
  selection?: readonly string[];
}

export function projectViolations(p: Project, ctx: InvariantCtx): string[] {
  const out: string[] = [];
  const bad = (msg: string) => out.push(msg);
  const minUs = Math.ceil(frameUs(p.settings.fps));

  const mains = p.tracks.filter((t) => t.kind === 'main');
  if (mains.length !== 1) bad(`expected 1 main track, found ${mains.length}`);
  const firstVisual = p.tracks.find((t) => t.kind !== 'audio');
  if (firstVisual && firstVisual.kind !== 'main') bad('the main track is not the bottom visual track');

  const ids = new Set<string>();
  const links = new Map<string, { video: number; audio: number }>();
  for (const t of p.tracks) {
    if (t.kind !== 'main' && t.clips.length === 0) bad(`empty ${t.kind} track ${t.id}`);
    let end = 0;
    for (let i = 0; i < t.clips.length; i++) {
      const c = t.clips[i]!;
      const tag = `${t.kind}/${c.id}`;
      if (ids.has(c.id)) bad(`duplicate clip id ${c.id}`);
      ids.add(c.id);
      if (c.trackId !== t.id) bad(`${tag}: trackId ${c.trackId} != ${t.id}`);
      if (!trackAccepts(t.kind, c)) bad(`${tag}: a ${c.type} clip on a ${t.kind} track`);
      if (!Number.isInteger(c.start) || !Number.isInteger(c.duration)) bad(`${tag}: non-integer time ${c.start}/${c.duration}`);
      if (c.start < 0) bad(`${tag}: negative start ${c.start}`);
      if (c.duration < minUs) bad(`${tag}: duration ${c.duration} < one frame`);
      if (c.start < end) bad(`${tag}: overlaps the previous clip (${c.start} < ${end})`);
      if (t.kind === 'main' && ctx.magnet && c.start !== end) bad(`${tag}: gap on the magnetic main track (${end} → ${c.start})`);
      end = clipEnd(c);
      if (c.type === 'video' || c.type === 'audio') {
        const a = p.assets[c.assetId];
        if (!Number.isInteger(c.inPoint)) bad(`${tag}: non-integer inPoint`);
        if (c.inPoint < 0) bad(`${tag}: negative inPoint ${c.inPoint}`);
        if (c.speed < LIMITS.speedMin || c.speed > LIMITS.speedMax) bad(`${tag}: speed ${c.speed} out of range`);
        // the source span read must lie inside the media
        if (a && c.inPoint + c.duration * c.speed > a.duration + 0.5) {
          bad(`${tag}: reads past the media end (${c.inPoint} + ${c.duration}×${c.speed} > ${a.duration})`);
        }
        if (c.audio.fadeIn < 0 || c.audio.fadeOut < 0 || c.audio.fadeIn + c.audio.fadeOut > c.duration) bad(`${tag}: fades do not fit`);
        if (c.audioLink) {
          const l = links.get(c.audioLink) ?? { video: 0, audio: 0 };
          l[c.type] += 1;
          links.set(c.audioLink, l);
        }
      }
      if (c.type !== 'audio') {
        const ai = c.animationIn?.duration ?? 0;
        const ao = c.animationOut?.duration ?? 0;
        if (ai < 0 || ao < 0 || ai + ao > c.duration) bad(`${tag}: animations do not fit`);
      }
    }
    const seenCut = new Set<string>();
    for (const tr of t.transitions) {
      const i = t.clips.findIndex((c) => c.id === tr.fromClipId);
      const a = t.clips[i];
      const b = t.clips[i + 1];
      if (!a) {
        bad(`orphan transition ${tr.id}: from clip ${tr.fromClipId} not on track`);
        continue;
      }
      if (!b || b.id !== tr.toClipId) bad(`orphan transition ${tr.id}: to clip is not the next clip`);
      else if (clipEnd(a) !== b.start) bad(`transition ${tr.id} on a gap`);
      if (a.type === 'audio') bad(`transition ${tr.id} on audio`);
      if (seenCut.has(tr.fromClipId)) bad(`two transitions on one cut (${tr.fromClipId})`);
      seenCut.add(tr.fromClipId);
      if (b && (tr.duration <= 0 || tr.duration > Math.floor(Math.min(a.duration, b.duration) / 2))) bad(`transition ${tr.id}: duration ${tr.duration} too long`);
    }
  }

  for (const [link, n] of links) {
    if (!n.video || !n.audio) bad(`audioLink ${link} dangles (video ${n.video}, audio ${n.audio})`);
  }
  for (const c of p.tracks.flatMap((t) => t.clips)) {
    if (c.type === 'video' && c.audioLink && !c.audio.muted) bad(`video ${c.id} has extracted audio but is not muted`);
  }

  const times = p.markers.map((m) => m.time);
  if (times.some((x, i) => i > 0 && x <= times[i - 1]!)) bad('markers unsorted or duplicated');

  if (ctx.selection) {
    for (const id of ctx.selection) {
      const t = p.tracks.find((tr) => tr.clips.some((c) => c.id === id));
      if (!t) bad(`selected clip ${id} does not exist`);
      else if (t.locked) bad(`selected clip ${id} is on a locked track`);
    }
  }
  return out;
}
