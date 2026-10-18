# 01 — CapCut Desktop: Structure and UI/UX Research

Purpose: the reference for building "Our Editor" v1 (basics only, no AI). It records how CapCut desktop is laid out, what each control does, and **where it lives**, so we can copy the structure now and slot later features into the same places.

Sources:
- The user's screenshots in `docs/capcut-screens/01..09` (primary source, current CapCut desktop build, Mac, dark theme, 3840x2160).
- CapCut official article "How to use CapCut" (capcut.com/resource/how-to-use-capcut): panel list, right-panel tabs, export window.
- Third-party guides: fastshortcuts.com/shortcuts/capcut (shortcut table, checked Sep 2026), Wondershare Filmora "capcut timeline" (toolbar + timeline settings), primalvideo.com CapCut PC/Mac tutorial (layout, ripple keys, project settings), tourboxtech (freeze frame).
- Where no source documents a behaviour, it comes from the screenshots and long-standing CapCut desktop behaviour. Those items are marked **[inferred]**. Treat them as design decisions we copy, not documented facts.

Legend: **v1** = build in the first version; **later** = leave a slot (disabled or hidden) but do not build; **AI** = out of scope permanently for now (do not render at all).

---

## 0. Global layout (screenshot 01)

```
┌───────────────────────────── Top bar (≈36px) ──────────────────────────────────┐
│ Auto saved: 19:48:07          <project name, centred>     [layout][shortcuts] [Share][Export] │
├──────────── Left: Library ─────────┬──── Centre: Player ────┬── Right: Inspector ──┤
│ Tab bar (icons + labels, ≈56px)    │ "Player-Timeline 01" ≡ │ Tabs (change w/ sel) │
│ ┌ Category ┐┌ Item grid ─────────┐ │                        │                      │
│ │ sidebar  ││ toolbar: Import,   │ │   canvas (letterboxed) │ collapsible sections │
│ │ ≈120px   ││ Record, search,    │ │                        │                      │
│ │          ││ view/sort/filter   │ │ timecode   ▶   Full ⌖ Ratio ⛶ │ [Apply to all]  │
├────────────┴┴────────────────────┴─┴────────────────────────┴──────────────────────┤
│ Timeline toolbar (≈36px): + | select▾ | undo redo | split dL dR del | marker crop …   … mic magnet snap link axis | – zoom + │
│ Ruler (timecode)                                                                       │
│ Track headers (≈130px) │ tracks: overlays above, MAIN video track (with Cover), audio below │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Measured proportions from screenshot 01 (2000px-wide render):

| Region | Approx size | Notes |
|---|---|---|
| Top bar | ~36px tall | Window chrome + project title + Export |
| Upper half (library / player / inspector) | ~62% of height | Separated from timeline by a draggable horizontal splitter |
| Left library | ~28% width (≈565/2000) | Tab bar on top, category sidebar + grid below |
| Player | ~45% width | Header "Player-Timeline 01" + hamburger menu |
| Inspector | ~25% width | Fixed min width; content scrolls |
| Timeline | ~38% of height, full width | |

All three upper panels sit in rounded dark cards (radius ~8px) with ~4–6px gutters between them on a near-black window background. Every splitter (library|player, player|inspector, upper|timeline) is draggable **[inferred, standard CapCut]**. The top-bar "layout" icon (two-pane icon with ▾) switches layout presets (default / vertical-video-focused) — primalvideo confirms a vertical, video-focused layout exists. **v1:** fixed default layout with draggable splitters; layout presets **later**.

### Theme (from screenshots)
| Token | Value (approx) | Used for |
|---|---|---|
| `--bg-window` | `#121212` | window background, gutters |
| `--bg-panel` | `#1e1e1e`–`#232323` | panel cards, inspector |
| `--bg-input` | `#141414` | numeric fields, dropdowns |
| `--bg-raised` | `#2c2c2c` | segmented control active pill, buttons |
| `--text` | `#e6e6e6` | primary text |
| `--text-dim` | `#8a8a8a` | labels, disabled |
| `--accent` | `#22c1d6` (CapCut cyan/teal) | active tab, checkboxes, toggles, selection outline, playhead, primary button (Export, Save as preset) |
| `--clip-video` | dark teal `#1d5a5e` | video clip body on timeline |
| `--clip-audio` | blue `#1f4f9a` with lighter waveform | audio clips |
| `--pro` | purple diamond `#8b6cff` | Pro badge (we do not need) |

