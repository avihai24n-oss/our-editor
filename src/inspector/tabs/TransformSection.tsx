/**
 * Transform (Video › Basic and Text): Scale + Uniform scale, Position X/Y, Rotate + dial,
 * align buttons, mirror. Plus the Blend section (mode + opacity) used by video/image/text.
 */
import { BLEND_MODES, LIMITS } from '../../model/catalog';
import { defaultTransform } from '../../model/defaults';
import type { BlendMode, MediaAsset, ProjectSettings, TextStyle, VisualClip } from '../../model/types';
import { useEditor } from '../../store';
import { Icon } from '../../ui/Icon';
import { FieldRow, KeyframeButton, NumberBox, Section, SliderRow, ToggleRow, fromPct, toPct } from '../controls';
import { ALIGN_ITEMS, AlignIcon } from '../controls/AlignIcons';
import { RotationDial } from '../controls/RotationDial';
import { alignPosition, displayedBox, normalizeAngle, uniformScalePatch, type AlignKind } from '../inspectorLogic';

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Approximate unscaled text box in project px (for the align buttons). */
function textBox(t: TextStyle): { width: number; height: number } {
  const lines = t.content.split('\n');
  if (measureCtx === undefined) measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  let w = 0;
  if (measureCtx) {
    measureCtx.font = `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : ''}${t.fontSize}px ${t.fontFamily}`;
    for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width + t.letterSpacing * l.length);
  } else {
    w = Math.max(...lines.map((l) => l.length)) * t.fontSize * 0.55;
  }
  const pad = t.background.enabled ? t.fontSize * 0.4 : 0;
  return { width: w + pad, height: lines.length * t.fontSize * t.lineHeight + pad };
}

function boxFor(clip: VisualClip, asset: MediaAsset | undefined, settings: ProjectSettings) {
  const canvas = { width: settings.width, height: settings.height };
  const tf = clip.transform;
  const s = tf.uniformScale === false ? { x: tf.scaleX, y: tf.scaleY } : tf.scale;
  if (clip.type === 'text') return displayedBox(textBox(clip.text), canvas, s, tf.rotation, false);
  const src = { width: asset?.width || canvas.width, height: asset?.height || canvas.height };
  return displayedBox(src, canvas, s, tf.rotation);
}

export function TransformSection({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const settings = useEditor((s) => s.project.settings);
  const asset = useEditor((s) => (clip.type === 'text' ? undefined : s.project.assets[clip.assetId]));
  const t = clip.transform;
  const set = (patch: Partial<typeof t>) => updateClip(clip.id, { transform: patch });
  const halfW = settings.width;
  const halfH = settings.height;
  const uniform = t.uniformScale !== false;
  const isDefault =
    t.scale === 1 && t.x === 0 && t.y === 0 && t.rotation === 0 && !t.flipH && !t.flipV && uniform && (t.scaleX ?? 1) === 1 && (t.scaleY ?? 1) === 1;

  const align = (kind: AlignKind) => {
    const box = boxFor(clip, asset, settings);
    set(alignPosition(kind, box, settings));
  };

  return (
    <Section
      id="transform"
      title="Transform"
      keyframe
      resetDisabled={isDefault}
      onReset={() => {
        const d = defaultTransform();
        set({ scale: d.scale, x: d.x, y: d.y, rotation: d.rotation, flipH: d.flipH, flipV: d.flipV, uniformScale: d.uniformScale, scaleX: d.scaleX, scaleY: d.scaleY });
      }}
    >
      {uniform ? (
        <SliderRow
          label="Scale"
          value={toPct(t.scale)}
          min={LIMITS.scaleMin * 100}
          max={LIMITS.scaleMax * 100}
          unit="%"
          onChange={(v) => set({ scale: Math.round(v) / 100 })}
          testId="scale-row"
        />
      ) : (
        <>
          <SliderRow
            label="Scale width"
            value={toPct(t.scaleX)}
            min={LIMITS.scaleMin * 100}
            max={LIMITS.scaleMax * 100}
            unit="%"
            onChange={(v) => set({ scaleX: Math.round(v) / 100 })}
            testId="scale-x-row"
          />
          <SliderRow
            label="Scale height"
            value={toPct(t.scaleY)}
            min={LIMITS.scaleMin * 100}
            max={LIMITS.scaleMax * 100}
            unit="%"
            onChange={(v) => set({ scaleY: Math.round(v) / 100 })}
            testId="scale-y-row"
          />
        </>
      )}
      <ToggleRow label="Uniform scale" on={uniform} onChange={(on) => set(uniformScalePatch(t, on))} />
      <div className="irow">
        <span className="irow__label">Position</span>
        <div className="irow__ctl">
          <NumberBox prefix="X" value={Math.round(t.x)} min={-halfW * 4} max={halfW * 4} label="Position X" onCommit={(x) => set({ x })} />
          <NumberBox prefix="Y" value={Math.round(t.y)} min={-halfH * 4} max={halfH * 4} label="Position Y" onCommit={(y) => set({ y })} />
        </div>
        <KeyframeButton />
      </div>
      <div className="irow">
        <span className="irow__label">Rotate</span>
        <div className="irow__ctl">
          <NumberBox value={t.rotation} digits={2} unit="°" step={1} min={-36000} max={36000} label="Rotate" onCommit={(r) => set({ rotation: normalizeAngle(r) })} />
          <RotationDial value={t.rotation} onChange={(rotation) => set({ rotation })} />
        </div>
        <KeyframeButton />
      </div>
      <div className="ialign">
        <div className="ialign__group" role="group" aria-label="Align">
          {ALIGN_ITEMS.map((a) => (
            <button key={a.kind} className="icon-btn" title={a.label} aria-label={a.label} onClick={() => align(a.kind)}>
              <AlignIcon kind={a.kind} />
            </button>
          ))}
        </div>
        <div className="ialign__group" role="group" aria-label="Mirror">
          <button className={`icon-btn${t.flipH ? ' is-active' : ''}`} title="Mirror horizontally" aria-pressed={t.flipH} onClick={() => set({ flipH: !t.flipH })}>
            <Icon name="mirror" size={16} />
          </button>
          <button
            className={`icon-btn${t.flipV ? ' is-active' : ''}`}
            title="Mirror vertically"
            aria-pressed={t.flipV}
            onClick={() => set({ flipV: !t.flipV })}
          >
            <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}>
              <Icon name="mirror" size={16} />
            </span>
          </button>
        </div>
      </div>
    </Section>
  );
}

export function BlendSection({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const isDefault = clip.blend === 'normal' && clip.transform.opacity === 1;
  return (
    <Section
      id="blend"
      title="Blend"
      keyframe
      checked={clip.blendEnabled !== false}
      onCheck={(on) => updateClip(clip.id, { blendEnabled: on })}
      resetDisabled={isDefault}
      onReset={() => updateClip(clip.id, { blend: 'normal', transform: { opacity: 1 } })}
    >
      <FieldRow label="Mode">
        <select value={clip.blend} aria-label="Blend mode" onChange={(e) => updateClip(clip.id, { blend: e.target.value as BlendMode })}>
          {BLEND_MODES.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </FieldRow>
      <SliderRow
        label="Opacity"
        value={toPct(clip.transform.opacity)}
        min={0}
        max={100}
        unit="%"
        onChange={(v) => updateClip(clip.id, { transform: { opacity: fromPct(v) } })}
        testId="opacity-row"
      />
    </Section>
  );
}
