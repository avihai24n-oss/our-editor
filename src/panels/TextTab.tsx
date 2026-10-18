/**
 * Text tab: "Default text" + basic styled presets. Click / "+" adds a 3 s text clip at the
 * playhead on a text track (one undo step); tiles are draggable to the timeline ({kind:'text'}).
 */
import type { CSSProperties } from 'react';
import { defaultTextStyle } from '../model/defaults';
import { useEditor } from '../store';
import { GridLabel, LibraryBody, PresetTile, type SidebarItem } from './LibraryLayout';
import { setDragPayload } from './libraryLogic';
import { TEXT_PRESETS, type TextPreset } from './presets';
import { usePref } from './prefs';

const SIDEBAR: SidebarItem[] = [
  { id: 'add', label: 'Add text' },
  { id: 'templates', label: 'Text templates', disabled: true },
  { id: 'effects', label: 'Text effects', disabled: true },
];

/** Library-tile rendering of a preset (scaled down; colours/stroke/shadow kept). */
export function presetPreviewStyle(p: TextPreset): CSSProperties {
  const base = defaultTextStyle(p.content);
  const s = { ...base, ...p.style, stroke: { ...base.stroke, ...p.style.stroke }, background: { ...base.background, ...p.style.background }, shadow: { ...base.shadow, ...p.style.shadow } };
  const k = 0.2; // project px → tile px
  const css: CSSProperties = {
    fontFamily: s.fontFamily,
    fontSize: Math.max(10, Math.min(24, s.fontSize * k)),
    color: s.color,
    fontWeight: s.bold ? 700 : 400,
    fontStyle: s.italic ? 'italic' : 'normal',
    textDecoration: s.underline ? 'underline' : 'none',
    letterSpacing: s.letterSpacing * k,
    whiteSpace: 'nowrap',
    padding: s.background.enabled ? '1px 5px' : 0,
    borderRadius: 2,
  };
  if (s.stroke.enabled) css.WebkitTextStroke = `${Math.max(0.6, s.stroke.width * k * 0.5)}px ${s.stroke.color}`;
  if (s.background.enabled) {
    const hex = s.background.color.replace('#', '');
    const n = parseInt(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex, 16) || 0;
    css.background = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${s.background.opacity})`;
  }
  if (s.shadow.enabled) css.textShadow = `${s.shadow.offsetX * k}px ${s.shadow.offsetY * k}px ${s.shadow.blur * k}px ${s.shadow.color}`;
  return css;
}

/**
 * Adds a preset as ONE undo step. `at` defaults to the playhead; `trackId` targets a text track.
 * The timeline can call this for a dropped {kind:'text', preset} payload.
 */
export function addTextPreset(p: TextPreset, opts: { at?: number; trackId?: string } = {}): string {
  const st = useEditor.getState();
  st.beginTx();
  const id = st.addTextClip({ content: p.content, at: opts.at, trackId: opts.trackId });
  if (Object.keys(p.style).length) useEditor.getState().updateClip(id, { text: p.style });
  useEditor.getState().commitTx();
  return id;
}

export function TextTab() {
  const [cat, setCat] = usePref('lib.text.cat', 'add');
  return (
    <LibraryBody sidebar={SIDEBAR} value={cat} onChange={setCat}>
      <div className="lib__scroll">
        <GridLabel>Add text</GridLabel>
        <div className="lib-grid">
          {TEXT_PRESETS.map((p) => (
            <PresetTile
              key={p.id}
              label={p.label}
              title={`${p.label} — click to add at the playhead, or drag to the timeline`}
              testId="text-preset"
              preview={
                <div className="ptile__text">
                  <span style={presetPreviewStyle(p)}>{p.id === 'default' ? 'Default text' : p.content}</span>
                </div>
              }
              onApply={() => addTextPreset(p)}
              onDragStart={(e) => setDragPayload(e.dataTransfer, { kind: 'text', preset: p.id })}
            />
          ))}
        </div>
      </div>
    </LibraryBody>
  );
}
