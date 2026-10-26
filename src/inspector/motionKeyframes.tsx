/**
 * Inspector side of the motion keyframes (src/model/motionKeys.ts), CapCut behaviour — the same
 * as the volume keys in Audio › Basic:
 *  - the rows show the value at the playhead (keys interpolated);
 *  - editing a keyed property sets the key under the playhead (adding one); with the playhead
 *    off the clip it moves every key of that property by the same amount;
 *  - ◇ on a row adds / removes that property's key at the playhead, ‹ › jump between its keys;
 *    the Transform section's ◇ does position + scale + rotation at once;
 *  - with a key under the playhead, "Keyframe curve" picks the ease from it to the next key.
 * Plus the Ken Burns one-click (video / image).
 */
import { applyKenBurns, keyTolerance } from '../actions/motionKeys';
import {
  KEY_EASES,
  anyKeyAt,
  easeAt,
  hasPropKeys,
  keyedTransformPatch,
  motionKeyTimes,
  motionTransformAt,
  toggleKeysPatch,
  withEaseAt,
  type MotionClip,
} from '../model/motionKeys';
import type { KeyEase, MotionProp, Transform, VisualClip } from '../model/types';
import { useEditor } from '../store';
import { FieldRow, type KeyframeNavProps } from './controls';
import './motionKeyframes.css';

export function useMotionKeys(clip: VisualClip) {
  const updateClip = useEditor((s) => s.updateClip);
  const playhead = useEditor((s) => s.playhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  useEditor((s) => s.project.settings.fps); // re-render on fps change (tolerance)
  const c = clip as MotionClip;
  const tol = keyTolerance();
  const inside = playhead >= clip.start && playhead < clip.start + clip.duration;
  const at = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, playhead));
  const tf = motionTransformAt(c, at);

  const set = (patch: Partial<Transform>) => updateClip(clip.id, keyedTransformPatch(c, patch, playhead, tol));

  const nav = (props: readonly MotionProp[], testId?: string): KeyframeNavProps => {
    const any = props.some((p) => hasPropKeys(c, p));
    const times = any ? motionKeyTimes(c, props) : [];
    const prev = [...times].reverse().find((t) => t < playhead - tol);
    const next = times.find((t) => t > playhead + tol);
    return {
      on: any && inside && anyKeyAt(c, props, playhead, tol),
      any,
      disabled: !inside,
      onToggle: () => {
        const p = toggleKeysPatch(c, props, playhead, tol);
        if (p) updateClip(clip.id, p);
      },
      onPrev: prev !== undefined ? () => setPlayhead(Math.round(prev)) : null,
      onNext: next !== undefined ? () => setPlayhead(Math.round(next)) : null,
      testId,
    };
  };

  const ease = inside ? easeAt(c, playhead, tol) : null;
  const setEase = (e: KeyEase) => {
    const mk = withEaseAt(c, playhead, tol, e);
    if (mk) updateClip(clip.id, { motionKeys: mk });
  };
  /** A property is keyed (its plain transform value is not used). */
  const keyed = (p: MotionProp) => hasPropKeys(c, p);
  return { tf, set, nav, ease, setEase, keyed };
}

/** "Keyframe curve" (with a key under the playhead) and Ken Burns (video / image). */
export function MotionExtras({ clip }: { clip: VisualClip }) {
  const mk = useMotionKeys(clip);
  const kenBurns = clip.type === 'video' || clip.type === 'image';
  return (
    <>
      {mk.ease && (
        <FieldRow label="Keyframe curve">
          <select aria-label="Keyframe curve" data-testid="keyframe-curve" value={mk.ease} onChange={(e) => mk.setEase(e.target.value as KeyEase)}>
            {KEY_EASES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </FieldRow>
      )}
      {kenBurns && (
        <FieldRow label="Ken Burns">
          <span className="imotion__kb">
            <button className="btn imotion__btn" data-testid="ken-burns-in" title="Slow zoom in over the whole clip (2 keyframes)" onClick={() => applyKenBurns(clip.id, 'in')}>
              Zoom in
            </button>
            <button className="btn imotion__btn" data-testid="ken-burns-out" title="Slow zoom out over the whole clip (2 keyframes)" onClick={() => applyKenBurns(clip.id, 'out')}>
              Zoom out
            </button>
          </span>
        </FieldRow>
      )}
    </>
  );
}
