# 08 — Clip right-click menu: "Edit ›"

Research done 20 Oct 2026 (web only, about 10 minutes). Goal: find exactly which items CapCut
desktop's clip context menu "Edit ›" submenu has, and their shortcuts.

## What could be verified

**Not verified: that CapCut desktop has a right-click "Edit ›" submenu, or what is in it.** No
official CapCut help page, Reddit thread or tutorial transcript we reached describes it. The
two-level "Edit" menu with Rotate / Mirror / Crop that tutorials show is the **mobile** app's
bottom toolbar. On desktop, the official pages put the same tools elsewhere:

| Tool | Where CapCut desktop has it | Confidence | Source |
|---|---|---|---|
| Mirror | toolbar above the timeline | high (official) | capcut.com/resource/how-to-mirror-videos-on-capcut ("the 'Mirror' tool in the editing toolbar above the timeline"); capcut.com/resource/how-to-flip-videos |
| Rotate | right-hand properties panel (and toolbar) | medium (official, vague) | same mirror page: "the 'Rotate' option on the right side of the screen" |
| Crop | toolbar above the timeline | high (official) | capcut.com/resource/how-to-crop-video-in-capcut-pc ("locate the 'Crop' button in the toolbar above the timeline") |
| Freeze | toolbar above the timeline; the label is "Freeze" | medium-high | tourboxtech.com/en/news/how-to-freeze-a-frame-in-capcut-pc.html; cloudspress.com/how-to-freeze-frame-in-capcut-pc-full-guide ("the command is usually called Freeze"; also "right-click the selected video clip and choose Freeze", low authority) |
| Reverse | timeline toolbar | medium (third-party) | filmora.wondershare.fr/advanced-video-editing/capcut-timeline.html ("Freeze / Reverse / Mirror / Rotate"); movavi.com/learning-portal/how-to-reverse-a-video-on-capcut |
| Replace clip | no source found for the right-click menu | unverified | — |

Other right-click items seen in third-party sources (incomplete, low-medium confidence): Freeze,
Create compound clip (tourboxtech.com/en/news/capcut-what-is-a-compound-clip.html), Split /
Delete / Detach audio "depending on version" (umatechnology.org).

**Decision.** The submenu ships with the six candidate tools (Mirror, Rotate, Crop, Reverse,
Freeze, Replace clip). They are all real CapCut desktop features, and they are what a desktop
"Edit" group would hold. CapCut's desktop labels are used ("Freeze", not "Freeze frame"). The
item order and the submenu's existence should be checked against the real app.

## Shortcuts

| Action | Shortcut found | Confidence |
|---|---|---|
| Split | ⌘B / Ctrl+B | high (primalvideo.com/guides/capcut-for-pc-mac-tutorial, fastshortcuts.com/shortcuts/capcut) |
| Extract / restore audio | ⌘⇧S / Ctrl+Shift+S | low-medium (fastshortcuts; skillademia says Ctrl+Shift+M) |
| Freeze | none found. ⇧F appears nowhere; ⌘⇧K is Final Cut Pro's "Frame hold" | unverified |
| Reverse | none found | unverified |
| Mirror / Rotate / Crop | only skillademia.com (Ctrl+Shift+F, R, Ctrl+Shift+C), an auto-generated page that contradicts the other sources (it lists Q/W as insert/overwrite) | unverified |
| Replace | none found | unverified |

**Decision: no new key bindings.** None of the six items has a verified CapCut default, and
a guessed key could clash with a real CapCut binding added later. `src/timeline/shortcutDefs.ts` is unchanged, and the menu items carry no `shortcut`
label. CapCut lets users rebind nearly every key (fastshortcuts), so the real defaults have to be
read off the app's own Keyboard shortcuts panel.

## Crop ratio presets

The official crop page (capcut.com/resource/how-to-crop-video-in-capcut-pc) names **Free**, 9:16,
3:4, 1:1, 16:9 (for YouTube) and 4:5 (Instagram feed), "such as", so not necessarily the full list.
4:3 appears only in a general aspect-ratio statement (low-medium). 2.35:1 was not found.
The dialog offers Free, 16:9, 9:16, 1:1, 4:3, 3:4 and 4:5.

## Freeze duration

**3 s** (medium-high): tourboxtech, "A 3-second freeze frame will appear at the chosen spot in the
clip". The still is a separate clip whose edges can be dragged. One low-authority source
(cloudspress) disputes a fixed default.

## What our "Edit ›" does

| Item | Behaviour | Undo |
|---|---|---|
| Mirror | toggles `transform.flipH` on every visual clip in the selection | one step |
| Rotate | +90° clockwise, kept in −180..180 | one step |
| Crop | dialog: the clip's source frame, a crop box (drag to move, corner handles to resize), Free / 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 4:5, Reset, Confirm → `clip.crop` (rendered by the player and the export) | one step |
| Reverse | toggles `reversed` on video / audio clips (and on the audio extracted from a video, when it is the same span); the clip plays its source span backwards in the preview (picture by per-frame seeking, sound from a time-reversed decoded buffer) and in the export (picture through a bounded backwards decode window, sound through the same time-reversed buffer in the OfflineAudioContext mix) | one step |
| Freeze | the frame at the playhead (decoded like the export decodes it) becomes a PNG image asset; the clip is split there and a 3 s still that keeps the clip's look is inserted; later clips on that track move right by 3 s | one step (the image stays in the media pool, like any import) |
| Replace clip | file picker; the new media takes the clip's place with its timing, speed, reverse, look, audio settings and animations. Video ↔ image changes the clip type. Media shorter than the clip's source span is refused with a toast | one step |

## Model: how Reverse is stored

`TimedMediaFields.reversed: boolean` (migration fills `false`). While it is true, `inPoint` is
measured in **reversed media time**, from the media end. The clip reads reversed media
`[inPoint, inPoint + span]`, which is real media `(D − inPoint − span, D − inPoint]`. Every
timeline op (trim, split, speed, curve, fit-to-media, invariants) is therefore unchanged: a
reversed clip behaves exactly like a forward clip of a reversed copy of the media. Only the
readers of media time map back: `mediaTimeAt` / `mirrorMediaTime` in `src/model/time.ts`
(frameState, the filmstrip, the waveform), and `reverseChannels` in `src/audio/reverse.ts` (the
audio mix and the preview voices).

## Limits / follow-ups

- Preview picture of a reversed clip while PLAYING comes from seeking the hidden <video> every
  tick, so it trails the clock by the seek latency (measured ≈ 9 frames / 0.3 s on the 5 s testsrc2
  file, more on long-GOP media). Paused / scrubbing is frame-exact, and so is the export. A
  pre-decoded backwards window in the preview, like the export's ReverseReader, is the follow-up.
- Preview audio of a reversed clip skips the FX chain (voice filter, reduce noise, fill channel)
  and plays speed by resampling (pitch follows speed); the export applies the full chain. The
  reversed buffer of one asset is held while it plays (at most two assets, LRU).
- Export of a reversed clip decodes from the keyframe before each 10-frame window. Long-GOP
  sources therefore cost more decode time, while memory stays bounded at ten frames per clip.
- No key bindings yet (see above).
