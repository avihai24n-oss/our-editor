/**
 * Video tab (video and image clips), CapCut desktop layout: sub-tabs Basic | Remove BG | Mask.
 *
 *  Basic     — Transform (scale + Uniform scale, position, rotate, align, mirror), Blend (mode +
 *              opacity), Canvas (main track: Color / Blur / Image background, Apply to all), then
 *              CapCut's AI sections shown disabled ("Coming soon"): Stabilize, Enhance quality,
 *              Reduce image noise, Optical flow, AI remove, AI expand, Retouch.
 *  Remove BG — Auto removal / Custom removal (AI, disabled) and Chroma key (colour, Intensity, Shadow).
 *  Mask      — None, Linear, Mirror, Circle, Rectangle, Heart, Star; position, rotate, size, feather,
 *              round corners (rectangle), invert. The player shows on-canvas handles meanwhile.
 *
 * Every control is a store action (undoable, saved with the project) and is drawn by the shared
 * compositor (src/engine/render), so the preview and the export match.
 */
import { useEffect } from 'react';
import { CANVAS_BLUR_PX, CANVAS_COLORS, MASK_SHAPES } from '../../model/catalog';
import { defaultCanvasBackground, defaultChroma, defaultMask } from '../../model/defaults';
import type { CanvasBackgroundType, ImageClip, MaskShape, VideoClip } from '../../model/types';
import { findClip } from '../../model/project';
import { usePref } from '../../panels/prefs';
import { useMaskEdit } from '../../player/maskEdit';
import { useEditor } from '../../store';
import { ColorInput, FieldRow, KeyframeButton, NumberBox, SegmentedTabs, Section, SliderRow } from '../controls';
import { RotationDial } from '../controls/RotationDial';
import { maskForShape, normalizeAngle, pictureBox } from '../inspectorLogic';
import { BlendSection, TransformSection } from './TransformSection';

type MediaClip = VideoClip | ImageClip;
type Sub = 'basic' | 'removebg' | 'mask';

export function VideoTab({ clip }: { clip: MediaClip }) {
  const [sub, setSub] = usePref<Sub>('insp.video.sub', 'basic');
  return (
    <>
      <SegmentedTabs<Sub>
        label="Video"
        items={[
          { id: 'basic', label: 'Basic' },
          { id: 'removebg', label: 'Remove BG' },
          { id: 'mask', label: 'Mask' },
        ]}
        value={sub}
        onChange={setSub}
      />
      {sub === 'basic' && <BasicPanel clip={clip} />}
      {sub === 'removebg' && <RemoveBgPanel clip={clip} />}
      {sub === 'mask' && <MaskPanel clip={clip} />}
    </>
  );
}

// ---------------------------------------------------------------- AI placeholders

/** A CapCut AI feature, laid out like its section but switched off: "AI · Coming soon". */
function AiSection(props: { id: string; title: string; dropdown?: boolean }) {
  return (
    <section className="isec is-ai" data-testid={`section-${props.id}`} title={`${props.title} uses AI — coming soon`}>
      <header className="isec__head">
        <input type="checkbox" className="checkbox" checked={false} disabled aria-label={`Enable ${props.title}`} onChange={() => undefined} />
        <span className="isec__title is-static">
          {props.title}
          <span className="ai-badge">AI</span>
        </span>
        <span className="isec__spacer" />
        <span className="isec__soon">Coming soon</span>
      </header>
    </section>
  );
}

// ---------------------------------------------------------------- Basic

function BasicPanel({ clip }: { clip: MediaClip }) {
  const onMain = useEditor((s) => findClip(s.project, clip.id)?.track.kind === 'main');
  return (
    <>
      <TransformSection clip={clip} />
      <BlendSection clip={clip} />
      {onMain && <CanvasSection clip={clip} />}
      {clip.type === 'video' && <AiSection id="stabilize" title="Stabilize" />}
      <AiSection id="enhance" title="Enhance quality" />
      <AiSection id="denoise" title="Reduce image noise" />
      {clip.type === 'video' && <AiSection id="opticalflow" title="Optical flow" />}
      <AiSection id="airemove" title="AI remove" />
      <AiSection id="aiexpand" title="AI expand" />
      <AiSection id="retouch" title="Retouch" />
    </>
  );
}

const CANVAS_TYPES: { id: Exclude<CanvasBackgroundType, 'none'>; label: string }[] = [
  { id: 'color', label: 'Color' },
  { id: 'blur', label: 'Blur' },
  { id: 'image', label: 'Image' },
];