Font: system UI sans (SF Pro on Mac), 12–13px body, 14px tab labels.

---

## 1. Top bar (screenshot 01, top row)

| Element | Where it lives | What it does | v1? |
|---|---|---|---|
| "Auto saved: HH:MM:SS" | top-left | Status of the auto-save; updates on every change | **v1** (we autosave to IndexedDB) |
| Project name ("shabat") | centred | Click to rename **[inferred]** | **v1** |
| Layout switch (icon ▾) | top-right | Layout presets | later |
| Shortcuts / keyboard icon | top-right | Opens keyboard shortcut panel (fastshortcuts: "icon in the top toolbar of an open project") | **v1** (read-only list modal) |
| Pro | top-right | Subscription | no |
| Share | top-right | Upload to TikTok/YouTube | no |
| Export (cyan primary button) | top-right, far right | Opens export dialog: name, folder, resolution (up to 4K), frame rate (up to 60), format MP4/MOV, codec, bit rate, optional audio-only export (MP3/WAV/FLAC), cover edit (capcut.com) | **v1** (simple: resolution, fps, MP4/WebM via browser) |

Also: project settings ("Modify" in Details tab of the right panel when nothing selected) hold name, aspect ratio, resolution, frame rate; "Original/Adapted" ratio auto-matches the first clip (primalvideo).

---

## 2. Left panel — the Library (screenshots 01, 09)

### 2.1 Tab bar (screenshot 09)
Horizontal row of icon-over-label tabs, active one in cyan with filled icon. Order:

`Media · Audio · Text · Stickers · Effects · Transitions · Captions · Filters · Adjustment · Templates` and a `›` chevron that scrolls the bar when the panel is narrow.

| Tab | Content | v1? |
|---|---|---|
| Media | Imported files (Import / Record), Subprojects, Library (stock) | **v1** (Import only) |
| Audio | Music, Sound effects, Extracted audio, imported audio | **v1** (imported + extracted only; no stock) |
| Text | "Default text" add, text presets/templates, effects | **v1** (Default text only) |
| Stickers | Sticker grid | later |
| Effects | Video effects (Trending, Nature, Spark, Lens, Retro, Distortion…) + Body effects | later |
| Transitions | Grid (MG, Blur, Split, Slide, Mask…) | **v1-lite** (3–4 CSS/WebGL transitions: Mix/Dissolve, Fade to black, Slide, Wipe) — optional |
| Captions | Manual captions / auto captions (AI) | later (manual), AI no |
| Filters | Colour filter grid (Mono, Retro, Style, Food, Night scene) | **v1-lite** (a handful of CSS-filter presets) — optional |
| Adjustment | Adds an *adjustment layer* clip to the timeline | later |
| Templates | Full templates | no |

### 2.2 Common panel anatomy (every tab uses the same skeleton)
1. **Category sidebar** (left column, ~120px): vertical list of pill buttons. Active = lighter pill with cyan text (`Import`, `Media`). Groups with children have a ▾ chevron and expand in place (`Yours ▾`, `Spaces ▾`, `Library ▾`). In Media: `Import ▴` (expanded) › `Media`, `Subprojects`; then `Yours`, `Generate` (AI), `Spaces`, `Library`, `Dreamina` (AI).
2. **Panel toolbar** (top of the grid): primary actions on the left (`⊕ Import` in a filled button, `Record`), tools on the right: search 🔍, grid/list view toggle, sort ▾, filter ▾.
3. **Section label** ("All") then the **item grid**: 3 columns at default width, square-ish 16:10 thumbnails, filename under each (middle-ellipsised: `shabbat-ca...-en-t1.mp3`).
   - Duration badge top-right (`00:10`).
   - "Added" badge top-left when the asset is already used on the timeline.
   - Audio files render as a blue waveform thumbnail.
   - Missing source shows a red tile "Media lost".
4. **Bottom strip** (Media tab only): AI clipper promo — AI, skip.

