/**
 * Animation tab, CapCut layout:
 *   sub-tabs  In | Out | Combo (video, image)   ·   In | Out | Loop (text)
 *   search box, category chips (★ favourites, Trending, Basic, Light, Glitch, Mask, 3D, Vibration)
 *   grid: None + tiles. A tile's thumbnail is drawn by the real compositor; hovering plays it,
 *   clicking applies it (one undo step) and previews it once in the player. ☆ adds a favourite.
 *   Duration slider for the applied animation (Loop: cycle length = speed).
 * The catalogue lives in src/engine/animations.ts.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ANIM_CATEGORIES, animationsFor, findAnimation, phasesFor, ANIM_LIMITS, type AnimCategory, type AnimDef } from '../../engine/animations';
import { secToUs, usToSec } from '../../model/time';
import type { AnimationSlot, ClipAnimation, VisualClip } from '../../model/types';
import { usePref } from '../../panels/prefs';
import { useEditor } from '../../store';
import { Icon } from '../../ui/Icon';
import { SegmentedTabs, SliderRow } from '../controls';
import { animationWindow, previewOnce } from './animPreview';
import { canDrawThumbs, drawAnimThumb, hoverProgress, idleProgress } from './animThumb';

const SLOT_LABEL: Record<AnimationSlot, string> = { in: 'In', out: 'Out', combo: 'Combo', loop: 'Loop' };
const slotValue = (clip: VisualClip, slot: AnimationSlot): ClipAnimation | null =>
  (slot === 'in' ? clip.animationIn : slot === 'out' ? clip.animationOut : slot === 'combo' ? clip.animationCombo : clip.animationLoop) ?? null;

type Chip = AnimCategory | 'favorites';
/** localStorage key (prefixed by prefs.ts): favourites as "phase:id" strings. */
export const FAV_KEY = 'animation-favorites';

// ---------------------------------------------------------------- thumbnail

const Thumb = memo(function Thumb({ def, kind, hovered }: { def: AnimDef; kind: 'media' | 'text'; hovered: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !canDrawThumbs()) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.max(16, Math.round((c.clientWidth || 72) * dpr));
    if (c.width !== px) c.width = c.height = px;
    if (!hovered) {
      drawAnimThumb(c, def, idleProgress(def), kind);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      drawAnimThumb(c, def, hoverProgress(def, performance.now() - t0), kind);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [def, kind, hovered]);
  return <canvas ref={ref} className="anim__canvas" aria-hidden="true" />;
});