function CanvasSection({ clip }: { clip: MediaClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const updateClips = useEditor((s) => s.updateClips);
  const assets = useEditor((s) => s.project.assets);
  const images = Object.values(assets).filter((a) => a.kind === 'image' && !a.missing);
  const bg = clip.canvas;
  const on = bg.type !== 'none';
  const set = (patch: Partial<MediaClip['canvas']>) => updateClip(clip.id, { canvas: patch });
  const d = defaultCanvasBackground();
  const isDefault = bg.type === d.type && bg.color === d.color && bg.blur === d.blur && bg.assetId === d.assetId;

  const applyAll = () => {
    const p = useEditor.getState().project;
    const ids = p.tracks
      .filter((t) => t.kind === 'main' && !t.locked)
      .flatMap((t) => t.clips)
      .filter((c) => c.type === 'video' || c.type === 'image')
      .map((c) => c.id);
    if (ids.length) updateClips(ids, { canvas: { ...bg } });
  };

  return (
    <Section
      id="canvas"
      title="Canvas"
      checked={on}
      onCheck={(v) => set({ type: v ? 'blur' : 'none' })}
      resetDisabled={isDefault}
      onReset={() => set(d)}
    >
      <FieldRow label="Type">
        <select aria-label="Canvas type" value={on ? bg.type : ''} onChange={(e) => set({ type: (e.target.value || 'none') as CanvasBackgroundType })}>
          <option value="">None</option>
          {CANVAS_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </FieldRow>
      {bg.type === 'color' && (
        <>
          <div className="iswatches" role="group" aria-label="Canvas colours">
            {CANVAS_COLORS.map((c) => (
              <button
                key={c}
                className={`iswatch${bg.color.toLowerCase() === c ? ' is-active' : ''}`}
                style={{ background: c }}
                title={c}
                aria-label={`Canvas colour ${c}`}
                aria-pressed={bg.color.toLowerCase() === c}
                onClick={() => set({ color: c })}
              />
            ))}
          </div>
          <FieldRow label="Color">
            <ColorInput value={bg.color} label="Canvas colour" onChange={(color) => set({ color })} />
          </FieldRow>
        </>
      )}
      {bg.type === 'blur' && (
        <div className="iblur" role="group" aria-label="Blur level">
          {CANVAS_BLUR_PX.map((px, i) => (
            <button
              key={px}
              className={`iblur__tile${bg.blur === i + 1 ? ' is-active' : ''}`}
              aria-pressed={bg.blur === i + 1}
              aria-label={`Blur ${i + 1}`}
              title={`Blur ${i + 1}`}
              onClick={() => set({ blur: i + 1 })}
            >
              <span className="iblur__img" style={{ filter: `blur(${(i + 1) * 1.5}px)` }} />
            </button>
          ))}
        </div>
      )}
      {bg.type === 'image' && (
        <FieldRow label="Image">
          {images.length ? (
            <select aria-label="Canvas image" value={bg.assetId ?? ''} onChange={(e) => set({ assetId: e.target.value || null })}>
              <option value="">Choose an image…</option>
              {images.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="inote">Import an image in Media first</span>
          )}
        </FieldRow>
      )}
      <div className="ifoot ifoot--inline">
        <span className="ifoot__spacer" />
        <button className="btn" onClick={applyAll} title="Use this canvas for every clip on the main track">
          Apply to all
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Remove BG

function RemoveBgPanel({ clip }: { clip: MediaClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const k = clip.chroma;
  const set = (patch: Partial<MediaClip['chroma']>) => updateClip(clip.id, { chroma: patch });
  const d = defaultChroma();
  const isDefault = k.color === d.color && k.intensity === d.intensity && k.shadow === d.shadow;
  const eyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;

  const pick = async () => {
    try {
      const Ctor = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const r = await new Ctor().open();
      if (r?.sRGBHex) updateClip(clip.id, { chroma: { color: r.sRGBHex.toLowerCase(), enabled: true } });
    } catch {
      /* cancelled */
    }
  };

  return (
    <>
      <AiSection id="autoremoval" title="Auto removal" />
      <AiSection id="customremoval" title="Custom removal" />
      <Section
        id="chroma"
        title="Chroma key"
        checked={k.enabled}
        onCheck={(on) => set({ enabled: on })}
        resetDisabled={isDefault}
        onReset={() => set({ color: d.color, intensity: d.intensity, shadow: d.shadow })}
      >
        <FieldRow label="Color picker">
          <div className="ichroma">
            <ColorInput value={k.color} label="Key colour" onChange={(color) => set({ color, enabled: true })} />
            {eyeDropper && (
              <button className="btn" onClick={pick} title="Pick the key colour from the screen (click the green screen in the player)">
                Pick
              </button>
            )}
          </div>
        </FieldRow>
        <SliderRow label="Intensity" value={k.intensity} min={0} max={100} keyframe={false} onChange={(v) => set({ intensity: Math.round(v) })} testId="chroma-intensity" />
        <SliderRow label="Shadow" value={k.shadow} min={0} max={100} keyframe={false} onChange={(v) => set({ shadow: Math.round(v) })} testId="chroma-shadow" />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Mask

function MaskIcon({ shape }: { shape: MaskShape }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 };
  switch (shape) {
    case 'none':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <circle cx="12" cy="12" r="8" {...common} />
          <path d="M6.5 17.5 17.5 6.5" {...common} />
        </svg>
      );
    case 'linear':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <rect x="3" y="4" width="18" height="16" rx="2" {...common} />
          <path d="M3 12h18" {...common} />
          <rect x="3" y="4" width="18" height="8" fill="currentColor" opacity="0.35" />
        </svg>
      );
    case 'mirror':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <rect x="3" y="4" width="18" height="16" rx="2" {...common} />
          <rect x="3" y="9" width="18" height="6" fill="currentColor" opacity="0.35" />
          <path d="M3 9h18M3 15h18" {...common} />
        </svg>
      );
    case 'circle':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <circle cx="12" cy="12" r="8" {...common} fill="currentColor" fillOpacity="0.35" />
        </svg>
      );
    case 'rectangle':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <rect x="4" y="6" width="16" height="12" rx="1.5" {...common} fill="currentColor" fillOpacity="0.35" />
        </svg>
      );
    case 'heart':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" {...common} fill="currentColor" fillOpacity="0.35" />
        </svg>
      );
    case 'star':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" {...common} fill="currentColor" fillOpacity="0.35" />
        </svg>
      );
  }
}