For library tabs with downloadable content (Stickers, Effects, Transitions, Filters, Animation, screenshot 06):
- Search field at top with a placeholder suggestion ("People are searching …").
- **Horizontal category chips**: `★` (favourites), `Trending`, `Basic`, `Light`, `Glitch`, `Mask`, `3D`… scrolling horizontally.
- Grid tiles with: preview thumbnail; ☆ favourite button (bottom-left overlay) and ⤓ download button (bottom-right overlay) when not yet downloaded; purple diamond top-left = Pro.
- **Hover** plays an animated preview of the effect on the tile **[inferred, standard]**.
- After download the ⤓ becomes a **cyan `+`** "Add to track" button on hover **[inferred, standard]**.
- First tile is always **None** (⊘), which clears the applied item.
- Selected/applied tile has a cyan 2px outline.

### 2.3 Adding to the timeline (all tabs)
- **Drag** a tile onto the timeline: drop on an existing track or in empty space above/below to create a new track; a drop indicator line/ghost shows the target.
- **Drag onto the player** canvas also adds (media) **[inferred]**.
- **`+` button** on the tile adds at the **playhead** on the appropriate track (media → main track if empty, else overlay/insert per magnet; audio → new audio track; text/sticker → new track above at playhead) **[inferred, standard]**.
- Transitions are dropped **on the cut between two clips** on the same track; Filters/Effects can be dropped onto a clip (applies to that clip) or added as their own clip on a track (applies to everything below for its duration).
- Import: button, `Ctrl/Cmd+I`, or drag files from the OS into the panel or directly onto the timeline (capcut.com).

**v1:** Media tab with Import (file picker + OS drag-drop), grid with thumbnail/duration/"Added", hover scrub preview optional, `+` and drag to timeline. Text tab with "Default text" tile.

---

## 3. Centre — Player (screenshot 01)

| Element | Where it lives | Behaviour | v1? |
|---|---|---|---|
| Title "Player-Timeline 01" | player header, left | Name of the timeline being shown | **v1** ("Player") |
| ≡ menu | player header, right | Player options (preview quality, show safe area, etc.) **[inferred]** | later |
| Canvas | centre | Project frame letterboxed in a dark area; black where nothing is on screen | **v1** |
| Current timecode `00:00:00:00` (cyan) / total `00:06:36:00` | bottom-left | Format `HH:MM:SS:FF` (frames) | **v1** |
| Small grid icon right of timecode | bottom-left | Toggles the timecode display mode **[inferred]** | later |
| ▶ Play/Pause | bottom-centre | Space key | **v1** |
| `Full` | bottom-right | Preview quality ("Full" vs lower) **[inferred]** — not fit | later (we always render at canvas size) |
| ⌖ (crop-square) | bottom-right | Zoom/fit preview (fit to window `Alt/Opt+Shift+Z`) | **v1** fit only |
| `Ratio` | bottom-right | Aspect ratio menu: Original, 16:9, 4:3, 2.35:1, 2:1, 1.85:1, 9:16, 3:4, 5.8", 1:1 … | **v1**: 9:16 (default), 16:9, 1:1, 4:5 |
| ⛶ Fullscreen | bottom-right, far right | Fullscreen preview (`Ctrl+Shift+F` / `Cmd+Ctrl+F`, Esc exits) | **v1** |

### 3.1 On-canvas interaction **[inferred, standard CapCut behaviour]**
- Clicking a visible element on the canvas selects the topmost clip under the cursor (and selects it on the timeline).
- Selected video/image/text/sticker shows a **white bounding box** with 4 corner handles (uniform scale), a **rotate handle** (circular arrow) below/above the box; text also has side handles to change box width.
- Drag inside the box moves it (writes Position X/Y in the inspector).
- **Alignment guides**: dashed cyan/pink lines appear when the element's centre/edge aligns with the canvas centre or edges; it snaps. Holding `Ctrl/Cmd` ignores guides (fastshortcuts).
- Text: double-click on canvas edits the text inline.
- `Alt/Option+drag` resizes a text box from centre.
- Mouse wheel over the canvas does **not** scale clips **[inferred]**.

**v1:** select-by-click, move, corner scale, rotate handle, centre snapping guides.

---

## 4. Right — Inspector (screenshots 02–07)

When **nothing is selected**: tabs `Project` / `Details` (screenshot 01). Project shows AI "Smart suggestions"/"Global edits" — **AI, skip**. **Details** shows project name, path, ratio, resolution, frame rate, imported media count, with a `Modify` button. **v1:** show a "Project" panel with name, ratio, resolution, fps.

