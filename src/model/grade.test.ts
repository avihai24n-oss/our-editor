import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../store';
import { createAsset, defaultAdjust, defaultGrade } from './defaults';
import { findClip, migrateProject } from './project';
import { secToUs } from './time';
import type { Project, VisualClip } from './types';

const st = () => useEditor.getState();
const clipOf = (id: string) => findClip(st().project, id)!.clip as VisualClip;

function withVideo(): string {
  st().newProject();
  const v = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: secToUs(4), width: 1920, height: 1080, hasAudio: false });
  st().addAssets([v]);
  return st().addClip(v.id, { at: 0 })!;
}

describe('colour grade model', () => {
  beforeEach(() => st().newProject());

  it('new visual clips get every Adjust slider at 0 and a neutral grade', () => {
    const c = clipOf(withVideo());
    expect(c.adjust).toEqual(defaultAdjust());
    expect(Object.keys(c.adjust)).toEqual(expect.arrayContaining(['whites', 'blacks', 'brilliance', 'clarity', 'grain']));
    expect(c.grade).toEqual(defaultGrade());
    expect(Object.keys(c.grade.hsl.bands)).toHaveLength(8);
  });

  it('migrates an old project: missing sliders → 0, missing grade → defaults, partial grade kept', () => {
    const id = withVideo();
    const p = JSON.parse(JSON.stringify(st().project)) as Project;
    const c = p.tracks[0]!.clips[0] as Partial<VisualClip> & Record<string, unknown>;
    const old = { brightness: 10, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, fade: 0, vignette: 0, sharpen: 0 };
    c.adjust = old as never;
    delete c.grade;
    delete c.blendEnabled;
    const m = migrateProject(p);
    expect(m).not.toBe(p);
    const mc = m.tracks[0]!.clips[0] as VisualClip;
    expect(mc.adjust).toEqual({ ...defaultAdjust(), brightness: 10 });
    expect(mc.grade).toEqual(defaultGrade());
    expect(mc.blendEnabled).toBe(true);
    // idempotent
    expect(migrateProject(m)).toBe(m);

    const partial = JSON.parse(JSON.stringify(m)) as Project;
    const pc = partial.tracks[0]!.clips[0] as VisualClip;
    (pc.grade as Partial<VisualClip['grade']>) = { curves: { ...defaultGrade().curves, master: [{ x: 0, y: 1 }, { x: 1, y: 0 }] } } as never;
    const pm = migrateProject(partial).tracks[0]!.clips[0] as VisualClip;
    expect(pm.grade.curves.master).toEqual([{ x: 0, y: 1 }, { x: 1, y: 0 }]);
    expect(pm.grade.hsl).toEqual(defaultGrade().hsl);
    void id;
  });

  it('setProject runs the migration', () => {
    withVideo();
    const p = JSON.parse(JSON.stringify(st().project)) as Project;
    delete (p.tracks[0]!.clips[0] as Partial<VisualClip>).grade;
    st().setProject(p);
    expect((st().project.tracks[0]!.clips[0] as VisualClip).grade).toEqual(defaultGrade());
  });

  it('updateClip replaces grade sections, is undoable and never shares objects between clips', () => {
    const id = withVideo();
    const id2 = st().addClip(Object.keys(st().project.assets)[0]!, { at: secToUs(4) })!;
    const hsl = defaultGrade().hsl;
    hsl.bands.red.saturation = -100;
    st().updateClips([id, id2], { grade: { hsl } });
    expect(clipOf(id).grade.hsl.bands.red.saturation).toBe(-100);
    expect(clipOf(id).grade.curves).toEqual(defaultGrade().curves);
    expect(clipOf(id).grade.hsl).not.toBe(clipOf(id2).grade.hsl);
    hsl.bands.red.saturation = 5; // the caller's object is not stored
    expect(clipOf(id2).grade.hsl.bands.red.saturation).toBe(-100);
    st().updateClip(id, { adjust: { whites: 20, grain: 40 } });
    expect(clipOf(id).adjust.whites).toBe(20);
    st().undo();
    expect(clipOf(id).adjust.whites).toBe(0);
    st().undo();
    expect(clipOf(id).grade.hsl.bands.red.saturation).toBe(0);
    st().redo();
    expect(clipOf(id2).grade.hsl.bands.red.saturation).toBe(-100);
  });
});
