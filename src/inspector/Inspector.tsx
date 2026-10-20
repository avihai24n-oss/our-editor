/**
 * Right inspector (CapCut). Final interface: no props. Selection drives it:
 *   nothing → Project details; video → Video/Audio/Speed/Animation/Adjust; image →
 *   Video/Animation/Adjust; audio → Audio/Speed; text → Text/Animation/Adjust;
 *   transition → Transition; several clips → summary.
 * Every edit goes through store actions (undoable); slider drags are one undo step each.
 */
import { useEffect, useState } from 'react';
import { selectSelectedClip, selectSelectedTransition, useEditor } from '../store';
import { onAppEvent } from '../ui/appEvents';
import { usePref } from '../panels/prefs';
import { Tabs } from '../ui/controls';
import { clipTabs, pickTab, TAB_LABELS, type InspectorTab } from './inspectorLogic';
import { AdjustTab } from './tabs/AdjustTab';
import { AnimationTab } from './tabs/AnimationTab';
import { AudioTab, SpeedTab } from './tabs/AudioSpeedTabs';
import { MultiPanel, ProjectPanel, TransitionPanel } from './tabs/OtherPanels';
import { TextTab } from './tabs/TextTab';
import { VideoTab } from './tabs/VideoTab';
import { CompoundVideoTab } from './tabs/CompoundVideoTab';
import './inspector.css';

function Shell(props: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void; children: React.ReactNode; testId: string }) {
  return (
    <div className="insp" data-testid={props.testId}>
      <Tabs items={props.tabs} value={props.value} onChange={props.onChange} />
      <div className="insp__body">{props.children}</div>
    </div>
  );
}

export function Inspector() {
  const clip = useEditor(selectSelectedClip);
  const transition = useEditor(selectSelectedTransition);
  const count = useEditor((s) => s.selection.clipIds.length);
  const asset = useEditor((s) => (clip && clip.type !== 'text' && clip.type !== 'compound' ? s.project.assets[clip.assetId] : undefined));
  // The chosen tab is remembered per clip type (CapCut keeps e.g. "Adjust" while hopping clips).
  const [wanted, setWanted] = usePref<string>(`insp.tab.${clip?.type ?? 'none'}`, '');
  // Speed › Standard | Curve. ⌘R / ⇧B (shortcut table) open the Speed tab on one of them.
  // null = automatic: Curve when the clip has a speed curve, else Standard.
  const [speedSub, setSpeedSub] = useState<'standard' | 'curve' | null>(null);
  useEffect(
    () =>
      onAppEvent('inspectorTab', ({ tab, sub }) => {
        setWanted(tab);
        setSpeedSub(sub ?? null);
      }),
    [setWanted],
  );

  if (transition) {
    return (
      <Shell testId="inspector-transition" tabs={[{ id: 'transition', label: 'Transition' }]} value="transition" onChange={() => undefined}>
        <TransitionPanel key={transition.id} transition={transition} />
      </Shell>
    );
  }

  if (clip) {
    const tabs = clipTabs(clip, asset);
    const tab = pickTab(tabs, wanted as InspectorTab);
    let body: React.ReactNode = null;
    if (tab === 'video' && clip.type === 'compound') {
      body = <CompoundVideoTab clip={clip} />;
    } else if (tab === 'video' && clip.type !== 'audio' && clip.type !== 'text' && clip.type !== 'compound') {
      body = <VideoTab clip={clip} />;
    } else if (tab === 'audio' && (clip.type === 'video' || clip.type === 'audio')) body = <AudioTab clip={clip} />;
    else if (tab === 'speed' && (clip.type === 'video' || clip.type === 'audio')) body = <SpeedTab clip={clip} sub={speedSub ?? (clip.speedCurve ? 'curve' : 'standard')} onSubChange={setSpeedSub} />;
    else if (tab === 'animation' && clip.type !== 'audio') body = <AnimationTab key={clip.id} clip={clip} />;
    else if (tab === 'adjust' && clip.type !== 'audio') body = <AdjustTab clip={clip} />;
    else if (tab === 'text' && clip.type === 'text') body = <TextTab clip={clip} />;

    return (
      <Shell testId={`inspector-${clip.type}`} tabs={tabs.map((id) => ({ id, label: TAB_LABELS[id] }))} value={tab} onChange={(id) => {
          setWanted(id);
          setSpeedSub(null);
        }}>
        {asset?.missing && <div className="inotice">Media lost — the source file for this clip could not be found.</div>}
        {body}
      </Shell>
    );
  }

  if (count > 1) {
    return (
      <Shell testId="inspector-multi" tabs={[{ id: 'multi', label: 'Selection' }]} value="multi" onChange={() => undefined}>
        <MultiPanel count={count} />
      </Shell>
    );
  }

  return (
    <Shell testId="inspector-project" tabs={[{ id: 'project', label: 'Project' }]} value="project" onChange={() => undefined}>
      <ProjectPanel />
    </Shell>
  );
}