When a clip is selected, the tab row changes with the clip type:

| Selected type | Top tabs (left → right) |
|---|---|
| Video / image (screenshot 02) | `Video · Audio · Speed · Animation · Adjust · AI stylize` (Audio only if the clip has audio; Speed hidden for images) |
| Audio | `Basic(Audio) · Voice changer · Speed` |
| Text | `Text · Animation · Tracking · Text-to-speech` |
| Sticker | `Sticker · Animation` |
| Transition | single panel: duration slider + "Apply to all" |
| Effect / filter clip | parameters of that effect |

Active tab = cyan text. Under the main tabs there is a **segmented control** of sub-tabs (dark track, raised grey active pill): e.g. Video → `Basic | Remove BG | Mask`; Speed → `Standard | Curve | Velocity effects`; Adjust → `Basic | HSL | Curves | Color wheel | Mask`.

### 4.1 Section anatomy (repeats everywhere)
Each section is a full-width row separated by a 1px divider:
- **Checkbox** (cyan when on) — enables/disables the whole section without losing values (Blend, LUT, Adjust, Audio Basic). Sections with no checkbox (Transform) are always on.
- **Title** + **▴/▾ caret** to collapse/expand.
- Right side: **↺ reset** (resets the section to defaults), then the **keyframe cluster `‹ ◇ ›`** — previous keyframe, add/remove keyframe at playhead (diamond fills when a keyframe exists at the playhead), next keyframe.
- Inside, each property row: label on top/left, **slider** filling width, **numeric field** (dark input, unit suffix: `100%`, `0.0dB`, `0.0s`, `0.00°`, `1.00x`) with a **stepper ⇕**, then that property's own `‹ ◇ ›` keyframe cluster.
- Toggles (Uniform scale, Change audio pitch, Protect skin tone) are cyan pill switches on the right.
- Disabled rows are dimmed (LUT intensity when Name = None).
- Bottom of panel: `Apply to all` (secondary grey button) applies the current section values to every clip of that type; `Save as preset` (cyan, Adjust only); `Reset` (Speed).

### 4.2 Video › Basic (screenshot 02) — **v1**
- **Transform** (no checkbox): `Scale` slider + `%` field (default 100%); `Uniform scale` toggle (on = single Scale; off = Scale X / Scale Y); `Position` X / Y numeric fields (pixels relative to centre, 0,0 = centre); `Rotate` field (degrees, 2 decimals) + a small rotation dial; **align button row**: align left, centre horizontally, align right, align top, centre vertically, align bottom (then two disabled distribute buttons).
- **Blend** (checkbox): Mode dropdown (Normal, Darken, Screen, Overlay, Multiply, Lighten, …) + Opacity 0–100% — **v1: Opacity only** (blend mode optional, CSS `mix-blend-mode`).
- Stabilize, Enhance quality, Reduce image noise, Optical flow, AI remove, AI expand — AI/Pro: **do not render**.

### 4.3 Audio › Basic (screenshot 03) — **v1**
- **Basic** (checkbox): `Volume` slider in dB (default `0.0dB`, range ≈ −∞/−60 … +20 dB); `Fade in` 0.0s; `Fade out` 0.0s (max = half the clip length) — all keyframeable.
- Normalize loudness, Enhance voice, Video translator, Reduce noise, Isolate voice — AI/Pro: skip. `Fill channel` (left/right channel copy) — later.

### 4.4 Speed (screenshots 04, 05)
- **Standard** — **v1**: `Speed` slider with tick marks (log scale 0.1x … 100x; ticks at 0.1, 1, 2, 5, 10, 100 **[inferred]**), field `1.00x` with stepper; `Duration` row shows original → new duration (`2.3s` dashed arrow `2.3s`) and an editable duration field; `Change audio pitch` toggle (off = pitch-preserved); `Smooth slow-mo` (AI) skip; `Reset` button bottom-right. Changing speed changes the clip's timeline length; with magnet on, later clips ripple.
- **Curve** — later: presets grid `None, Custom, Montage, Hero, Bullet, Jump cut, Flash in, Flash out` (yellow curve icons), then a graph editor 0.1x–10x with draggable beat points, Reset.
- **Velocity effects** — no.

