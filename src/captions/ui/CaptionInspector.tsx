/**
 * The caption lab — the inspector for a caption clip.
 *  - Captions: every caption of the track with editable text (timings kept), split / merge,
 *    nudge, delete, a whole-track sync offset, and per-word timings for the selected caption.
 *  - Style: font, size, weight, colours, highlight, glow, stroke, shadow, box, position and safe
 *    area, alignment, max lines, animation (MakePodcast presets) — for all captions or this one.
 *  - Animation: the clip In / Out / Loop animations (the text catalogue).
 * Every change is a store action (undoable); typing is one undo step per commit.
 */
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../../store';
import { usePref } from '../../panels/prefs';
import { Tabs } from '../../ui/controls';
import { ColorInput, FieldRow, SegmentedTabs, Section, SliderRow, ToggleRow } from '../../inspector/controls';
import { AnimationTab } from '../../inspector/tabs/AnimationTab';
import { clipEnd, frameUs } from '../../model/time';
import type { Id, Us } from '../../model/types';
import { captionOrigin, isCaptionClip, isRTLText, resolveStyle, trackOfClip, visibleWordIndices, type CaptionClip } from '../model';
import * as cops from '../ops';
import { CAPTION_FONT_FAMILIES, CAPTION_PRESETS, HIGHLIGHT_SWATCHES } from '../presets';
import { formatTimestamp } from '../srt';
import type { CaptionAnimation, CaptionStyle } from '../types';
import { PresetThumb } from './PresetThumb';
import { applyCaptionPreset, edit, resplit, setTrackStyle } from './actions';
import './captions.css';

const ANIMATIONS: { id: CaptionAnimation; label: string }[] = [
  { id: 'highlight', label: 'Karaoke (highlight spoken word)' },
  { id: 'karaoke-fill', label: 'Karaoke fill (sweep)' },
  { id: 'box', label: 'Highlight box' },
  { id: 'word-pop', label: 'Word pop (one word)' },
  { id: 'pop-highlight', label: 'Hormozi (pop + highlight)' },
  { id: 'bounce', label: 'Bounce' },
  { id: 'reveal', label: 'Word reveal' },
  { id: 'none', label: 'None (static)' },
];

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];

const t2 = (us: Us) => formatTimestamp(us, '.').replace(/^00:/, '');
const sec = (us: Us) => (us / 1e6).toFixed(2);