function Tile(props: { def: AnimDef; kind: 'media' | 'text'; active: boolean; fav: boolean; onApply: () => void; onFav: () => void }) {
  const [hovered, setHovered] = useState(false);
  const { def, active, fav } = props;
  return (
    <div
      className={`anim${active ? ' is-active' : ''}${fav ? ' is-fav' : ''}`}
      data-testid="anim-tile"
      data-anim-id={def.id}
      data-active={active ? 'true' : 'false'}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button className="anim__hit" onClick={props.onApply} title={def.label} aria-pressed={active} aria-label={def.label}>
        <span className="anim__stage">
          <Thumb def={def} kind={props.kind} hovered={hovered} />
          {active && (
            <span className="anim__check" aria-hidden="true">
              ✓
            </span>
          )}
        </span>
        <span className="anim__label">{def.label}</span>
      </button>
      <button
        className={`anim__fav${fav ? ' is-on' : ''}`}
        onClick={props.onFav}
        aria-pressed={fav}
        aria-label={fav ? `Remove ${def.label} from favourites` : `Add ${def.label} to favourites`}
        title={fav ? 'Remove from favourites' : 'Add to favourites'}
        data-testid="anim-fav"
      >
        {fav ? '★' : '☆'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- tab

export function AnimationTab({ clip }: { clip: VisualClip }) {
  const animType = clip.type === 'compound' ? 'video' : clip.type; // a compound animates like a video clip
  const slots = phasesFor(animType);
  const [slotPref, setSlotPref] = usePref<string>('animation-slot', 'in');
  const slot: AnimationSlot = (slots as string[]).includes(slotPref) ? (slotPref as AnimationSlot) : 'in';
  const [chip, setChip] = useState<Chip>('trending');
  const [query, setQuery] = useState('');
  const [favs, setFavs] = usePref<string[]>(FAV_KEY, []);
  const setAnimation = useEditor((s) => s.setAnimation);
  const setAnimationDuration = useEditor((s) => s.setAnimationDuration);
  const kind = clip.type === 'text' ? 'text' : 'media';
  const current = slotValue(clip, slot);
  const currentDef = current ? findAnimation(slot, current.type) : undefined;

  const all = useMemo(() => animationsFor(slot, animType), [slot, animType]);
  const favSet = useMemo(() => new Set(Array.isArray(favs) ? favs : []), [favs]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return all.filter((d) => d.label.toLowerCase().includes(q) || d.id.includes(q));
    if (chip === 'favorites') return all.filter((d) => favSet.has(`${slot}:${d.id}`));
    return all.filter((d) => d.categories.includes(chip));
  }, [all, query, chip, favSet, slot]);

  const apply = (def: AnimDef | null) => {
    setAnimation(clip.id, slot, def ? def.id : null);
    if (!def) return;
    const fresh = useEditor
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clip.id);
    if (fresh && fresh.type !== 'audio') {
      const w = animationWindow(fresh, slot);
      previewOnce(w.start, w.end);
    }
  };
  const toggleFav = (def: AnimDef) => {
    const key = `${slot}:${def.id}`;
    const next = new Set(favSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFavs([...next]);
  };

  const clipSec = usToSec(clip.duration);
  const minSec = usToSec(ANIM_LIMITS.minUs);
  const isLoop = slot === 'loop';

  return (
    <div className="anim-tab" data-testid="animation-tab">
      <SegmentedTabs
        label="Animation type"
        items={slots.map((s) => ({ id: s, label: SLOT_LABEL[s], dot: !!slotValue(clip, s) }))}
        value={slot}
        onChange={(s) => setSlotPref(s)}
      />
      <div className="ipad">
        <div className="anim-search lib__search">
          <Icon name="search" size={14} />
          <input value={query} placeholder="Search animations" aria-label="Search animations" onChange={(e) => setQuery(e.target.value)} data-testid="anim-search" />
          {query && (
            <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
        <div className="anim-chips" role="tablist" aria-label="Animation categories">
          <button
            role="tab"
            className={`anim-chip anim-chip--fav${chip === 'favorites' && !query ? ' is-active' : ''}`}
            aria-selected={chip === 'favorites'}
            aria-label="Favourites"
            title="Favourites"
            onClick={() => setChip('favorites')}
          >
            ★
          </button>
          {ANIM_CATEGORIES.map((c) => (
            <button key={c.id} role="tab" className={`anim-chip${chip === c.id && !query ? ' is-active' : ''}`} aria-selected={chip === c.id} onClick={() => setChip(c.id)}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="anim-grid" data-testid="anim-grid">
          <div className={`anim${!current ? ' is-active' : ''}`} data-testid="anim-tile" data-anim-id="none" data-active={!current ? 'true' : 'false'}>
            <button className="anim__hit" onClick={() => apply(null)} aria-pressed={!current} aria-label="None" title="None">
              <span className="anim__stage">
                <span className="anim__none">⊘</span>
              </span>
              <span className="anim__label">None</span>
            </button>
          </div>
          {shown.map((d) => (
            <Tile key={d.id} def={d} kind={kind} active={current?.type === d.id} fav={favSet.has(`${slot}:${d.id}`)} onApply={() => apply(d)} onFav={() => toggleFav(d)} />
          ))}
        </div>
        {shown.length === 0 && (
          <div className="anim-empty">{chip === 'favorites' && !query ? 'No favourites yet. Click ☆ on an animation to add it.' : 'No animations match.'}</div>
        )}

        {current && (
          <div className="anim-applied">
            <div className="anim-applied__name" data-testid="anim-applied">
              {SLOT_LABEL[slot]}: <strong>{currentDef?.label ?? current.type}</strong>
            </div>
            <SliderRow
              label={isLoop ? 'Speed' : 'Duration'}
              aside={isLoop ? <span className="anim-hint">one cycle · shorter = faster</span> : undefined}
              value={Math.round(usToSec(current.duration) * 10) / 10}
              min={isLoop ? usToSec(ANIM_LIMITS.loopMinUs) : Math.min(minSec, clipSec)}
              max={isLoop ? usToSec(ANIM_LIMITS.loopMaxUs) : Math.max(minSec, Math.floor(clipSec * 10) / 10)}
              step={0.1}
              digits={1}
              unit="s"
              keyframe={false}
              onChange={(v) => setAnimationDuration(clip.id, slot, secToUs(v))}
              testId="animation-duration"
            />
          </div>
        )}
      </div>
    </div>
  );
}
