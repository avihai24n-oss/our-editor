/**
 * Projects saved by every earlier build load in the integrated build.
 *
 * `__fixtures__/saved-<build>.json` were written by each build itself (the old c339bf3 base, every
 * agent branch, and the integration) through its own store: three assets, a video / image / audio
 * / text clip, a transition, plus that build's own feature set to a non-default value (speed curve,
 * voice filter, mask + non-uniform scale, colour grade, Combo / Loop animation).
 *
 * For each one: migrateProject fills every field the current model has, keeps the values the build
 * saved, is idempotent, and the result passes the store invariants, renders a frame state, plans
 * the audio mix and survives a store load + undo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getFrameState } from '../engine/frameState';
import { planMix } from '../export/offlineMix';
import { useEditor } from '../store';
import { projectViolations } from '../store/invariants';
import { createAsset, createClipFromAsset, createProject, createTextClip } from './defaults';
import { migrateProject } from './project';
import type { Clip, Project } from './types';

const saved = import.meta.glob('./__fixtures__/saved-*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const files = Object.keys(saved).sort();

interface Fixture {
  savedBy: string;
  features: string[];
  project: Project;
}
/**
 * saved-ctx-edit.json is saved-integration.json with the ctx-edit field added (`reversed` on every
 * timed clip, true on one video), not a document saved through the ctx-edit UI.
 * The build whose saved document is already in the current shape (migrates to itself). */
const CURRENT = 'ctx-edit';
// a deep copy each time: the tests must not share (or freeze) the module's JSON
const load = (f: string): Fixture => JSON.parse(JSON.stringify(saved[f])) as Fixture;

/** A clip of each type as the current build creates it: the shape every migrated clip must have. */
const reference = (() => {
  const v = createAsset({ kind: 'video', name: 'v', mime: 'video/mp4', size: 1, duration: 1e6, width: 2, height: 2, hasAudio: true });
  const i = createAsset({ kind: 'image', name: 'i', mime: 'image/png', size: 1, duration: 0, width: 2, height: 2 });
  const a = createAsset({ kind: 'audio', name: 'a', mime: 'audio/wav', size: 1, duration: 1e6 });
  return {
    video: createClipFromAsset(v, 't', 0),
    image: createClipFromAsset(i, 't', 0),
    audio: createClipFromAsset(a, 't', 0),
    text: createTextClip('t', 0),
  } as Record<Clip['type'], Clip>;
})();

/** Key paths of `ref` (objects only, not arrays) missing from `got`. */
function missingKeys(ref: unknown, got: unknown, at = ''): string[] {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [];
  if (!got || typeof got !== 'object') return [at || '(root)'];
  const out: string[] = [];
  for (const [k, v] of Object.entries(ref as Record<string, unknown>)) {
    const g = (got as Record<string, unknown>)[k];
    if (!(k in (got as object))) out.push(`${at}${k}`);
    else if (v && typeof v === 'object' && !Array.isArray(v) && g !== null) out.push(...missingKeys(v, g, `${at}${k}.`));
  }
  return out;
}

const allClips = (p: Project) => p.tracks.flatMap((t) => t.clips);

beforeEach(() => useEditor.getState().newProject());

describe('projects saved by every build load in the integrated build', () => {
  it('has a fixture from the old c339bf3 build and from every branch', () => {
    const builds = files.map((f) => load(f).savedBy).sort();
    expect(builds).toEqual(
      ['c339bf3', 'ctx-edit', 'integration', 'qa-export', 'qa-library', 'qa-render', 'qa-timeline', 'tab-adjust', 'tab-animation', 'tab-audio', 'tab-speed', 'tab-video'].sort(),
    );
  });

  for (const f of files) {
    const fx = load(f);
    describe(`saved by ${fx.savedBy}`, () => {
      it('migrates to the full current clip shape, idempotently', () => {
        if (fx.savedBy !== CURRENT) {
          // the saved document really is older: some current field is missing before migration
          const gaps = allClips(fx.project).flatMap((c) => missingKeys(reference[c.type], c));
          expect(gaps.length, `${fx.savedBy} lacks nothing?`).toBeGreaterThan(0);
        }
        const m = migrateProject(fx.project);
        for (const c of allClips(m)) expect(missingKeys(reference[c.type], c), `${fx.savedBy} ${c.type}`).toEqual([]);
        expect(migrateProject(m)).toBe(m);
        expect(projectViolations(m, { magnet: true })).toEqual([]);
        if (fx.savedBy === CURRENT) expect(m).toBe(fx.project); // already current: untouched
      });

      it('keeps what the build saved (common fields and its own feature)', () => {
        const before = allClips(fx.project);
        const m = migrateProject(fx.project);
        const after = allClips(m);
        expect(after.map((c) => [c.id, c.type, c.start, c.duration])).toEqual(before.map((c) => [c.id, c.type, c.start, c.duration]));
        const video = after.filter((c) => c.type === 'video');
        expect(video.some((c) => c.type === 'video' && c.adjust.brightness === 10)).toBe(true);
        const audio = after.find((c) => c.type === 'audio')!;
        expect(audio.type === 'audio' && audio.speed).toBe(1.5);
        const feats = new Set(fx.features);
        if (feats.has('speedCurve')) expect(video.some((c) => c.type === 'video' && c.speedCurve?.points.length === 3)).toBe(true);
        if (feats.has('voiceFilter')) expect(audio.type === 'audio' && audio.audio.voiceFilter).toEqual({ id: 'robot', strength: 60 });
        if (feats.has('mask'))
          expect(video.some((c) => c.type === 'video' && c.mask.shape === 'circle' && c.transform.uniformScale === false && c.transform.scaleX === 1.2)).toBe(true);
        if (feats.has('grade')) expect(after.some((c) => c.type === 'image' && c.grade.wheels.gain.y === 0.2)).toBe(true);
        if (feats.has('reverse')) expect(video.some((c) => c.type === 'video' && c.reversed === true)).toBe(true);
        if (feats.has('animation')) {
          expect(after.some((c) => c.type === 'text' && c.animationLoop?.type === 'pulse')).toBe(true);
          expect(video.some((c) => c.type === 'video' && c.animationCombo?.type === 'zoom-in-out')).toBe(true);
        }
      });

      it('loads into the store, renders, plans the mix and undoes', () => {
        const st = useEditor.getState;
        st().setProject(fx.project);
        const p = st().project;
        for (const t of [0, 1_000_000, 4_500_000, 12_000_000]) {
          const fs = getFrameState(p, t);
          expect(fs.ops.length).toBeGreaterThan(0);
          for (const op of fs.ops) if (op.kind === 'media') expect(Number.isFinite(op.sourceTime)).toBe(true);
        }
        expect(planMix(p).length).toBeGreaterThan(0);
        const id = allClips(p).find((c) => c.type === 'video')!.id;
        st().updateClip(id, { transform: { x: 50 } });
        st().undo();
        expect(st().project).toEqual(p);
      });
    });
  }

  it('a project from before every feature (created now, fields stripped) still loads', () => {
    const p = createProject();
    expect(migrateProject(p)).toBe(p);
  });
});
