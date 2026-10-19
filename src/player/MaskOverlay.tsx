/**
 * On-canvas mask handles (CapCut): shown over the selected clip while Video › Mask is open and the
 * clip has a mask. Dashed outline of the shape; drag the centre dot to move it, the corner square
 * to size it, the round handle to rotate it and the arrow below to feather it. Each drag is one
 * undo step. Maths in ./maskMath.ts.
 */
import type { DrawnBox } from '../engine/render';
import { heartPoints, starPoints } from '../engine/render/mask';
import { findClip } from '../model/project';
import type { ClipMask, Id } from '../model/types';
import { useEditor } from '../store';
import { useMaskEdit } from './maskEdit';
import { featherFromDrag, maskPositionAt, maskRotationFromDrag, maskScreenFrame, maskSizeAt, type ClipFrame, type Pt } from './maskMath';

type Kind = 'move' | 'size' | 'rotate' | 'feather';

function shapePath(m: ClipMask, w: number, h: number): string | null {
  if (m.shape === 'heart' || m.shape === 'star') {
    const pts = m.shape === 'heart' ? heartPoints(w, h) : starPoints(w, h);
    return pts.map((p, i) => `${i ? 'L' : 'M'}${(p.x + w / 2).toFixed(1)} ${(p.y + h / 2).toFixed(1)}`).join(' ') + ' Z';
  }
  return null;
}

export function MaskOverlay(props: { box: DrawnBox; k: number; toProject: (e: { clientX: number; clientY: number }) => Pt }) {
  const active = useMaskEdit((s) => s.active);
  const clip = useEditor((s) => findClip(s.project, props.box.clipId)?.clip);
  if (!active || !clip || (clip.type !== 'video' && clip.type !== 'image') || clip.mask.shape === 'none') return null;
  const { box, k } = props;
  const m = clip.mask;
  const f: ClipFrame = { cx: box.cx, cy: box.cy, w: box.w, h: box.h, rotation: box.rotation, flipH: clip.transform.flipH, flipV: clip.transform.flipV };
  const mf = maskScreenFrame(m, f);
  const open = m.shape === 'linear' || m.shape === 'mirror';
  const W = Math.max(1, mf.w * k);
  const H = Math.max(1, mf.h * k);
  const lineLen = Math.hypot(box.w, box.h) * k * 1.2;
  const ref = open ? 0.5 * Math.min(f.w, f.h) : 0.5 * Math.min(mf.w, mf.h);
  const featherGap = 14 + (m.feather / 100) * ref * k * 0.5;

  const start = (kind: Kind, clipId: Id) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const s = useEditor.getState();
    const f0 = findClip(s.project, clipId);
    if (!f0 || f0.track.locked) return;
    const m0 = { ...m };
    const from = props.toProject(e);
    const centre = { x: mf.cx, y: mf.cy };
    s.beginTx();
    const move = (ev: PointerEvent) => {
      const pt = props.toProject(ev);
      const st = useEditor.getState();
      if (kind === 'move') {
        const target = { x: centre.x + pt.x - from.x, y: centre.y + pt.y - from.y };
        st.updateClip(clipId, { mask: maskPositionAt(f, target) });
      } else if (kind === 'size') {
        const sz = maskSizeAt(m0, f, pt);
        st.updateClip(clipId, { mask: m0.shape === 'mirror' ? { height: sz.height } : sz });
      } else if (kind === 'rotate') {
        st.updateClip(clipId, { mask: { rotation: maskRotationFromDrag(m0.rotation, f, centre, from, pt) } });
      } else {
        // the feather arrow points along the mask's local +y (down when unrotated)
        const a = (mf.rotation * Math.PI) / 180;
        const dist = (pt.x - from.x) * -Math.sin(a) + (pt.y - from.y) * Math.cos(a);
        st.updateClip(clipId, { mask: { feather: featherFromDrag(m0.feather, dist * 2, ref) } });
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      const st = useEditor.getState();
      if (ev.type === 'pointercancel') st.cancelTx();
      else st.commitTx();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };

  const path = shapePath(m, W, H);
  return (
    <div
      className="player__mask"
      data-testid="player-mask"
      style={{ left: mf.cx * k, top: mf.cy * k, transform: `translate(-50%, -50%) rotate(${mf.rotation}deg)` }}
    >
      {m.shape === 'linear' && <div className="player__mask-line" style={{ width: lineLen }} />}
      {m.shape === 'mirror' && (
        <>
          <div className="player__mask-line" style={{ width: lineLen, transform: `translate(-50%, ${-H / 2}px)` }} />
          <div className="player__mask-line" style={{ width: lineLen, transform: `translate(-50%, ${H / 2}px)` }} />
        </>
      )}
      {!open && (
        <svg className="player__mask-shape" width={W} height={H} style={{ left: -W / 2, top: -H / 2 }}>
          {m.shape === 'circle' && <ellipse cx={W / 2} cy={H / 2} rx={W / 2 - 1} ry={H / 2 - 1} />}
          {m.shape === 'rectangle' && (
            <rect x={1} y={1} width={W - 2} height={H - 2} rx={(m.roundCorners / 100) * (Math.min(W, H) / 2)} />
          )}
          {path && <path d={path} />}
        </svg>
      )}
      <div className="player__mask-handle player__mask-move" title="Move mask" onPointerDown={start('move', clip.id)} />
      {m.shape !== 'linear' && (
        <div
          className="player__mask-handle player__mask-size"
          title="Resize mask"
          style={{ left: m.shape === 'mirror' ? 0 : W / 2, top: H / 2 }}
          onPointerDown={start('size', clip.id)}
        />
      )}
      <div className="player__mask-handle player__mask-rotate" title="Rotate mask" style={{ top: -(open ? 28 : H / 2 + 22) }} onPointerDown={start('rotate', clip.id)} />
      <div
        className="player__mask-handle player__mask-feather"
        title="Feather"
        style={{ top: (open ? (m.shape === 'mirror' ? H / 2 : 0) : H / 2) + featherGap }}
        onPointerDown={start('feather', clip.id)}
      />
    </div>
  );
}
