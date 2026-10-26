/**
 * Audio tab (CapCut desktop): sub-tabs Basic | Voice changer.
 *
 * Basic, in CapCut's order: Basic (volume dB, fade in, fade out — checkbox = clip sound on),
 * Normalize loudness (−23 LUFS), Enhance voice (AI, coming soon), Video translator (AI, video
 * clips only, coming soon), Reduce noise (DSP gate, not AI), Isolate voice (AI, coming soon),
 * Fill channel (left / right to both).
 * Voice changer: Voice filters (non-AI DSP, with Strength) grouped as Spaces / Eras & devices /
 * Character / Pitch & effects; Mixer (a channel strip: cuts, EQ, compressor, warmth, delay,
 * reverb, output — with starting presets); Voice characters and Speech to song (AI, coming soon).
 *
 * Every control writes through updateClip (undoable; slider drags are one step) and is saved
 * with the project. A video clip whose sound was extracted shows the link instead of controls.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_ISOLATION_STRENGTH, DEFAULT_MIXER, DEFAULT_VOICE_STRENGTH, MIXER_PRESETS, VOICE_FILTER_GROUPS, VOICE_FILTERS } from '../../audio/dsp';
import { NORMALIZE_TARGET_LUFS, normalizeGainDb } from '../../audio/loudness';
import { loudnessReady, measureSpan, onLoudness, spanKey } from '../../audio/measure';
import { getAssetBlob, getAssetUrl } from '../../media/registry';
import { LIMITS } from '../../model/catalog';
import { audioLinked } from '../../model/project';
import { clipVolumeDbAt, hasVolumeKeys, keyIndexAt, keyTimes, shiftKeys, withKeyAt, withoutKeyAt } from '../../model/volumeKeys';
import { secToUs, sourceSpan, usToSec } from '../../model/time';
import type { AudioClip, AudioProps, FillChannel, VideoClip, VoiceFilterId, VoiceIsolationMode, VoiceMixer } from '../../model/types';
import { usePref } from '../../panels/prefs';
import { useEditor } from '../../store';
import { KeyframeNav, SegmentedTabs, Section, SliderRow } from '../controls';
import { fadeMax, formatDb } from '../inspectorLogic';

type Sub = 'basic' | 'voice';

/** Defaults of the Basic section (its Reset). */
const BASIC_RESET: Partial<AudioProps> = { volumeDb: 0, volumeKeys: undefined, fadeIn: 0, fadeOut: 0 };

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

/**
 * Volume with keyframes (src/model/volumeKeys.ts). Without keys the slider edits volumeDb. With
 * keys it shows the envelope at the playhead; moving it sets the key at the playhead (adding one,
 * CapCut-style), or — with the playhead off the clip — moves every key by the same amount.
 */
function useVolumeKeyframes(clip: VideoClip | AudioClip) {
  const updateClip = useEditor((s) => s.updateClip);
  const playhead = useEditor((s) => s.playhead);
  const fps = useEditor((s) => s.project.settings.fps);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const a = clip.audio;
  const keyed = hasVolumeKeys(a);
  const tol = 1e6 / fps / 2;
  const inside = playhead >= clip.start && playhead < clip.start + clip.duration;
  const at = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, playhead));
  const db = keyed ? Math.round(clipVolumeDbAt(clip, at) * 10) / 10 : a.volumeDb;
  const on = keyed && inside && keyIndexAt(clip, playhead, tol) >= 0;
  const times = keyed ? keyTimes(clip) : [];
  const prev = [...times].reverse().find((t) => t < playhead - tol);
  const next = times.find((t) => t > playhead + tol);
  const setAudio = (patch: Partial<AudioProps>) => updateClip(clip.id, { audio: patch });

  const setDb = (v: number) => {
    const r = Math.round(v * 10) / 10;
    if (!keyed) setAudio({ volumeDb: r });
    else if (inside) setAudio({ volumeKeys: withKeyAt(clip, playhead, r, tol) });
    else setAudio({ volumeKeys: shiftKeys(a.volumeKeys!, r - db) });
  };
  const onToggle = () => {
    if (!inside) return;
    if (on) {
      const rest = withoutKeyAt(clip, playhead, tol);
      // the last key goes: the clip keeps the level it had there
      setAudio(rest ? { volumeKeys: rest } : { volumeKeys: undefined, volumeDb: db });
    } else setAudio({ volumeKeys: withKeyAt(clip, playhead, db, tol) });
  };
  return {
    db,
    setDb,
    nav: {
      on,
      any: keyed,
      disabled: !inside,
      onToggle,
      onPrev: prev !== undefined ? () => setPlayhead(Math.round(prev)) : null,
      onNext: next !== undefined ? () => setPlayhead(Math.round(next)) : null,
    },
  };
}

