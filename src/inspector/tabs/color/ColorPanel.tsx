/**
 * Adjust › Color: the DaVinci Resolve–style colour page.
 *   toolbar  — Color page on/off, Copy grade, Paste grade, Grab still (+ Scopes / Split live in
 *              the player bar)
 *   Gallery  — saved stills (grade + thumbnail, per browser) and built-in film looks
 *   CST      — input colour space transform (log → Rec.709, Rec.709 → log)
 *   Primaries (wheels + bar), Log wheels, HSL curves, Qualifier (secondary)
 * Everything goes through updateClip(s) (undoable; slider / wheel / curve drags = one step).
 */
import { useEffect, useState } from 'react';
import { gradeImageData, gradeParams } from '../../../engine/color';
import { defaultAdjust, defaultGrade } from '../../../model/defaults';
import { neutralFrameImage } from '../../../player/color/colorView';
import { defaultColorPage, type CstInput } from '../../../model/colorPage';
import type { VisualClip } from '../../../model/types';
import { applyLook, grabPlayerThumb, useGradeStills, type GradeLook } from '../../../store/gradeStills';
import { useEditor } from '../../../store';
import { FieldRow, Section } from '../../controls';
import { useSetColorPage } from './common';
import { HslCurvesSection } from './HslCurvesSection';
import { LogWheelsSection } from './LogWheelsSection';
import { BUILT_IN_LOOKS } from './looks';
import { PrimariesSection } from './PrimariesSection';
import { QualifierSection } from './QualifierSection';
import './color.css';

const CST_OPTIONS: { id: CstInput; label: string }[] = [
  { id: 'none', label: 'None (Rec.709)' },
  { id: 'arri-logc3', label: 'ARRI LogC3 → Rec.709' },
  { id: 'sony-slog3', label: 'Sony S-Log3 → Rec.709' },
  { id: 'pana-vlog', label: 'Panasonic V-Log → Rec.709' },
  { id: 'rec709-to-log', label: 'Rec.709 → Log (flat)' },
];

function flashMsg(set: (m: string | null) => void, msg: string) {
  set(msg);
  window.setTimeout(() => set(null), 2000);
}

