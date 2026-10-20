/**
 * Audio tab (CapCut desktop): sub-tabs Basic | Voice changer.
 *
 * Basic, in CapCut's order: Basic (volume dB, fade in, fade out — checkbox = clip sound on),
 * Normalize loudness (−23 LUFS), Enhance voice (AI, coming soon), Video translator (AI, video
 * clips only, coming soon), Reduce noise (DSP gate, not AI), Isolate voice (AI, coming soon),
 * Fill channel (left / right to both).
 * Voice changer: Voice filters (non-AI DSP, with Strength), Voice characters and Speech to song
 * (AI, coming soon).
 *
 * Every control writes through updateClip (undoable; slider drags are one step) and is saved
 * with the project. A video clip whose sound was extracted shows the link instead of controls.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_ISOLATION_STRENGTH, DEFAULT_VOICE_STRENGTH, VOICE_FILTERS } from '../../audio/dsp';
import { NORMALIZE_TARGET_LUFS, normalizeGainDb } from '../../audio/loudness';
import { loudnessReady, measureSpan, onLoudness, spanKey } from '../../audio/measure';
import { getAssetBlob, getAssetUrl } from '../../media/registry';
import { LIMITS } from '../../model/catalog';
import { audioLinked } from '../../model/project';
import { secToUs, sourceSpan, usToSec } from '../../model/time';
import type { AudioClip, AudioProps, FillChannel, VideoClip, VoiceFilterId, VoiceIsolationMode } from '../../model/types';
import { usePref } from '../../panels/prefs';
import { useEditor } from '../../store';
import { SegmentedTabs, Section, SliderRow } from '../controls';
import { fadeMax, formatDb } from '../inspectorLogic';

type Sub = 'basic' | 'voice';

/** Defaults of the Basic section (its Reset). */
const BASIC_RESET: Partial<AudioProps> = { volumeDb: 0, fadeIn: 0, fadeOut: 0 };

export function AudioTab({ clip }: { clip: VideoClip | AudioClip }) {
  const [sub, setSub] = usePref<Sub>('insp.audio.sub', 'basic');
  // a joined string keeps the selector's result stable between renders
  const extracted = useEditor((s) =>
    clip.type === 'video' && clip.audioLink && clip.audio.muted
      ? audioLinked(s.project, clip.audioLink)
          .filter((c) => c.type === 'audio')
          .map((c) => c.id)
          .join(',')
      : '',
  );
  if (extracted) return <ExtractedNotice clip={clip as VideoClip} audioIds={extracted.split(',')} />;
  return (
    <>
      <SegmentedTabs
        items={[
          { id: 'basic', label: 'Basic' },
          { id: 'voice', label: 'Voice changer' },
        ]}
        value={sub}
        onChange={setSub}
        label="Audio"
      />
      {sub === 'basic' ? <BasicPane clip={clip} /> : <VoicePane clip={clip} />}
    </>
  );
}

// ---------------------------------------------------------------- Basic

