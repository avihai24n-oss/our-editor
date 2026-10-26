/**
 * Store-level motion keyframe actions (src/model/motionKeys.ts holds the pure logic). Used by the
 * inspector, the player's on-canvas handles, the timeline diamonds and ⌥K. Each is one
 * `updateClip` (undoable; locked tracks are refused by the store). Inside a gesture
 * (beginTx … commitTx) many calls make one undo step.
 */
import { findClip } from '../model/project';
import {
  TRANSFORM_PROPS,
  keyedTransformPatch,
  kenBurnsKeys,
  motionTransformAt,
  toggleKeysPatch,
  type KenBurnsDir,
  type MotionClip,
} from '../model/motionKeys';
import { frameUs } from '../model/time';
import type { Id, Transform, Us, VisualClip } from '../model/types';
import { useEditor } from '../store';
import { showToast } from '../ui/appEvents';

/** Half a frame: a key this close to the playhead is "at" the playhead. */
export const keyTolerance = (): number => frameUs(useEditor.getState().project.settings.fps) / 2;

function visualClip(id: Id): VisualClip | null {
  const c = findClip(useEditor.getState().project, id)?.clip;
  return c && c.type !== 'audio' ? c : null;
}

/** The clip's transform as drawn at time t (keys interpolated). */
export function transformAt(id: Id, t: Us = useEditor.getState().playhead): Transform | null {
  const c = visualClip(id);
  return c ? motionTransformAt(c as MotionClip, t) : null;
}

/**
 * A transform edit at the playhead: plain for properties without keys, the key under the playhead
 * for keyed ones (added when none), every key shifted when the playhead is off the clip.
 */
export function setTransformAtPlayhead(id: Id, patch: Partial<Transform>): void {
  const c = visualClip(id);
  if (!c) return;
  const s = useEditor.getState();
  s.updateClip(id, keyedTransformPatch(c as MotionClip, patch, s.playhead, keyTolerance()));
}

/** ⌥K: adds / removes the Transform keys (position, scale, rotation) of the selected clip at the playhead. */
export function toggleSelectedTransformKeys(): boolean {
  const s = useEditor.getState();
  const id = s.selection.clipIds.length === 1 ? s.selection.clipIds[0]! : null;
  const c = id ? visualClip(id) : null;
  if (!c) {
    showToast('Select one video, image or text clip to add a keyframe');
    return false;
  }
  if (findClip(s.project, c.id)?.track.locked) {
    showToast('The track is locked');
    return false;
  }
  const patch = toggleKeysPatch(c as MotionClip, TRANSFORM_PROPS, s.playhead, keyTolerance());
  if (!patch) {
    showToast('Move the playhead over the clip to add a keyframe');
    return false;
  }
  s.updateClip(c.id, patch);
  return true;
}

/** One-click Ken Burns on a video / image clip (slow zoom in or out over the whole clip). */
export function applyKenBurns(id: Id, dir: KenBurnsDir): void {
  const c = visualClip(id);
  if (!c) return;
  const s = useEditor.getState();
  const W = s.project.settings.width;
  // a gentle drift towards the right while zooming in (and back while zooming out)
  const pan = { x: (dir === 'in' ? 1 : -1) * Math.round(W * 0.02), y: 0 };
  s.updateClip(id, { motionKeys: kenBurnsKeys(c as MotionClip, dir, frameUs(s.project.settings.fps), { pan }) });
}
