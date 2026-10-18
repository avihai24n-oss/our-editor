/** Inspector states without a clip: Project details, a selected transition, several clips. */
import { useState } from 'react';
import { ASPECTS, TRANSITIONS } from '../../model/catalog';
import { formatTimecode, projectDuration, secToUs, usToSec } from '../../model/time';
import type { AspectRatio, Transition } from '../../model/types';
import { useEditor } from '../../store';
import { TransitionPreview } from '../../panels/TransitionsTab';
import { SegmentedTabs, Section, SliderRow } from '../controls';
import { transitionMax } from '../inspectorLogic';

export function ProjectPanel() {
  const project = useEditor((s) => s.project);
  const setProjectName = useEditor((s) => s.setProjectName);
  const setAspectRatio = useEditor((s) => s.setAspectRatio);
  const [draft, setDraft] = useState<string | null>(null);
  const st = project.settings;
  const assets = Object.values(project.assets);
  const counts = { video: 0, image: 0, audio: 0 };
  for (const a of assets) counts[a.kind]++;
  const clipCount = project.tracks.reduce((n, t) => n + t.clips.length, 0);

  return (
    <div className="iproject">
      <Section id="project-details" title="Details">
        <dl className="idl">
          <dt>Name</dt>
          <dd>
            <input
              className="idl__input"
              aria-label="Project name"
              value={draft ?? project.name}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft !== null && draft !== project.name) setProjectName(draft);
                setDraft(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setDraft(null);
              }}
            />
          </dd>
          <dt>Ratio</dt>
          <dd>
            <SegmentedTabs<AspectRatio>
              label="Aspect ratio"
              items={ASPECTS.map((a) => ({ id: a.id, label: a.label }))}
              value={st.aspect}
              onChange={setAspectRatio}
            />
          </dd>
          <dt>Resolution</dt>
          <dd>
            {st.width} × {st.height}
          </dd>
          <dt>Frame rate</dt>
          <dd>{st.fps} fps</dd>
          <dt>Duration</dt>
          <dd className="idl__mono">{formatTimecode(projectDuration(project), st.fps)}</dd>
          <dt>Media</dt>
          <dd>
            {assets.length} imported
            {assets.length > 0 && (
              <span className="idl__dim">
                {' '}
                · {counts.video} video · {counts.image} image · {counts.audio} audio
              </span>
            )}
          </dd>
          <dt>Clips</dt>
          <dd>{clipCount}</dd>
        </dl>
      </Section>
      <p className="ihint">Select a clip on the timeline to edit it.</p>
    </div>
  );
}

export function TransitionPanel({ transition }: { transition: Transition }) {
  const updateTransition = useEditor((s) => s.updateTransition);
  const removeTransition = useEditor((s) => s.removeTransition);
  const applyTransitionToAll = useEditor((s) => s.applyTransitionToAll);
  const max = useEditor((s) => transitionMax(s.project, transition.id));
  const maxSec = Math.max(0.1, Math.floor(usToSec(max) * 10) / 10);
  return (
    <>
      <Section id="transition-type" title="Transition">
        <div className="itrans-grid">
          {TRANSITIONS.map((t) => (
            <button
              key={t.id}
              className={`itrans${transition.type === t.id ? ' is-active' : ''}`}
              aria-pressed={transition.type === t.id}
              title={t.label}
              onClick={() => updateTransition(transition.id, { type: t.id })}
            >
              <span className="itrans__preview">
                <TransitionPreview type={t.id} />
              </span>
              <span className="itrans__label">{t.label}</span>
            </button>
          ))}
        </div>
        <SliderRow
          label="Duration"
          value={Math.min(maxSec, Math.round(usToSec(transition.duration) * 10) / 10)}
          min={0.1}
          max={maxSec}
          step={0.1}
          digits={1}
          unit="s"
          keyframe={false}
          onChange={(v) => updateTransition(transition.id, { duration: Math.min(max, secToUs(v)) })}
          testId="transition-duration"
        />
      </Section>
      <div className="ifoot">
        <button className="btn" onClick={() => removeTransition(transition.id)}>
          Remove
        </button>
        <span className="ifoot__spacer" />
        <button className="btn" onClick={() => applyTransitionToAll(transition.id)} title="Use this transition on every cut of this track">
          Apply to all
        </button>
      </div>
    </>
  );
}

export function MultiPanel({ count }: { count: number }) {
  const deleteSelected = useEditor((s) => s.deleteSelected);
  const clearSelection = useEditor((s) => s.clearSelection);
  return (
    <div className="imulti">
      <div className="imulti__title">{count} clips selected</div>
      <p className="ihint">Select a single clip to edit its properties. Looks from the Filters and Adjustment tabs apply to every selected clip.</p>
      <div className="imulti__actions">
        <button className="btn" onClick={clearSelection}>
          Deselect
        </button>
        <button className="btn" onClick={deleteSelected}>
          Delete
        </button>
      </div>
    </div>
  );
}