### 4.5 Animation (screenshot 06) — later
Sub-tabs `In | Out | Combo`; library grid identical to §2.2 (search, chips Trending/Basic/Light/Glitch/Mask/3D…, None tile first). After choosing, a `Duration` slider appears. Applied animations show as a translucent ramp at the clip's start/end on the timeline.

### 4.6 Adjust › Basic (screenshot 07) — **v1-lite**
Sections: Auto adjust (AI), Color match (AI), Color correction (AI) — skip. **LUT** (checkbox): Name dropdown (None / import .cube), Intensity 0–100, Protect skin tone — later. **Adjust** (checkbox) with groups: *Color*: `Temp`, `Tint`, `Saturation` (−50…+50, coloured gradient tracks: blue→yellow, green→magenta, grey→red); *Lightness*: Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Brilliance; *Effects*: Sharpen, Clarity, Particles, Fade, Vignette. Footer: `Apply to all`, `Save as preset`.
**v1:** Brightness/Exposure, Contrast, Saturation, Temp (approx via CSS filters or a simple WebGL shader). HSL/Curves/Color wheel later.

### 4.7 Text › Basic (not in screenshots) — **v1**
[inferred, standard] Text area to type content; font dropdown; size; style buttons B/I/U; colour swatch; character spacing / line spacing; alignment (left/centre/right); then sections `Stroke`, `Background`, `Shadow` (each with checkbox); then Transform (same as video). **v1:** content, font family (few web fonts), size, colour, bold, alignment, stroke, background box, Transform.

---

## 5. Timeline (screenshots 01, 08)

### 5.1 Timeline toolbar (screenshot 08 + right half of 01)

Left group:

| # | Icon | Name | Function | Shortcut | v1? |
|---|---|---|---|---|---|
| 1 | `+` (with blue dot) | Add / new-feature menu | Quick-add menu (new feature indicator dot) **[inferred]** | — | no |
| 2 | Arrow ▾ | Select tool ▾ | Dropdown: **Select** (A), **Split** mode (B — every click on a clip cuts), Select all left, Select all right (Filmora) | A / B | **v1** Select + Split mode |
| 3 | ↶ | Undo | | Ctrl/Cmd+Z | **v1** |
| 4 | ↷ | Redo | dimmed when nothing to redo | Ctrl/Cmd+Shift+Z | **v1** |
| 5 | `][` | Split | Cut the selected clip at the playhead (all tracks if nothing selected **[inferred]**) | Ctrl/Cmd+B; all tracks Ctrl/Cmd+Shift+B | **v1** |
| 6 | `⁞[` | Delete left | Split at playhead and delete the part left of it (ripples with magnet) | Q | **v1** |
| 7 | `]⁞` | Delete right | Split at playhead and delete the part right of it | W | **v1** |
| 8 | 🗑 | Delete | Delete selected clip(s); on main track with magnet the gap closes | Delete / Backspace | **v1** |
| 9 | ⛉ (shield/tag) | Add marker | Adds a marker at the playhead (on the selected clip, else on the ruler); markers can carry a colour and note | M **[inferred]** | **v1** (ruler marker only) |
| 10 | crop-rotate square | Crop | Opens crop dialog with ratio presets and a rotate slider | — | later |
| 11 | ⧉ with ◢ | Mirror / Rotate ▾ | Small ◢ means a hidden dropdown: Mirror (flip horizontal), Rotate 90°, Reverse, Freeze (freeze inserts a 3s still at the playhead — tourboxtech) | — | **v1** Mirror; Freeze/Reverse later |
| — | divider | | | | |
| 12+ | ID card+scissors, `]+`, pencil✦, split-person, person✦, wand✦, HD◢, video✦, waveform✦ | AI tools (Transcript edit, Split scene, Remove BG, Auto adjust, Retouch, Enhance quality, AI video, Enhance voice) — capcut/Filmora list "Transcript, Split Scenes, Remove Background, Auto Adjust, Enhance Visual, Extract Audio, Enhance Audio, Voiceover" | | | **AI — omit** |

Notes: these contextual tools are disabled (grey) when no clip is selected. "Extract audio" (detach audio from a video clip onto its own audio track) is non-AI and lives in the right-click menu (Ctrl/Cmd+Shift+S) — **v1-optional**.

Right group (screenshot 01, right side of the toolbar):

