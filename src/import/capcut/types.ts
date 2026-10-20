/**
 * The parts of CapCut desktop's draft schema (`draft_info.json`, a.k.a. `draft_content.json`)
 * that the importer reads. Every field is optional: CapCut adds fields between versions and
 * omits empty ones, so the converter treats each value as "maybe there".
 *
 * Units: every time is integer MICROSECONDS (same as our model). Transform x / y are normalised
 * to HALF the canvas (x = 1 → the clip centre on the right edge), y grows UP. Volume is linear.
 */

export interface CcTimerange {
  start?: number;
  duration?: number;
}

export interface CcClip {
  scale?: { x?: number; y?: number };
  rotation?: number;
  transform?: { x?: number; y?: number };
  flip?: { vertical?: boolean; horizontal?: boolean };
  alpha?: number;
}

export interface CcKeyframe {
  time_offset?: number;
  values?: number[];
}

export interface CcCommonKeyframes {
  property_type?: string;
  keyframe_list?: CcKeyframe[];
}

export interface CcSegment {
  id: string;
  material_id: string;
  target_timerange?: CcTimerange;
  source_timerange?: CcTimerange | null;
  speed?: number;
  reverse?: boolean;
  volume?: number;
  visible?: boolean;
  clip?: CcClip | null;
  uniform_scale?: { on?: boolean; value?: number } | null;
  extra_material_refs?: string[];
  keyframe_refs?: string[];
  common_keyframes?: CcCommonKeyframes[];
  is_tone_modify?: boolean;
  render_index?: number;
  enable_adjust?: boolean;
  enable_lut?: boolean;
}

export interface CcTrack {
  id: string;
  /** 'video' | 'audio' | 'text' | 'sticker' | 'effect' | 'filter' | 'adjust' … */
  type: string;
  /** Bit flags. Observed: 1 = muted, 2 = hidden, 4 = locked (see convert.ts). */
  attribute?: number;
  flag?: number;
  name?: string;
  segments: CcSegment[];
}

export interface CcVideoMaterial {
  id: string;
  /** 'video' | 'photo'. A compound clip is a 'video' with an empty path and a `drafts` ref. */
  type?: string;
  path?: string;
  material_name?: string;
  duration?: number;
  width?: number;
  height?: number;
  has_audio?: boolean;
  /** The video's own sound was separated into audio segments ("Extract audio"). */
  has_sound_separated?: boolean;
  crop?: {
    upper_left_x?: number;
    upper_left_y?: number;
    lower_right_x?: number;
    lower_right_y?: number;
  };
}

export interface CcAudioMaterial {
  id: string;
  /** 'extract_music' | 'video_original_sound' | 'music' | 'record' | 'sound' … */
  type?: string;
  name?: string;
  path?: string;
  duration?: number;
}

export interface CcSpeed {
  id: string;
  /** 0 = standard, 1 = curve. */
  mode?: number;
  speed?: number;
  curve_speed?: { id?: string; name?: string; speed_points?: { x: number; y: number }[] } | null;
}

export interface CcCanvas {
  id: string;
  /** 'canvas_color' | 'canvas_blur' | 'canvas_image'. */
  type?: string;
  color?: string;
  blur?: number;
  image?: string;
  image_name?: string;
}

export interface CcAudioFade {
  id: string;
  fade_in_duration?: number;
  fade_out_duration?: number;
}

export interface CcAnimation {
  /** 'in' | 'out' | 'group' (combo) | 'loop'. */
  type?: string;
  name?: string;
  resource_id?: string;
  id?: string;
  start?: number;
  duration?: number;
  category_name?: string;
}

export interface CcMaterialAnimation {
  id: string;
  animations?: CcAnimation[];
}

export interface CcTransition {
  id: string;
  name?: string;
  duration?: number;
  effect_id?: string;
  is_overlap?: boolean;
}

export interface CcSoundChannelMapping {
  id: string;
  /** 0 = none. Observed meaning of 1 / 2: left / right channel to both. */
  audio_channel_mapping?: number;
}

export interface CcVocalSeparation {
  id: string;
  /** 0 = off, 1 = isolate voice, 2 = remove voice (keep the background). */
  choice?: number;
  final_algorithm?: string;
}

export interface CcLoudness {
  id: string;
  enable?: boolean;
  target_loudness?: number;
}

export interface CcEffect {
  id: string;
  type?: string;
  name?: string;
  value?: number;
  path?: string;
  effect_id?: string;
  resource_id?: string;
  category_name?: string;
}

export interface CcMask {
  id: string;
  name?: string;
  resource_type?: string;
  config?: {
    centerX?: number;
    centerY?: number;
    width?: number;
    height?: number;
    rotation?: number;
    feather?: number;
    roundCorner?: number;
    invert?: boolean;
  };
}

export interface CcText {
  id: string;
  type?: string;
  /** Rich text: a JSON string `{ text, styles: [...] }` (newer drafts) or plain text. */
  content?: string;
  base_content?: string;
  font_size?: number;
  text_color?: string;
  border_color?: string;
  border_width?: number;
  background_color?: string;
  background_alpha?: number;
  alignment?: number;
  font_path?: string;
  font_title?: string;
  bold_width?: number;
  italic_degree?: number;
  underline?: boolean;
  letter_spacing?: number;
  line_spacing?: number;
}

export interface CcDraftMaterial {
  id: string;
  type?: string;
  name?: string;
  draft?: CcDraft;
  draft_file_path?: string;
}

export interface CcTimeMark {
  id?: string;
  time_range?: CcTimerange;
  color?: string;
  title?: string;
}

export interface CcBeats {
  id: string;
  enable_ai_beats?: boolean;
  user_beats?: number[];
  ai_beats?: { beats_path?: string } | null;
}

export interface CcMaterials {
  videos?: CcVideoMaterial[];
  audios?: CcAudioMaterial[];
  texts?: CcText[];
  speeds?: CcSpeed[];
  canvases?: CcCanvas[];
  audio_fades?: CcAudioFade[];
  material_animations?: CcMaterialAnimation[];
  transitions?: CcTransition[];
  sound_channel_mappings?: CcSoundChannelMapping[];
  vocal_separations?: CcVocalSeparation[];
  loudnesses?: CcLoudness[];
  masks?: CcMask[];
  common_mask?: CcMask[];
  effects?: CcEffect[];
  video_effects?: CcEffect[];
  filters?: CcEffect[];
  stickers?: { id: string; name?: string }[];
  drafts?: CcDraftMaterial[];
  beats?: CcBeats[];
  time_marks?: { id: string; mark_items?: CcTimeMark[] }[];
  [key: string]: unknown;
}

export interface CcDraft {
  id?: string;
  name?: string;
  duration?: number;
  fps?: number;
  canvas_config?: { width?: number; height?: number; ratio?: string; background?: unknown };
  config?: { maintrack_adsorb?: boolean; video_mute?: boolean };
  tracks?: CcTrack[];
  materials?: CcMaterials;
  keyframes?: Record<string, unknown[]>;
  time_marks?: { mark_items?: CcTimeMark[] } | null;
}