function BasicPane({ clip }: { clip: VideoClip | AudioClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const a = clip.audio;
  const set = (patch: Partial<AudioProps>) => updateClip(clip.id, { audio: patch });
  const sec = (us: number) => Math.round(usToSec(us) * 10) / 10;
  const maxIn = usToSec(fadeMax(clip.duration, a.fadeOut));
  const maxOut = usToSec(fadeMax(clip.duration, a.fadeIn));
  const basicDefault = a.volumeDb === 0 && a.fadeIn === 0 && a.fadeOut === 0;
  // the dropdown remembers the side even while the section is off
  const [fillSide, setFillSide] = useState<FillChannel>(a.fillChannel ?? 'left');
  useEffect(() => {
    if (a.fillChannel) setFillSide(a.fillChannel);
  }, [a.fillChannel]);

  return (
    <>
      <Section
        id="audio-basic"
        title="Basic"
        keyframe
        checked={!a.muted}
        onCheck={(on) => set({ muted: !on })}
        resetDisabled={basicDefault}
        onReset={() => set(BASIC_RESET)}
      >
        <SliderRow
          label="Volume"
          value={a.volumeDb}
          min={LIMITS.volumeDbMin}
          max={LIMITS.volumeDbMax}
          step={0.1}
          digits={1}
          unit="dB"
          format={formatDb}
          disabled={a.muted}
          onChange={(v) => set({ volumeDb: Math.round(v * 10) / 10 })}
          testId="volume-row"
        />
        <SliderRow
          label="Fade in"
          value={sec(a.fadeIn)}
          min={0}
          max={Math.max(0, Math.floor(maxIn * 10) / 10)}
          step={0.1}
          digits={1}
          unit="s"
          disabled={a.muted}
          onChange={(v) => set({ fadeIn: secToUs(v) })}
          testId="fade-in-row"
        />
        <SliderRow
          label="Fade out"
          value={sec(a.fadeOut)}
          min={0}
          max={Math.max(0, Math.floor(maxOut * 10) / 10)}
          step={0.1}
          digits={1}
          unit="s"
          disabled={a.muted}
          onChange={(v) => set({ fadeOut: secToUs(v) })}
          testId="fade-out-row"
        />
      </Section>

      <Section id="audio-normalize" title="Normalize loudness" checked={a.normalize} onCheck={(on) => set({ normalize: on })}>
        <p className="iaudio__desc">Normalize the loudness of the selected clip to a target level.</p>
        {a.normalize && <LoudnessReadout clip={clip} />}
      </Section>

      <AiRow id="enhance" title="Enhance voice" />
      {clip.type === 'video' && <AiRow id="translator" title="Video translator" />}

      <Section id="audio-noise" title="Reduce noise" note="DSP · not AI" checked={a.reduceNoise} onCheck={(on) => set({ reduceNoise: on })}>
        <p className="iaudio__desc">
          Removes rumble below 80 Hz and gates the background hiss in pauses (−30 dB). A signal-processing approximation, not AI
          noise removal.
        </p>
      </Section>

      <IsolateSection clip={clip} />

      <Section
        id="audio-fill"
        title="Fill channel"
        checked={a.fillChannel !== null}
        onCheck={(on) => set({ fillChannel: on ? fillSide : null })}
        resetDisabled={a.fillChannel === null}
        onReset={() => {
          setFillSide('left');
          set({ fillChannel: null });
        }}
        keyframe
      >
        <div className="frow">
          <span className="frow__label">Use</span>
          <div className="frow__ctl">
            <select
              value={fillSide}
              aria-label="Fill channel source"
              data-testid="fill-channel-select"
              onChange={(e) => {
                const side = e.target.value as FillChannel;
                setFillSide(side);
                set({ fillChannel: side });
              }}
            >
              <option value="left">Left channel</option>
              <option value="right">Right channel</option>
            </select>
          </div>
        </div>
        <p className="iaudio__desc">Copies the chosen channel to both speakers (for a mic recorded on one side only).</p>
      </Section>
    </>
  );
}

/** Isolate voice — DSP, not AI (src/audio/isolateCore.ts). Same field as the clip menu item. */
function IsolateSection({ clip }: { clip: VideoClip | AudioClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const vi = clip.audio.voiceIsolation ?? null;
  // the dropdown remembers the mode even while the section is off
  const [mode, setMode] = useState<VoiceIsolationMode>(vi?.mode ?? 'isolate');
  useEffect(() => {
    if (vi) setMode(vi.mode);
  }, [vi]);
  const set = (v: AudioProps['voiceIsolation']) => updateClip(clip.id, { audio: { voiceIsolation: v } });
  return (
    <Section
      id="audio-isolate"
      title="Isolate voice"
      note="DSP · not AI"
      checked={vi !== null}
      onCheck={(on) => set(on ? { mode, strength: DEFAULT_ISOLATION_STRENGTH } : null)}
      resetDisabled={!vi || vi.strength === DEFAULT_ISOLATION_STRENGTH}
      onReset={() => vi && set({ mode: vi.mode, strength: DEFAULT_ISOLATION_STRENGTH })}
    >
      <div className="frow">
        <span className="frow__label">Keep</span>
        <div className="frow__ctl">
          <select
            value={mode}
            aria-label="Voice isolation mode"
            data-testid="isolate-mode-select"
            disabled={!vi}
            onChange={(e) => {
              const m = e.target.value as VoiceIsolationMode;
              setMode(m);
              if (vi) set({ mode: m, strength: vi.strength });
            }}
          >
            <option value="isolate">Voice (isolate voice)</option>
            <option value="remove">Background (remove vocals, approx.)</option>
          </select>
        </div>
      </div>
      <SliderRow
        label="Strength"
        value={vi?.strength ?? DEFAULT_ISOLATION_STRENGTH}
        min={0}
        max={100}
        step={1}
        digits={0}
        keyframe={false}
        disabled={!vi}
        onChange={(v) => vi && set({ mode: vi.mode, strength: Math.round(v) })}
        testId="isolate-strength-row"
      />
      <p className="iaudio__desc">
        {mode === 'remove'
          ? 'Voice isolation (DSP): cuts the centre channel in the 150 Hz–6 kHz speech band. An approximation — stereo music keeps its sides; on mono it is a speech-band notch.'
          : 'Voice isolation (DSP): learns the noise from the quietest moments of the clip, subtracts it (Wiener filter), emphasises 100 Hz–8 kHz and gently gates the pauses. Signal processing, not AI.'}
      </p>
    </Section>
  );
}

/** Measured loudness and the gain normalize applies (preview and export use the same number). */
function LoudnessReadout({ clip }: { clip: VideoClip | AudioClip }) {
  const inSec = clip.inPoint / 1e6;
  const lenSec = sourceSpan(clip) / 1e6;
  const key = spanKey(clip.assetId, inSec, lenSec);
  const [, bump] = useState(0);
  useEffect(() => onLoudness(() => bump((n) => n + 1)), []);
  useEffect(() => {
    if (loudnessReady(key) !== undefined) return;
    void measureSpan(clip.assetId, inSec, lenSec, async (id) => {
      const b = getAssetBlob(id);
      if (b) return b;
      const url = getAssetUrl(id);
      return url ? (await fetch(url)).blob() : null;
    });
  }, [key, clip.assetId, inSec, lenSec]);
  const lufs = loudnessReady(key);
  const fmt = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
  return (
    <div className="iaudio__meter" data-testid="normalize-readout">
      <span>Target {fmt(NORMALIZE_TARGET_LUFS)} LUFS</span>
      <span>
        {lufs === undefined
          ? 'Measuring…'
          : lufs === null || !Number.isFinite(lufs)
            ? 'Silent — no change'
            : `Clip ${fmt(lufs)} LUFS → ${fmt(normalizeGainDb(lufs))} dB`}
      </span>
    </div>
  );
}

/** CapCut's AI rows, kept in place but disabled ("no AI features for now"). */
function AiRow({ id, title }: { id: string; title: string }) {
  return (
    <section className="isec is-off iaudio__ai" data-testid={`audio-ai-${id}`} title={`${title} uses AI — coming soon`}>
      <header className="isec__head">
        <input type="checkbox" className="checkbox" disabled checked={false} readOnly aria-label={`Enable ${title}`} />
        <span className="isec__title">{title}</span>
        <span className="iaudio__badge">AI · Coming soon</span>
      </header>
    </section>
  );
}

// ---------------------------------------------------------------- Voice changer

function VoicePane({ clip }: { clip: VideoClip | AudioClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const vf = clip.audio.voiceFilter;
  const pick = (id: VoiceFilterId | null) =>
    updateClip(clip.id, { audio: { voiceFilter: id ? { id, strength: vf?.id === id ? vf.strength : DEFAULT_VOICE_STRENGTH } : null } });
  return (
    <>
      <Section id="audio-voice-filters" title="Voice filters" note="DSP · not AI" resetDisabled={!vf} onReset={() => pick(null)}>
        <div className="iaudio__grid" role="listbox" aria-label="Voice filters">
          <button
            className={`iaudio__tile${!vf ? ' is-active' : ''}`}
            role="option"
            aria-selected={!vf}
            data-testid="voice-filter-none"
            onClick={() => pick(null)}
          >
            <span className="iaudio__tile-icon" aria-hidden>
              ∅
            </span>
            None
          </button>
          {VOICE_FILTERS.map((f) => (
            <button
              key={f.id}
              className={`iaudio__tile${vf?.id === f.id ? ' is-active' : ''}`}
              role="option"
              aria-selected={vf?.id === f.id}
              title={f.hint}
              data-testid={`voice-filter-${f.id}`}
              onClick={() => pick(f.id)}
            >
              <span className="iaudio__tile-icon" aria-hidden>
                {f.label.slice(0, 1)}
              </span>
              {f.label}
            </button>
          ))}
        </div>
        {vf && (
          <SliderRow
            label="Strength"
            value={vf.strength}
            min={0}
            max={100}
            step={1}
            digits={0}
            keyframe={false}
            onChange={(v) => updateClip(clip.id, { audio: { voiceFilter: { id: vf.id, strength: Math.round(v) } } })}
            testId="voice-strength-row"
          />
        )}
      </Section>
      <AiRow id="characters" title="Voice characters" />
      <AiRow id="speech-to-song" title="Speech to song" />
    </>
  );
}

// ---------------------------------------------------------------- extracted audio

function ExtractedNotice({ clip, audioIds }: { clip: VideoClip; audioIds: string[] }) {
  const select = useEditor((s) => s.select);
  const toggleExtractAudio = useEditor((s) => s.toggleExtractAudio);
  return (
    <div className="ipad iaudio__extracted" data-testid="audio-extracted">
      <p className="iaudio__desc">
        This clip&rsquo;s sound was extracted to its own audio clip, so the video plays silent. Edit the sound on the audio clip, or put it back.
      </p>
      <div className="imulti__actions">
        <button className="btn" onClick={() => select(audioIds)} data-testid="select-extracted-audio">
          Select audio
        </button>
        <button className="btn" onClick={() => toggleExtractAudio([clip.id])} data-testid="restore-audio">
          Restore audio
        </button>
      </div>
    </div>
  );
}