| Icon | Name | Function | Shortcut | v1? |
|---|---|---|---|---|
| 🎙 | Record audio | Voice-over from microphone at the playhead | — | later |
| cyan link-chain over bar | **Main track magnet** | On: the main track is gapless — deleting/trimming ripples later clips left, inserting pushes them right. Off: free placement with gaps | P | **v1** (default ON) |
| cyan magnet/dotted | **Auto snapping** | Clip edges, playhead and markers snap together while dragging/trimming (a vertical guide line flashes) | N | **v1** (default ON) |
| cyan chain ▾ | **Linkage** | Keeps linked items (video + its detached audio, text attached to a clip) moving together | ~ (backtick/tilde) | later (no linked items in v1) |
| cyan split-bar ▾ | **Preview axis** | When on, hovering over the timeline shows that frame in the player without moving the playhead (Filmora ES) — a hover-scrub line | S | **v1-optional** |
| monitor icon | Timeline display options **[inferred]** | e.g. track height / thumbnails | — | later |
| ⊖ ──●── ⊕ | Zoom out / slider / zoom in | Horizontal timeline zoom around the playhead | Ctrl/Cmd + `-` / `=`; Ctrl/Cmd+scroll | **v1** |
| (keyboard) | Zoom to fit | Fit the whole timeline in view | Shift+Z | **v1** |

Toggles show cyan when active, grey when off.

### 5.2 Ruler
- Sits just under the toolbar. Labels every N seconds depending on zoom (`|00:00`, `|03:00`, `|06:00` at far zoom; frame ticks at close zoom). Format `MM:SS` on the ruler, `HH:MM:SS:FF` in the player.
- Click or drag on the ruler moves the playhead (scrub, with audio scrubbing **[inferred]**).
- Markers show on the ruler as small coloured flags.

### 5.3 Playhead
- White vertical line spanning all tracks with a white rounded handle on the ruler (screenshot 08 shows a hollow rounded-square handle).
- Drag to scrub; click anywhere on empty track area also seeks **[inferred]**.
- Arrow keys step one frame; Shift+arrows step several frames; ↑/↓ jump to previous/next cut; Home/End to start/end.
- During playback the timeline auto-scrolls to keep the playhead in view.

### 5.4 Tracks and their order (bottom → top is *not* the rule; this is the rule)
- **Main track** (the video track with the `Cover` button left of it) is the spine of the edit. Clips are placed edge-to-edge from 0 when magnet is on. It is drawn taller than other tracks with filmstrip thumbnails.
- **Overlay tracks** (video/image on top of main, "picture in picture"), **text, sticker, effect, filter and adjustment tracks** stack **above** the main track. Higher track = drawn on top in the player.
- **Audio tracks** stack **below** the main track (blue clips with waveform; the track header icon is a ♪/audio icon).
- New tracks are created automatically when you drop an item in the empty area above the topmost track or below the lowest one; empty tracks disappear automatically **[inferred, standard]**.
- A clip can be moved between tracks by vertical drag, or Ctrl/Cmd+↑/↓ (skillademia, unverified).
- Clip colours: video = teal with thumbnails; audio = blue with waveform; text = orange/amber; sticker = pink; effect = purple; filter = greenish; adjustment = grey **[inferred colours]**.

### 5.5 Track headers (left column, ~130px, screenshot 01)
Per track, left → right:
| Icon | Function | v1? |
|---|---|---|
| Track-type icon (video ▣ / audio ◷) | identifies type | **v1** |
| 🔒 Lock | Locks the track: clips cannot be selected/edited | **v1** |
| 👁 Hide (video/text tracks only) | Hides the track from the player and export | **v1** |
| 🔊 Mute (tracks with audio) | Mutes the track | **v1** |
| ⋯ More | Track menu (e.g. delete track, rename) **[inferred]** | later |

- **Cover** button (✎ "Cover") sits in the header area of the main track only. Opens the cover editor: pick a frame from the video or upload an image, then add text; used as the export thumbnail. **v1:** pick a frame (store timestamp) — optional, can be later.

