/**
 * Clip right-click › "Voice isolation (DSP)" ›  (CapCut: "Isolate voice ›", AI there; here a
 * signal-processing approximation, labelled as such — see src/audio/isolateCore.ts).
 *
 *   Isolate voice                        → audio.voiceIsolation = { mode: 'isolate', strength }
 *   Remove vocals · keep background      → { mode: 'remove', strength }   (approximate)
 *   Off                                  → null
 *
 * Applies to every selected clip that has sound (video with audio, audio), as ONE undo step
 * (updateClips). An existing Strength is kept when the mode is unchanged; the inspector's
 * Audio › Basic › Voice isolation row edits it.
 */
import { DEFAULT_ISOLATION_STRENGTH } from '../audio/dsp';
import { findClip } from '../model/project';
import type { Clip, VoiceIsolationMode } from '../model/types';
import { useEditor } from '../store';
import { registerSlot } from '../timeline/contextMenu/registry';
import type { MenuCtx, MenuItem } from '../timeline/contextMenu/types';

type SoundClip = Extract<Clip, { type: 'video' | 'audio' }>;

/** The clips of the menu context that carry sound. */
export function soundClips(ctx: MenuCtx): SoundClip[] {
  const { project } = useEditor.getState();
  const out: SoundClip[] = [];
  for (const id of ctx.clipIds.length ? ctx.clipIds : [ctx.primaryId]) {
    const f = findClip(project, id);
    const c = f?.clip;
    if (!c || f.track.locked) continue;
    if (c.type === 'audio') out.push(c);
    else if (c.type === 'video' && project.assets[c.assetId]?.hasAudio !== false) out.push(c);
  }
  return out;
}

/** Sets (or clears, mode null) voice isolation on the context's clips — one undo step. */
export function applyVoiceIsolation(ctx: MenuCtx, mode: VoiceIsolationMode | null): void {
  const clips = soundClips(ctx);
  if (!clips.length) return;
  const st = useEditor.getState();
  if (mode === null) {
    st.updateClips(
      clips.map((c) => c.id),
      { audio: { voiceIsolation: null } },
    );
    return;
  }
  // keep a clip's own strength when its mode does not change (one patch per strength group)
  const groups = new Map<number, string[]>();
  for (const c of clips) {
    const cur = c.audio.voiceIsolation;
    const strength = cur && cur.mode === mode ? cur.strength : DEFAULT_ISOLATION_STRENGTH;
    groups.set(strength, [...(groups.get(strength) ?? []), c.id]);
  }
  const own = !st.txBase;
  if (own) st.beginTx();
  try {
    for (const [strength, ids] of groups) useEditor.getState().updateClips(ids, { audio: { voiceIsolation: { mode, strength } } });
  } finally {
    if (own) useEditor.getState().commitTx();
  }
}

const modeOf = (ctx: MenuCtx): VoiceIsolationMode | null | 'mixed' => {
  const modes = new Set(soundClips(ctx).map((c) => c.audio.voiceIsolation?.mode ?? null));
  return modes.size === 1 ? [...modes][0]! : 'mixed';
};

export const isolateVoiceMenuItem: MenuItem = {
  id: 'isolateVoice',
  label: 'Isolate voice', // CapCut's row label (contract); the inspector row says it is DSP, not AI
  icon: 'voice',
  tag: 'Free',
  disabled: (ctx) => soundClips(ctx).length === 0,
  submenu: (ctx) => {
    const m = modeOf(ctx);
    return [
      {
        id: 'isolateVoice.isolate',
        label: 'Isolate voice',
        icon: m === 'isolate' ? 'check' : undefined,
        run: (c) => applyVoiceIsolation(c, 'isolate'),
      },
      {
        id: 'isolateVoice.remove',
        label: 'Remove vocals · keep background (approx.)',
        icon: m === 'remove' ? 'check' : undefined,
        run: (c) => applyVoiceIsolation(c, 'remove'),
      },
      {
        id: 'isolateVoice.off',
        label: 'Off',
        icon: m === null ? 'check' : undefined,
        disabled: () => m === null,
        run: (c) => applyVoiceIsolation(c, null),
      },
    ];
  },
};

registerSlot('isolateVoice', isolateVoiceMenuItem);
