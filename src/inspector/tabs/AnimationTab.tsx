/**
 * Animation: In | Out sub-tabs (Combo disabled, v2), a grid "None" + the basic animations
 * with hover previews, then a Duration slider. In + Out never exceed the clip.
 */
import { useState } from 'react';
import { ANIMATIONS } from '../../model/catalog';
import { DEFAULT_ANIMATION_DURATION } from '../../model/defaults';
import { secToUs, usToSec } from '../../model/time';
import type { AnimationType, VisualClip } from '../../model/types';
import { useEditor } from '../../store';
import { SegmentedTabs, SliderRow } from '../controls';
import { animationMax } from '../inspectorLogic';

type Phase = 'in' | 'out';

function AnimTile(props: { label: string; type: AnimationType | null; phase: Phase; active: boolean; onClick: () => void }) {
  return (
    <button className={`anim${props.active ? ' is-active' : ''}`} onClick={props.onClick} title={props.label} aria-pressed={props.active}>
      <span className="anim__stage">
        {props.type ? <span className={`anim__box anim--${props.type} anim--${props.phase}`} /> : <span className="anim__none">⊘</span>}
      </span>
      <span className="anim__label">{props.label}</span>
    </button>
  );
}

export function AnimationTab({ clip }: { clip: VisualClip }) {
  const [phase, setPhase] = useState<Phase>('in');
  const setAnimation = useEditor((s) => s.setAnimation);
  const updateClip = useEditor((s) => s.updateClip);
  const current = phase === 'in' ? clip.animationIn : clip.animationOut;
  const other = phase === 'in' ? clip.animationOut : clip.animationIn;
  const max = animationMax(clip.duration, other?.duration ?? 0);

  const choose = (type: AnimationType | null) => {
    const dur = current?.duration ?? Math.min(DEFAULT_ANIMATION_DURATION, max);
    setAnimation(clip.id, phase, type, type ? Math.min(dur, max) : undefined);
  };

  return (
    <>
      <SegmentedTabs
        items={[
          { id: 'in', label: 'In' },
          { id: 'out', label: 'Out' },
          { id: 'combo', label: 'Combo', disabled: true, title: 'Combo animations — coming in v2' },
        ]}
        value={phase}
        onChange={(p) => setPhase(p as Phase)}
      />
      <div className="ipad">
        <div className="anim-grid">
          <AnimTile label="None" type={null} phase={phase} active={!current} onClick={() => choose(null)} />
          {ANIMATIONS.map((a) => (
            <AnimTile key={a.id} label={a.label} type={a.id} phase={phase} active={current?.type === a.id} onClick={() => choose(a.id)} />
          ))}
        </div>
        {current && (
          <SliderRow
            label="Duration"
            value={Math.round(usToSec(current.duration) * 10) / 10}
            min={0.1}
            max={Math.max(0.1, Math.floor(usToSec(max) * 10) / 10)}
            step={0.1}
            digits={1}
            unit="s"
            keyframe={false}
            onChange={(v) => {
              const anim = { type: current.type, duration: Math.min(secToUs(v), max) };
              updateClip(clip.id, phase === 'in' ? { animationIn: anim } : { animationOut: anim });
            }}
            testId="animation-duration"
          />
        )}
      </div>
    </>
  );
}