### 5.6 Clips on the timeline
- **Video**: filmstrip thumbnails repeated along the clip; clip name at top-left; icons on the clip for applied effects (speed badge `2.0x`, animation ramps, keyframe diamonds ◇ along the bottom at keyframe positions — visible in screenshot 01).
- **Audio**: waveform drawn across the clip body; volume line **[inferred]**; fade ramps as rounded corners at the ends.
- **Selection**: white 2px outline around the clip, with **trim handles** (thicker white bars) on the left and right edges. Shift/Ctrl/Cmd+click adds to selection; rubber-band drag in empty area selects multiple **[inferred]**.
- **Trimming**: drag a handle; cannot extend beyond source media length for video/audio (images/text are unlimited). A tooltip shows the new duration. With magnet on, trimming a main-track clip ripples later clips.
- **Moving**: drag horizontally/vertically; snap guides appear (with auto snapping). On the main track with magnet on, dragging re-orders clips (insert, others shift) instead of overlapping. On other tracks clips cannot overlap — a drop over an existing clip creates/goes to another track **[inferred]**.
- **Disable clip**: V toggles enable/disable; a disabled clip is drawn dimmed and not rendered.
- **Right-click context menu** **[inferred, standard]**: Copy, Cut, Paste, Delete, Split, Duplicate, Extract audio, Freeze, Reverse, Replace clip, Group/Ungroup, Create compound clip, Enable/disable clip.

### 5.7 Ripple behaviour summary
| Action | Magnet ON (main track) | Magnet OFF / other tracks |
|---|---|---|
| Delete clip | Gap closes, later clips shift left | Gap stays |
| Delete left/right (Q/W) | Removed part closes up | Removed part leaves gap (Q leaves clip in place) |
| Trim end | Later clips follow | Neighbours unaffected |
| Insert clip mid-track | Pushes later clips right | Placed on free space / new track |
| Speed change | Clip length changes, later clips follow | Clip length changes only |

### 5.8 Zoom and scroll
- Zoom slider (bottom-right of toolbar) and Ctrl/Cmd+scroll zoom around the playhead/cursor; Shift+Z fits.
- Horizontal scrollbar at the bottom of the timeline (thin grey bar visible at bottom of screenshot 01); Shift/Alt+scroll scrolls horizontally; plain scroll scrolls tracks vertically.
- The ruler extends beyond the last clip by a margin so you can drop after the end.

---

## 6. Keyboard shortcuts (CapCut desktop defaults)

Primary source: fastshortcuts.com (checked against Filmora/primalvideo for split, Q/W, zoom). CapCut lets users rebind keys; the in-app keyboard panel is the truth. A second source (skillademia) lists several conflicting bindings (e.g. Q/W as insert/overwrite, Ctrl+R as speed); we **do not** follow it where it conflicts.

### Essentials
| Action | Windows | Mac | v1 |
|---|---|---|---|
| Play / pause | Space | Space | ✓ |
| Split selected clip at playhead | Ctrl+B | Cmd+B | ✓ |
| Split all tracks at playhead | Ctrl+Shift+B | Cmd+Shift+B | ✓ |
| Delete left of playhead | Q | Q | ✓ |
| Delete right of playhead | W | W | ✓ |
| Step one frame back / forward | ← / → | ← / → | ✓ |
| Jump to previous / next cut | ↑ / ↓ | ↑ / ↓ | ✓ |
| Fit timeline | Shift+Z | Shift+Z | ✓ |

### Tools, select, group
| Action | Windows | Mac | v1 |
|---|---|---|---|
| Select mode | A | A | ✓ |
| Split (blade) mode | B | B | ✓ |
| Select clips left / right of playhead | [ / ] | [ / ] | later |
| Delete selected | Backspace / Delete | Delete | ✓ |
| Enable / disable clip | V | V | ✓ |
| Group / ungroup | Ctrl+G / Ctrl+Shift+G | Cmd+G / Cmd+Shift+G | later |
| Compound clip / undo compound | Alt+G / Alt+Shift+G | Opt+G / Opt+Shift+G | later |
| Match cut | Ctrl+J | Cmd+J | later |
| Mark in / out | I / O | I / O | later |
| Select area by clip / clear area | Shift+X / Alt+X | Shift+X / Opt+X | later |