function MaskPanel({ clip }: { clip: MediaClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const settings = useEditor((s) => s.project.settings);
  const asset = useEditor((s) => s.project.assets[clip.assetId]);
  const setEditing = useMaskEdit((s) => s.setActive);
  useEffect(() => {
    setEditing(true);
    return () => setEditing(false);
  }, [setEditing]);

  const m = clip.mask;
  const box = pictureBox(asset, settings, clip.crop);
  const set = (patch: Partial<MediaClip['mask']>) => updateClip(clip.id, { mask: patch });
  const choose = (shape: MaskShape) => set(maskForShape(shape, m, box));
  const d = defaultMask();
  const fresh = maskForShape(m.shape, d, box);
  const isDefault =
    m.x === 0 && m.y === 0 && m.rotation === 0 && m.feather === 0 && !m.invert && m.width === fresh.width && m.height === fresh.height && (m.shape !== 'rectangle' || m.roundCorners === 0);
  const px = (v: number, size: number) => Math.round(v * size);

  return (
    <>
      <div className="ipad">
        <div className="imask-grid" role="group" aria-label="Mask shape">
          {MASK_SHAPES.map((s) => (
            <button
              key={s.id}
              className={`imask${m.shape === s.id ? ' is-active' : ''}`}
              aria-pressed={m.shape === s.id}
              title={s.label}
              data-testid={`mask-${s.id}`}
              onClick={() => choose(s.id)}
            >
              <span className="imask__icon">
                <MaskIcon shape={s.id} />
              </span>
              <span className="imask__label">{s.label}</span>
            </button>
          ))}
        </div>
      </div>
      {m.shape !== 'none' && (
        <Section id="mask" title="Mask" keyframe resetDisabled={isDefault} onReset={() => set({ ...maskForShape(m.shape, d, box), feather: 0, invert: false, roundCorners: 0 })}>
          <div className="irow">
            <span className="irow__label">Invert</span>
            <div className="irow__ctl">
              <button className={`btn imask-invert${m.invert ? ' is-active' : ''}`} aria-pressed={m.invert} aria-label="Invert mask" onClick={() => set({ invert: !m.invert })}>
                Invert
              </button>
            </div>
          </div>
          <div className="irow">
            <span className="irow__label">Position</span>
            <div className="irow__ctl">
              <NumberBox prefix="X" value={px(m.x, box.w)} label="Mask position X" onCommit={(x) => set({ x: box.w ? x / box.w : 0 })} />
              <NumberBox prefix="Y" value={px(m.y, box.h)} label="Mask position Y" onCommit={(y) => set({ y: box.h ? y / box.h : 0 })} />
            </div>
            <KeyframeButton />
          </div>
          <div className="irow">
            <span className="irow__label">Rotate</span>
            <div className="irow__ctl">
              <NumberBox value={m.rotation} digits={2} unit="°" min={-36000} max={36000} label="Mask rotate" onCommit={(r) => set({ rotation: normalizeAngle(r) })} />
              <RotationDial value={m.rotation} onChange={(rotation) => set({ rotation })} />
            </div>
            <KeyframeButton />
          </div>
          {m.shape !== 'linear' && (
            <div className="irow">
              <span className="irow__label">Size</span>
              <div className="irow__ctl">
                {m.shape !== 'mirror' && (
                  <NumberBox prefix="W" value={px(m.width, box.w)} min={1} max={Math.round(box.w * 20)} label="Mask width" onCommit={(w) => set({ width: box.w ? w / box.w : 0.5 })} />
                )}
                <NumberBox prefix="H" value={px(m.height, box.h)} min={1} max={Math.round(box.h * 20)} label="Mask height" onCommit={(h) => set({ height: box.h ? h / box.h : 0.5 })} />
              </div>
              <KeyframeButton />
            </div>
          )}
          <SliderRow label="Feather" value={m.feather} min={0} max={100} onChange={(v) => set({ feather: Math.round(v) })} testId="mask-feather" />
          {m.shape === 'rectangle' && (
            <SliderRow label="Round corners" value={m.roundCorners} min={0} max={100} onChange={(v) => set({ roundCorners: Math.round(v) })} testId="mask-round" />
          )}
        </Section>
      )}
    </>
  );
}