export function ColorPanel({ clip }: { clip: VisualClip }) {
  const set = useSetColorPage(clip);
  const updateClip = useEditor((s) => s.updateClip);
  const cp = clip.grade.color;
  const clipboard = useGradeStills((s) => s.clipboard);
  const copy = useGradeStills((s) => s.copy);
  const stills = useGradeStills((s) => s.stills);
  const addStill = useGradeStills((s) => s.addStill);
  const removeStill = useGradeStills((s) => s.removeStill);
  const [flash, setFlash] = useState<string | null>(null);

  const lookThumbs = useLookThumbs(clip.id);
  const applyStill = (look: GradeLook) => applyLook([clip.id], { ...look, grade: { ...look.grade, mask: clip.grade.mask } });

  return (
    <>
      <div className="icolor-top">
        <label className="icolor-check" title="Turn the whole Color page off (bypass) to compare">
          <input type="checkbox" className="checkbox" checked={cp.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="color-enabled" />
          Color page
        </label>
        <span className="icolor-top__spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => {
            copy(clip);
            flashMsg(setFlash, 'Grade copied');
          }}
          title="Copy this clip's grade (Adjust, Filter, LUT, HSL, Curves, wheels, mask, Color page)"
          data-testid="grade-copy"
        >
          Copy grade
        </button>
        <button
          type="button"
          className="btn"
          disabled={!clipboard}
          onClick={() => {
            if (clipboard && applyLook([clip.id], clipboard).length) flashMsg(setFlash, 'Grade pasted');
          }}
          title="Paste the copied grade onto this clip (select several clips to paste onto all of them)"
          data-testid="grade-paste"
        >
          Paste grade
        </button>
      </div>
      {flash && (
        <div className="iadj-flash icolor-flash" role="status">
          {flash}
        </div>
      )}

      <Section id="color-gallery" title="Gallery" note={`${stills.length} still${stills.length === 1 ? '' : 's'}`}>
        <div className="icolor-gallery" data-testid="color-gallery">
          <button
            type="button"
            className="icolor-still icolor-still--grab"
            onClick={() => {
              addStill(clip, grabPlayerThumb());
              flashMsg(setFlash, 'Still saved to the gallery');
            }}
            title="Grab still: save this grade with a picture of the frame"
            data-testid="grade-grab-still"
          >
            <span className="icolor-still__plus">+</span>
            <span className="icolor-still__name">Grab still</span>
          </button>
          {stills.map((s) => (
            <div key={s.id} className="icolor-still" data-testid="grade-still">
              <button type="button" className="icolor-still__thumb" onClick={() => applyStill(s.look)} title={`Apply “${s.name}”`} style={s.thumb ? { backgroundImage: `url(${s.thumb})` } : undefined} />
              <span className="icolor-still__name">{s.name}</span>
              <button type="button" className="icolor-still__del" aria-label={`Delete ${s.name}`} title="Delete still" onClick={() => removeStill(s.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="igroup">Looks</div>
        <div className="icolor-gallery">
          {BUILT_IN_LOOKS.map((l) => (
            <div key={l.id} className="icolor-still" data-testid={`look-${l.id}`}>
              <button
                type="button"
                className="icolor-still__thumb"
                style={{ backgroundImage: lookThumbs[l.id] ? `url(${lookThumbs[l.id]})` : l.swatch }}
                title={`Apply ${l.name} (replaces the Color page)`}
                onClick={() => set(l.build(cp))}
              />
              <span className="icolor-still__name">{l.name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="color-cst" title="Color space transform" note={cp.cst.input === 'none' ? undefined : 'on'} onReset={() => set({ cst: { input: 'none' } })} resetDisabled={cp.cst.input === 'none'}>
        <FieldRow label="Input">
          <select aria-label="Input colour space" value={cp.cst.input} onChange={(e) => set({ cst: { input: e.target.value as CstInput } })} data-testid="cst-input">
            {CST_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldRow>
        <p className="ihint">The first step of the Color page: decodes log footage to Rec.709 (with a soft highlight roll-off), or flattens Rec.709 into a log look.</p>
      </Section>

      <PrimariesSection clip={clip} />
      <LogWheelsSection clip={clip} />
      <HslCurvesSection clip={clip} />
      <QualifierSection clip={clip} />

      <div className="icolor-foot">
        <button
          type="button"
          className="link-btn"
          onClick={() => updateClip(clip.id, { grade: { color: { ...defaultColorPage(), primaries: { ...defaultColorPage().primaries, lumMix: cp.primaries.lumMix } } } })}
          data-testid="color-reset-all"
        >
          Reset the Color page
        </button>
      </div>
    </>
  );
}

/** Real previews of the built-in looks on the current (ungraded) frame, as data URLs by look id. */
function useLookThumbs(clipId: string): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const t = window.setTimeout(() => {
      const base = neutralFrameImage(160);
      if (!base) return;
      const c = document.createElement('canvas');
      c.width = base.width;
      c.height = base.height;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const out: Record<string, string> = {};
      for (const l of BUILT_IN_LOOKS) {
        const grade = { ...defaultGrade(), color: l.build(defaultColorPage()) };
        const params = gradeParams({ ...defaultAdjust(), grayscale: 0, sepia: 0, grade }, 0);
        const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
        if (params) gradeImageData(img.data, img.width, img.height, params);
        ctx.putImageData(img, 0, 0);
        out[l.id] = c.toDataURL('image/jpeg', 0.8);
      }
      setThumbs(out);
    }, 120);
    return () => window.clearTimeout(t);
  }, [clipId]);
  return thumbs;
}

/** Inspector › several clips selected: paste the copied grade onto all of them (one undo step). */
export function MultiGradePaste() {
  const clipboard = useGradeStills((s) => s.clipboard);
  const ids = useEditor((s) => s.selection.clipIds);
  const [done, setDone] = useState<number | null>(null);
  if (!clipboard) return null;
  return (
    <div className="imulti icolor-multi">
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => setDone(applyLook(ids, clipboard).length)}
        title="Paste the copied grade (Adjust › Color › Copy grade) onto every selected clip"
        data-testid="grade-paste-selected"
      >
        Paste grade to {ids.length} clips
      </button>
      {done !== null && (
        <span className="ihint" role="status">
          Pasted onto {done} clip{done === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}