export function CaptionInspector({ clip }: { clip: CaptionClip }) {
  const [tab, setTab] = usePref<string>('insp.tab.caption', 'captions');
  const items = [
    { id: 'captions', label: 'Captions' },
    { id: 'style', label: 'Style' },
    { id: 'animation', label: 'Animation' },
  ];
  const value = items.some((i) => i.id === tab) ? tab : 'captions';
  return (
    <div className="insp" data-testid="inspector-caption">
      <Tabs items={items} value={value} onChange={setTab} />
      <div className="insp__body">
        {value === 'captions' && <CaptionList clip={clip} />}
        {value === 'style' && <StylePanel clip={clip} />}
        {value === 'animation' && <AnimationTab key={clip.id} clip={clip} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- captions list

function CaptionList({ clip }: { clip: CaptionClip }) {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const track = trackOfClip(project, clip.id);
  const captions = (track?.clips ?? []).filter(isCaptionClip);
  const locked = !!track?.locked;
  const listRef = useRef<HTMLDivElement>(null);
  const frame = frameUs(project.settings.fps);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.caplab__row.is-current')?.scrollIntoView?.({ block: 'nearest' });
  }, [clip.id]);
  if (!track) return null;
  const lang = track.captions?.language;
  return (
    <div className="caplab" data-testid="caption-lab">
      <div className="caplab__bar">
        <span data-testid="caplab-count">
          {captions.length} captions{lang ? ` · ${lang === 'he' ? 'Hebrew' : lang === 'en' ? 'English' : lang}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <ResplitControl trackId={track.id} locked={locked} />
      </div>
      <div className="caplab__bar">
        <span title="Move every caption of the track (sync to the voice)">Sync all captions</span>
        <button className="btn" disabled={locked} onClick={() => edit((d) => cops.nudgeCaptions(d, track.id, [], -100_000))} data-testid="caplab-sync-minus">
          −0.1 s
        </button>
        <button className="btn" disabled={locked} onClick={() => edit((d) => cops.nudgeCaptions(d, track.id, [], 100_000))} data-testid="caplab-sync-plus">
          +0.1 s
        </button>
      </div>
      <div className="caplab__list" ref={listRef}>
        {captions.map((c, i) => (
          <CaptionRow key={c.id} clip={c} current={c.id === clip.id} playing={playhead >= c.start && playhead < clipEnd(c)} locked={locked} hasNext={i < captions.length - 1 && captions[i + 1]!.start - clipEnd(c) < 2_000_000} frame={frame} trackId={track.id} />
        ))}
      </div>
    </div>
  );
}

function ResplitControl({ trackId, locked }: { trackId: Id; locked: boolean }) {
  const [n, setN] = usePref<number>('cap.resplitWords', 4);
  return (
    <>
      <label title="Words per caption">
        Words{' '}
        <input type="number" min={1} max={20} value={n} className="caplab__num" aria-label="Words per caption" data-testid="caplab-resplit-words" onChange={(e) => setN(Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))))} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <button className="btn" disabled={locked} onClick={() => resplit(trackId, n, Math.max(12, n * 8))} title="Regroup every caption with this many words (word timings are kept)" data-testid="caplab-resplit">
        Re-split
      </button>
    </>
  );
}

function CaptionRow(props: { clip: CaptionClip; current: boolean; playing: boolean; locked: boolean; hasNext: boolean; frame: number; trackId: Id }) {
  const { clip, locked } = props;
  const st = useEditor.getState;
  const vis = visibleWordIndices(clip);
  const text = vis.map((i) => clip.caption.words[i]!.text).join(' ');
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== text) edit((d) => cops.editCaptionText(d, clip.id, draft));
    setDraft(null);
  };
  const go = () => {
    st().select([clip.id]);
    st().setPlayhead(clip.start);
  };
  return (
    <div className={`caplab__row${props.current ? ' is-current' : ''}${props.playing ? ' is-playing' : ''}`} data-testid="caplab-row" data-clip-id={clip.id}>
      <div className="caplab__head">
        <span className="caplab__time" onClick={go} title="Go to this caption">
          {t2(clip.start)} → {t2(clipEnd(clip))}
        </span>
        <button className="icon-btn" title="Earlier by one frame" disabled={locked} onClick={() => edit((d) => cops.nudgeCaptions(d, props.trackId, [clip.id], -props.frame))} data-testid="caplab-nudge-left">
          ‹
        </button>
        <button className="icon-btn" title="Later by one frame" disabled={locked} onClick={() => edit((d) => cops.nudgeCaptions(d, props.trackId, [clip.id], props.frame))} data-testid="caplab-nudge-right">
          ›
        </button>
        <button className="icon-btn" title="Merge with the next caption" disabled={locked || !props.hasNext} onClick={() => edit((d) => cops.mergeWithNext(d, clip.id))} data-testid="caplab-merge">
          ⤓
        </button>
        <button className="icon-btn" title="Delete this caption" disabled={locked} onClick={() => st().deleteClips([clip.id])} data-testid="caplab-delete">
          ✕
        </button>
      </div>
      <textarea
        className="caplab__text"
        dir={isRTLText(text) ? 'rtl' : 'auto'}
        rows={1}
        value={draft ?? text}
        disabled={locked}
        aria-label="Caption text"
        data-testid="caplab-text"
        onFocus={() => !props.current && go()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
          if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
      {props.current && <WordTimings clip={clip} locked={locked} />}
    </div>
  );
}

function TimeBox(props: { value: Us; disabled: boolean; label: string; onCommit: (us: Us) => void; testId?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.replace(',', '.'));
    setDraft(null);
    if (Number.isFinite(v)) props.onCommit(Math.round(v * 1e6));
  };
  return (
    <input
      value={draft ?? sec(props.value)}
      aria-label={props.label}
      title={`${props.label} (seconds on the timeline)`}
      disabled={props.disabled}
      data-testid={props.testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

function WordTimings({ clip, locked }: { clip: CaptionClip; locked: boolean }) {
  const playhead = useEditor((s) => s.playhead);
  const o = captionOrigin(clip);
  const vis = visibleWordIndices(clip);
  const retime = (i: number, s: Us, e: Us) => edit((d) => cops.retimeCaptionWord(d, clip.id, i, s, e));
  const step = 40_000;
  return (
    <div className="caplab__words" data-testid="caplab-words">
      {vis.map((i, k) => {
        const w = clip.caption.words[i]!;
        const s = w.start + o;
        const e = w.end + o;
        return (
          <div key={i} className={`caplab__word${playhead >= s && playhead < e ? ' is-active' : ''}`} data-testid="caplab-word">
            <div className="caplab__word-text" dir="auto">
              {w.text}
            </div>
            <div className="caplab__word-times">
              <TimeBox value={s} disabled={locked} label="Word start" onCommit={(v) => retime(i, v, e)} testId="caplab-word-start" />
              <TimeBox value={e} disabled={locked} label="Word end" onCommit={(v) => retime(i, s, v)} testId="caplab-word-end" />
            </div>
            <div className="caplab__word-tools">
              <button title="Earlier by 40 ms" disabled={locked} onClick={() => retime(i, s - step, e - step)}>
                ‹
              </button>
              <button title="Start at the playhead" disabled={locked} onClick={() => retime(i, playhead, Math.max(e, playhead + 60_000))} data-testid="caplab-word-at-playhead">
                ⇤
              </button>
              <button title="Later by 40 ms" disabled={locked} onClick={() => retime(i, s + step, e + step)}>
                ›
              </button>
              <button title="Split the caption before this word" disabled={locked || k === 0} onClick={() => edit((d) => cops.splitCaption(d, clip.id, k))} data-testid="caplab-split">
                ✂
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- style

function StylePanel({ clip }: { clip: CaptionClip }) {
  const project = useEditor((s) => s.project);
  const updateClip = useEditor((s) => s.updateClip);
  const track = trackOfClip(project, clip.id);
  const [scope, setScope] = usePref<'all' | 'this'>('cap.styleScope', 'all');
  if (!track) return null;
  const locked = track.locked;
  const s = resolveStyle(track, clip, project);
  const hasOverride = !!clip.caption.style && Object.keys(clip.caption.style).length > 0;
  const set = (patch: Partial<CaptionStyle>) => {
    if (locked) return;
    if (scope === 'this' || !track.captions) {
      const cur = clip.caption.style ?? {};
      const merged: Partial<CaptionStyle> = { ...patch };
      if (patch.stroke) merged.stroke = { ...s.stroke, ...cur.stroke, ...patch.stroke };
      if (patch.shadow) merged.shadow = { ...s.shadow, ...cur.shadow, ...patch.shadow };
      if (patch.background) merged.background = { ...s.background, ...cur.background, ...patch.background };
      edit((d) => cops.setCaptionOverride(d, clip.id, merged));
    } else setTrackStyle(track.id, patch);
  };
  const hebrew = isRTLText(clip.text.content);
  const W = project.settings.width;
  const H = project.settings.height;
  return (
    <div data-testid="caption-style">
      <div className="caplab__scope">
        <SegmentedTabs<'all' | 'this'>
          label="Apply to"
          items={[
            { id: 'all', label: 'All captions' },
            { id: 'this', label: 'This caption', dot: hasOverride },
          ]}
          value={scope}
          onChange={setScope}
        />
      </div>
      {scope === 'this' && hasOverride && (
        <button className="btn" style={{ marginBottom: 6 }} disabled={locked} onClick={() => edit((d) => cops.setCaptionOverride(d, clip.id, null))} data-testid="cap-clear-override">
          Use the track style for this caption
        </button>
      )}
      {scope === 'all' && track.captions && (
        <Section id="cap-presets" title="Presets">
          <div className="caplab__presets">
            {CAPTION_PRESETS.map((p) => (
              <button key={p.id} className={`cap-tile${s.preset === p.id ? ' is-active' : ''}`} title={p.desc} disabled={locked} onClick={() => applyCaptionPreset(track.id, p.id)} data-testid={`caplab-preset-${p.id}`}>
                <PresetThumb presetId={p.id} hebrew={hebrew} width={120} />
                <span className="cap-tile__label">{p.label}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
      <Section id="cap-text" title="Text">
        <FieldRow label="Animation">
          <select value={s.animation} aria-label="Caption animation" data-testid="cap-animation" disabled={locked} onChange={(e) => set({ animation: e.target.value as CaptionAnimation })}>
            {ANIMATIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="Font">
          <select value={s.fontFamily} aria-label="Caption font" data-testid="cap-font" disabled={locked} style={{ fontFamily: s.fontFamily }} onChange={(e) => set({ fontFamily: e.target.value })}>
            {(CAPTION_FONT_FAMILIES.includes(s.fontFamily) ? CAPTION_FONT_FAMILIES : [s.fontFamily, ...CAPTION_FONT_FAMILIES]).map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f === 'system-ui' ? 'System' : f}
              </option>
            ))}
          </select>
        </FieldRow>
        <FieldRow label="Weight">
          <select value={s.fontWeight} aria-label="Caption weight" data-testid="cap-weight" disabled={locked} onChange={(e) => set({ fontWeight: Number(e.target.value) })}>
            {(WEIGHTS.includes(s.fontWeight) ? WEIGHTS : [...WEIGHTS, s.fontWeight].sort()).map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </FieldRow>
        <SliderRow label="Size" value={s.fontSize} min={8} max={Math.round(Math.min(W, H) * 0.3)} disabled={locked} onChange={(v) => set({ fontSize: Math.round(v) })} keyframe={false} testId="cap-size" />
        <ToggleRow label="ALL CAPS" on={s.uppercase} disabled={locked} onChange={(uppercase) => set({ uppercase })} />
        <ToggleRow label="Italic" on={s.italic} disabled={locked} onChange={(italic) => set({ italic })} />
        <FieldRow label="Color">
          <ColorInput label="Caption color" value={s.color} disabled={locked} onChange={(color) => set({ color })} />
        </FieldRow>
        <FieldRow label="Highlight">
          <div className="caplab__swatches">
            {HIGHLIGHT_SWATCHES.map((sw) => (
              <button
                key={sw.hex}
                className={`caplab__swatch${sw.hex.toLowerCase() === s.highlightColor.toLowerCase() ? ' is-active' : ''}`}
                style={{ background: sw.hex }}
                title={sw.name}
                aria-label={`Highlight ${sw.name}`}
                disabled={locked}
                onClick={() => set({ highlightColor: sw.hex })}
              />
            ))}
            <ColorInput label="Highlight color" value={s.highlightColor} disabled={locked} onChange={(highlightColor) => set({ highlightColor })} />
          </div>
        </FieldRow>
        <ToggleRow label="Glow (MakePodcast)" hint="Soft halo around each word instead of the drop shadow" on={s.glow} disabled={locked} onChange={(glow) => set({ glow })} />
      </Section>

      <Section id="cap-stroke" title="Stroke" checked={s.stroke.enabled} onCheck={(enabled) => set({ stroke: { ...s.stroke, enabled } })}>
        <FieldRow label="Color" disabled={!s.stroke.enabled}>
          <ColorInput label="Stroke color" value={s.stroke.color} disabled={locked || !s.stroke.enabled} onChange={(color) => set({ stroke: { ...s.stroke, color } })} />
        </FieldRow>
        <SliderRow label="Width" value={s.stroke.width} min={0} max={30} step={0.5} digits={1} disabled={locked || !s.stroke.enabled} onChange={(v) => set({ stroke: { ...s.stroke, width: Math.round(v * 2) / 2 } })} keyframe={false} />
      </Section>

      <Section id="cap-shadow" title="Shadow" checked={s.shadow.enabled} onCheck={(enabled) => set({ shadow: { ...s.shadow, enabled } })}>
        <FieldRow label="Color" disabled={!s.shadow.enabled}>
          <ColorInput label="Shadow color" value={s.shadow.color} disabled={locked || !s.shadow.enabled} onChange={(color) => set({ shadow: { ...s.shadow, color } })} />
        </FieldRow>
        <SliderRow label="Blur" value={s.shadow.blur} min={0} max={60} disabled={locked || !s.shadow.enabled} onChange={(v) => set({ shadow: { ...s.shadow, blur: Math.round(v) } })} keyframe={false} />
        <SliderRow label="Offset Y" value={s.shadow.offsetY} min={-30} max={30} fillFrom={0} disabled={locked || !s.shadow.enabled} onChange={(v) => set({ shadow: { ...s.shadow, offsetY: Math.round(v) } })} keyframe={false} />
      </Section>

      <Section id="cap-box" title="Background box" checked={s.background.enabled} onCheck={(enabled) => set({ background: { ...s.background, enabled } })}>
        <FieldRow label="Color" disabled={!s.background.enabled}>
          <ColorInput label="Box color" value={s.background.color} disabled={locked || !s.background.enabled} onChange={(color) => set({ background: { ...s.background, color } })} />
        </FieldRow>
        <SliderRow label="Opacity" value={Math.round(s.background.opacity * 100)} min={0} max={100} unit="%" disabled={locked || !s.background.enabled} onChange={(v) => set({ background: { ...s.background, opacity: Math.round(v) / 100 } })} keyframe={false} />
        <SliderRow label="Corners" value={s.background.radius} min={0} max={60} disabled={locked || !s.background.enabled} onChange={(v) => set({ background: { ...s.background, radius: Math.round(v) } })} keyframe={false} />
      </Section>

      <Section id="cap-position" title="Position & layout">
        <FieldRow label="Place">
          <SegmentedTabs<string>
            label="Vertical position"
            items={[
              { id: 'top', label: 'Top' },
              { id: 'middle', label: 'Middle' },
              { id: 'bottom', label: 'Bottom' },
            ]}
            value={s.y < 0.34 ? 'top' : s.y > 0.66 ? 'bottom' : 'middle'}
            onChange={(id) => set({ y: id === 'top' ? 0.15 : id === 'middle' ? 0.5 : W > H ? 0.86 : 0.8 })}
          />
        </FieldRow>
        <SliderRow label="Vertical" value={Math.round(s.y * 100)} min={0} max={100} unit="%" disabled={locked} onChange={(v) => set({ y: Math.round(v) / 100 })} keyframe={false} testId="cap-y" />
        <SliderRow label="Horizontal" value={Math.round(s.x * 100)} min={-50} max={50} fillFrom={0} unit="%" disabled={locked} onChange={(v) => set({ x: Math.round(v) / 100 })} keyframe={false} />
        <ToggleRow label="Keep inside the safe area" hint="5 % from every edge" on={s.safeArea} disabled={locked} onChange={(safeArea) => set({ safeArea })} />
        <FieldRow label="Alignment">
          <SegmentedTabs<CaptionStyle['align']>
            label="Caption alignment"
            items={[
              { id: 'left', label: 'Left' },
              { id: 'center', label: 'Center' },
              { id: 'right', label: 'Right' },
            ]}
            value={s.align}
            onChange={(align) => set({ align })}
          />
        </FieldRow>
        <SliderRow label="Max width" value={Math.round(s.maxWidth * 100)} min={20} max={100} unit="%" disabled={locked} onChange={(v) => set({ maxWidth: Math.round(v) / 100 })} keyframe={false} />
        <SliderRow label="Max lines" value={s.maxLines} min={1} max={4} disabled={locked} onChange={(v) => set({ maxLines: Math.round(v) })} keyframe={false} testId="cap-max-lines" />
        <SliderRow label="Line height" value={Math.round(s.lineHeight * 100) / 100} min={0.8} max={2.5} step={0.05} digits={2} unit="x" disabled={locked} onChange={(v) => set({ lineHeight: Math.round(v * 100) / 100 })} keyframe={false} />
        <SliderRow label="Word spacing" value={Math.round(s.wordSpacing * 100)} min={0} max={100} unit="%" disabled={locked} onChange={(v) => set({ wordSpacing: Math.round(v) / 100 })} keyframe={false} />
        {(clip.transform.x !== 0 || clip.transform.y !== 0) && (
          <button className="btn" disabled={locked} onClick={() => updateClip(clip.id, { transform: { x: 0, y: 0 } })} data-testid="cap-reset-drag">
            Reset this caption&apos;s dragged position
          </button>
        )}
      </Section>
    </div>
  );
}
