/**
 * Text › Basic: content, font, size, colour, B/I/U, alignment, character & line spacing;
 * Stroke / Background / Shadow sections (checkbox = enabled); then Transform + Blend.
 * Typing in the content box is one undo step per focus (session opened on focus, closed on blur).
 */
import { FONTS } from '../../model/catalog';
import { defaultTextStyle } from '../../model/defaults';
import type { ClipPatch, TextAlign, TextClip } from '../../model/types';
import { useEditor } from '../../store';
import { ColorInput, FieldRow, SegmentedTabs, Section, SliderRow, beginSession, endSession, fromPct, toPct } from '../controls';
import { BlendSection, TransformSection } from './TransformSection';

type TextPatch = NonNullable<ClipPatch['text']>;

export function TextTab({ clip }: { clip: TextClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const t = clip.text;
  const d = defaultTextStyle();
  const set = (patch: TextPatch) => updateClip(clip.id, { text: patch });
  const fonts = FONTS.includes(t.fontFamily) ? FONTS : [t.fontFamily, ...FONTS];

  return (
    <>
      <SegmentedTabs
        items={[
          { id: 'basic', label: 'Basic' },
          { id: 'templates', label: 'Templates', disabled: true },
        ]}
        value="basic"
        onChange={() => undefined}
      />
      <Section
        id="text-basic"
        title="Basic"
        resetDisabled={
          t.fontFamily === d.fontFamily && t.fontSize === d.fontSize && t.color === d.color && !t.bold && !t.italic && !t.underline && t.align === d.align && t.letterSpacing === d.letterSpacing && t.lineHeight === d.lineHeight
        }
        onReset={() =>
          set({
            fontFamily: d.fontFamily,
            fontSize: d.fontSize,
            color: d.color,
            bold: d.bold,
            italic: d.italic,
            underline: d.underline,
            align: d.align,
            letterSpacing: d.letterSpacing,
            lineHeight: d.lineHeight,
          })
        }
      >
        <textarea
          className="itext"
          rows={3}
          value={t.content}
          aria-label="Text content"
          data-testid="text-content"
          placeholder="Enter text"
          onFocus={() => beginSession()}
          onBlur={() => endSession()}
          onChange={(e) => set({ content: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <FieldRow label="Font">
          <select value={t.fontFamily} aria-label="Font" onChange={(e) => set({ fontFamily: e.target.value })} style={{ fontFamily: t.fontFamily }}>
            {fonts.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f === 'system-ui' ? 'System' : f}
              </option>
            ))}
          </select>
        </FieldRow>
        <SliderRow label="Font size" value={t.fontSize} min={8} max={400} onChange={(v) => set({ fontSize: Math.round(v) })} keyframe={false} />
        <FieldRow label="Color">
          <ColorInput label="Text color" value={t.color} onChange={(color) => set({ color })} />
        </FieldRow>
        <FieldRow label="Style">
          <div className="istyle">
            <button className={`istyle__b${t.bold ? ' is-active' : ''}`} aria-pressed={t.bold} title="Bold" onClick={() => set({ bold: !t.bold })}>
              B
            </button>
            <button className={`istyle__i${t.italic ? ' is-active' : ''}`} aria-pressed={t.italic} title="Italic" onClick={() => set({ italic: !t.italic })}>
              I
            </button>
            <button className={`istyle__u${t.underline ? ' is-active' : ''}`} aria-pressed={t.underline} title="Underline" onClick={() => set({ underline: !t.underline })}>
              U
            </button>
          </div>
        </FieldRow>
        <FieldRow label="Alignment">
          <SegmentedTabs<TextAlign>
            label="Alignment"
            items={[
              { id: 'left', label: 'Left' },
              { id: 'center', label: 'Center' },
              { id: 'right', label: 'Right' },
            ]}
            value={t.align}
            onChange={(align) => set({ align })}
          />
        </FieldRow>
        <SliderRow label="Character" value={t.letterSpacing} min={-20} max={100} onChange={(v) => set({ letterSpacing: Math.round(v) })} keyframe={false} />
        <SliderRow
          label="Line"
          value={Math.round(t.lineHeight * 100) / 100}
          min={0.5}
          max={3}
          step={0.05}
          digits={2}
          unit="x"
          onChange={(v) => set({ lineHeight: Math.round(v * 100) / 100 })}
          keyframe={false}
        />
      </Section>

      <Section id="text-stroke" title="Stroke" checked={t.stroke.enabled} onCheck={(enabled) => set({ stroke: { enabled } })} onReset={() => set({ stroke: { ...d.stroke, enabled: t.stroke.enabled } })}>
        <FieldRow label="Color" disabled={!t.stroke.enabled}>
          <ColorInput label="Stroke color" value={t.stroke.color} disabled={!t.stroke.enabled} onChange={(color) => set({ stroke: { color } })} />
        </FieldRow>
        <SliderRow label="Width" value={t.stroke.width} min={0} max={40} disabled={!t.stroke.enabled} onChange={(v) => set({ stroke: { width: Math.round(v) } })} keyframe={false} />
      </Section>

      <Section
        id="text-background"
        title="Background"
        checked={t.background.enabled}
        onCheck={(enabled) => set({ background: { enabled } })}
        onReset={() => set({ background: { ...d.background, enabled: t.background.enabled } })}
      >
        <FieldRow label="Color" disabled={!t.background.enabled}>
          <ColorInput label="Background color" value={t.background.color} disabled={!t.background.enabled} onChange={(color) => set({ background: { color } })} />
        </FieldRow>
        <SliderRow
          label="Opacity"
          value={toPct(t.background.opacity)}
          min={0}
          max={100}
          unit="%"
          disabled={!t.background.enabled}
          onChange={(v) => set({ background: { opacity: fromPct(v) } })}
          keyframe={false}
        />
      </Section>

      <Section id="text-shadow" title="Shadow" checked={t.shadow.enabled} onCheck={(enabled) => set({ shadow: { enabled } })} onReset={() => set({ shadow: { ...d.shadow, enabled: t.shadow.enabled } })}>
        <FieldRow label="Color" disabled={!t.shadow.enabled}>
          <ColorInput label="Shadow color" value={t.shadow.color} disabled={!t.shadow.enabled} onChange={(color) => set({ shadow: { color } })} />
        </FieldRow>
        <SliderRow label="Blur" value={t.shadow.blur} min={0} max={60} disabled={!t.shadow.enabled} onChange={(v) => set({ shadow: { blur: Math.round(v) } })} keyframe={false} />
        <SliderRow label="Offset X" value={t.shadow.offsetX} min={-50} max={50} fillFrom={0} disabled={!t.shadow.enabled} onChange={(v) => set({ shadow: { offsetX: Math.round(v) } })} keyframe={false} />
        <SliderRow label="Offset Y" value={t.shadow.offsetY} min={-50} max={50} fillFrom={0} disabled={!t.shadow.enabled} onChange={(v) => set({ shadow: { offsetY: Math.round(v) } })} keyframe={false} />
      </Section>

      <TransformSection clip={clip} />
      <BlendSection clip={clip} />
    </>
  );
}