function BasicPane({ clip }: { clip: VideoClip | AudioClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const a = clip.audio;
  const set = (patch: Partial<AudioProps>) => updateClip(clip.id, { audio: patch });
  const sec = (us: number) => Math.round(usToSec(us) * 10) / 10;
  const maxIn = usToSec(fadeMax(clip.duration, a.fadeOut));
  const maxOut = usToSec(fadeMax(clip.duration, a.fadeIn));
  const basicDefault = a.volumeDb === 0 && !hasVolumeKeys(a) && a.fadeIn === 0 && a.fadeOut === 0;
  const vol = useVolumeKeyframes(clip);
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
          value={vol.db}
          min={LIMITS.volumeDbMin}
          max={LIMITS.volumeDbMax}
          step={0.1}
          digits={1}
          unit="dB"
          format={formatDb}
          disabled={a.muted}
          onChange={vol.setDb}
          keyframeSlot={<KeyframeNav {...vol.nav} testId="volume-keyframe" />}
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
        <button
          className={`iaudio__tile iaudio__tile--none${!vf ? ' is-active' : ''}`}
          aria-pressed={!vf}
          data-testid="voice-filter-none"
          onClick={() => pick(null)}
        >
          None
        </button>
        {VOICE_FILTER_GROUPS.map((g) => (
          <div key={g.id} className="iaudio__group">
            <div className="iaudio__group-title">{g.label}</div>
            <div className="iaudio__grid" role="listbox" aria-label={g.label}>
              {VOICE_FILTERS.filter((f) => f.group === g.id).map((f) => (
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
          </div>
        ))}
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
      <MixerPane clip={clip} />
      <AiRow id="characters" title="Voice characters" />
      <AiRow id="speech-to-song" title="Speech to song" />
    </>
  );
}

// ---------------------------------------------------------------- Mixer

/** Voice changer › Mixer: a channel strip on the clip (after the voice filter). */
function MixerPane({ clip }: { clip: VideoClip | AudioClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const m: VoiceMixer = clip.audio.mixer ?? DEFAULT_MIXER;
  const active = !!clip.audio.mixer;
  const put = (next: VoiceMixer | null) => updateClip(clip.id, { audio: { mixer: next } });
  const set = <K extends keyof VoiceMixer>(k: K, v: VoiceMixer[K]) => put({ ...m, [k]: v });
  const sub = <K extends 'eq' | 'comp' | 'warmth' | 'delay' | 'reverb'>(k: K, patch: Partial<VoiceMixer[K]>) => put({ ...m, [k]: { ...m[k], ...patch } });
  const row = (label: string, value: number, min: number, max: number, onChange: (v: number) => void, o: { step?: number; digits?: number; unit?: string; testId?: string; format?: (v: number) => string } = {}) => (
    <SliderRow label={label} value={value} min={min} max={max} step={o.step ?? 1} digits={o.digits ?? 0} unit={o.unit} format={o.format} keyframe={false} onChange={onChange} testId={o.testId} />
  );
  const hz = (v: number) => (v <= 0 ? 'Off' : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}kHz` : `${Math.round(v)}Hz`);
  const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`;

  return (
    <>
      <Section id="audio-mixer" title="Mixer" note="Channel strip" checked={active} onCheck={(on) => put(on ? { ...DEFAULT_MIXER } : null)} resetDisabled={!active} onReset={() => put(null)}>
        <div className="iaudio__presets" data-testid="mixer-presets">
          {MIXER_PRESETS.map((p) => (
            <button key={p.id} className="btn iaudio__preset" title={p.hint} onClick={() => put(structuredClone(p.mixer))} data-testid={`mixer-preset-${p.id}`}>
              {p.label}
            </button>
          ))}
        </div>
        {active && (
          <>
            {row('Low cut', m.lowCut, 0, 500, (v) => set('lowCut', Math.round(v)), { step: 5, format: hz, testId: 'mixer-lowcut' })}
            {row('High cut', m.highCut > 0 ? m.highCut : 20000, 2000, 20000, (v) => set('highCut', v >= 20000 ? 0 : Math.round(v)), { step: 100, format: (v) => (v >= 20000 ? 'Off' : hz(v)), testId: 'mixer-highcut' })}
            {row('Output', m.output, -12, 12, (v) => set('output', Math.round(v * 10) / 10), { step: 0.1, digits: 1, format: db, testId: 'mixer-output' })}
          </>
        )}
      </Section>
      {active && (
        <>
          <Section id="audio-mixer-eq" title="EQ" checked={m.eq.on} onCheck={(on) => sub('eq', { on })} resetDisabled={false} onReset={() => sub('eq', DEFAULT_MIXER.eq)}>
            {row('Low freq', m.eq.lowFreq, 40, 500, (v) => sub('eq', { lowFreq: Math.round(v) }), { step: 5, format: hz })}
            {row('Low gain', m.eq.lowGain, -12, 12, (v) => sub('eq', { lowGain: Math.round(v * 10) / 10 }), { step: 0.1, digits: 1, format: db, testId: 'mixer-eq-low' })}
            {row('Mid freq', m.eq.midFreq, 150, 8000, (v) => sub('eq', { midFreq: Math.round(v) }), { step: 10, format: hz })}
            {row('Mid gain', m.eq.midGain, -12, 12, (v) => sub('eq', { midGain: Math.round(v * 10) / 10 }), { step: 0.1, digits: 1, format: db })}
            {row('Mid width (Q)', m.eq.midQ, 0.3, 6, (v) => sub('eq', { midQ: Math.round(v * 10) / 10 }), { step: 0.1, digits: 1 })}
            {row('High freq', m.eq.highFreq, 2000, 16000, (v) => sub('eq', { highFreq: Math.round(v) }), { step: 100, format: hz })}
            {row('High gain', m.eq.highGain, -12, 12, (v) => sub('eq', { highGain: Math.round(v * 10) / 10 }), { step: 0.1, digits: 1, format: db })}
          </Section>
          <Section id="audio-mixer-comp" title="Compressor" checked={m.comp.on} onCheck={(on) => sub('comp', { on })} resetDisabled={false} onReset={() => sub('comp', DEFAULT_MIXER.comp)}>
            {row('Threshold', m.comp.threshold, -50, 0, (v) => sub('comp', { threshold: Math.round(v) }), { unit: 'dB', testId: 'mixer-comp-threshold' })}
            {row('Ratio', m.comp.ratio, 1, 20, (v) => sub('comp', { ratio: Math.round(v * 10) / 10 }), { step: 0.1, digits: 1, format: (v) => `${v.toFixed(1)}:1` })}
            {row('Attack', m.comp.attack, 0, 100, (v) => sub('comp', { attack: Math.round(v) }), { unit: 'ms' })}
            {row('Release', m.comp.release, 20, 1000, (v) => sub('comp', { release: Math.round(v) }), { step: 5, unit: 'ms' })}
            {row('Makeup', m.comp.makeup, 0, 18, (v) => sub('comp', { makeup: Math.round(v * 10) / 10 }), { step: 0.1, digits: 1, format: db })}
          </Section>
          <Section id="audio-mixer-warmth" title="Warmth" note="Saturation" checked={m.warmth.on} onCheck={(on) => sub('warmth', { on })} resetDisabled={false} onReset={() => sub('warmth', DEFAULT_MIXER.warmth)}>
            {row('Drive', m.warmth.drive, 0, 100, (v) => sub('warmth', { drive: Math.round(v) }), { unit: '%' })}
            {row('Mix', m.warmth.mix, 0, 100, (v) => sub('warmth', { mix: Math.round(v) }), { unit: '%' })}
          </Section>
          <Section id="audio-mixer-delay" title="Delay" checked={m.delay.on} onCheck={(on) => sub('delay', { on })} resetDisabled={false} onReset={() => sub('delay', DEFAULT_MIXER.delay)}>
            {row('Time', m.delay.time, 20, 1500, (v) => sub('delay', { time: Math.round(v) }), { step: 5, unit: 'ms' })}
            {row('Feedback', m.delay.feedback, 0, 90, (v) => sub('delay', { feedback: Math.round(v) }), { unit: '%' })}
            {row('Mix', m.delay.mix, 0, 100, (v) => sub('delay', { mix: Math.round(v) }), { unit: '%' })}
          </Section>
          <Section id="audio-mixer-reverb" title="Reverb" checked={m.reverb.on} onCheck={(on) => sub('reverb', { on })} resetDisabled={false} onReset={() => sub('reverb', DEFAULT_MIXER.reverb)}>
            {row('Decay', m.reverb.decay, 0.1, 8, (v) => sub('reverb', { decay: Math.round(v * 10) / 10 }), { step: 0.1, digits: 1, unit: 's', testId: 'mixer-reverb-decay' })}
            {row('Pre-delay', m.reverb.predelay, 0, 150, (v) => sub('reverb', { predelay: Math.round(v) }), { unit: 'ms' })}
            {row('Damping', m.reverb.damping, 0, 100, (v) => sub('reverb', { damping: Math.round(v) }), { unit: '%' })}
            {row('Mix', m.reverb.mix, 0, 100, (v) => sub('reverb', { mix: Math.round(v) }), { unit: '%' })}
          </Section>
        </>
      )}
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