### Timeline and preview
| Action | Windows | Mac | v1 |
|---|---|---|---|
| Several frames back / forward | Shift+← / → | Shift+← / → | ✓ |
| First / last frame | Home / End | Home / End (Fn+←/→) | ✓ |
| Zoom timeline in / out | Ctrl+= / Ctrl+- | Cmd+= / Cmd+- | ✓ |
| Zoom with wheel | Ctrl+scroll | Cmd+scroll | ✓ |
| Scroll horizontally | Alt+scroll (also Shift+scroll) | Opt+scroll | ✓ |
| Full-screen preview / exit | Ctrl+Shift+F / Esc | Cmd+Ctrl+F / Esc | ✓ |
| Fit preview to window | Alt+Shift+Z | Opt+Shift+Z | later |
| Ignore alignment guides while dragging | hold Ctrl | hold Cmd | ✓ |

### Audio, speed, snapping
| Action | Windows | Mac | v1 |
|---|---|---|---|
| Extract / restore audio | Ctrl+Shift+S | Cmd+Shift+S | optional |
| Speed panel | Ctrl+R | Cmd+R | later |
| Curve speed | Shift+B | Shift+B | later |
| Volume up / down | Ctrl+. / Ctrl+, | Cmd+. / Cmd+, | later |
| Toggle main track magnet | P | P | ✓ |
| Toggle auto snapping | N | N | ✓ |
| Toggle linkage | ~ | ~ | later |
| Toggle preview axis | S | S | optional |
| Show / hide keyframe panel | Alt+K | Opt+K | later |

### Project, clipboard, text
| Action | Windows | Mac | v1 |
|---|---|---|---|
| New project | Ctrl+N | Cmd+N | ✓ |
| Import media | Ctrl+I | Cmd+I | ✓ |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z | Cmd+Z / Cmd+Shift+Z | ✓ |
| Copy / cut / paste | Ctrl+C / X / V | Cmd+C / X / V | ✓ |
| Duplicate | Ctrl+D (secondary source) | Cmd+D | ✓ |
| Select all | Ctrl+A (secondary source) | Cmd+A | ✓ |
| Cycle library panel tabs | Tab | Tab | later |
| Quit | Ctrl+Q | Cmd+Q | n/a (browser) |
| Split caption into two | Enter | Return | later |
| Line break in caption/text | Ctrl+Enter | Cmd+Return | ✓ |
| Resize text box from centre | Alt+drag | Opt+drag | later |
| Export | (varies by build; commonly Ctrl+E / Cmd+E) | | ✓ use Ctrl/Cmd+E |

Browser caveats: Cmd+N, Cmd+Q, Cmd+W cannot be overridden in a browser tab — use in-app buttons for New project. Shortcuts must be ignored while focus is in a text input.

---

## 7. Interaction rules worth copying (summary)

1. **Selection drives the inspector.** One selected clip → its type's tabs; multiple → only shared properties **[inferred]**; none → Project/Details.
2. **Every numeric property** = slider + field + stepper + reset (section level) + keyframe cluster. v1 builds the slider/field/stepper/reset; keyframe diamonds can be rendered disabled as a slot for later.
3. **Library tiles** share one component: thumbnail, name, duration, badges, hover preview, `+`, draggable.
4. **Main track + magnet** is the core editing model; overlays above, audio below.
5. **Toggles in the timeline toolbar** (magnet, snapping, linkage, preview axis) are global editor settings, persisted per user.
6. **Auto-save** constantly with a visible "Auto saved: time" stamp; there is no Save button.
7. **Dark theme**, cyan accent for anything active or primary, purple only for Pro/AI (which we omit).

## 8. v1 cut list (what to build first)
- Top bar: title, autosave stamp, Export.
- Left: Media tab (Import, grid, drag/`+`), Audio tab (imported audio), Text tab (Default text). Other tabs visible but showing "Coming soon" (keeps the CapCut structure).
- Player: canvas at project ratio (9:16 default; 16:9 / 1:1 / 4:5), timecode `HH:MM:SS:FF`, play/pause, Ratio menu, fullscreen, on-canvas select/move/scale/rotate with centre guides.
- Inspector: Project panel; Video › Basic (Transform, Opacity); Audio › Basic (Volume, Fade in/out); Speed › Standard (speed, duration, keep pitch); Text › Basic; Adjust › Basic (4 sliders) optional.
- Timeline: toolbar (select/split mode, undo, redo, split, delete left/right, delete, marker, mirror; magnet, snapping, zoom), ruler, playhead, main track + overlay + text + audio tracks, track headers (lock/hide/mute), thumbnails and waveforms, trim/move/snap/ripple.
- Shortcuts from §6 marked ✓.
