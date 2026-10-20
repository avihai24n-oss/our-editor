# 10 — Compound clips / subprojects (CapCut desktop ⌥G)

## What CapCut does

Sources: third-party guides plus a shortcut cheat sheet. No official CapCut help page turned up,
so labels may differ slightly between versions.
- [TourBox: What is a compound clip in CapCut](https://tourboxtech.com/en/news/capcut-what-is-a-compound-clip.html)
- [Filmora: compound clip CapCut](https://filmora.wondershare.fr/video-editing/compound-clip-capcut.html)
- [fastshortcuts: CapCut cheat sheet](https://fastshortcuts.com/shortcuts/capcut/)

| Behaviour | CapCut |
|---|---|
| Create | Select clips (drag-select or ⌘-click, across tracks). Then use right-click › **Create compound clip**, or **⌥G** (Alt+G). |
| Result | The selection becomes **one clip** on the timeline, at the earliest start, keeping its relative timing inside. It is drawn as a distinct clip with a compound icon. |
| Edit inside | **Double-click** the clip (or right-click › open) to open it as a **subproject**: a nested timeline with a breadcrumb back to the main timeline. The player shows the subproject. |
| Undo compound | Right-click › **Undo compound clip**, or **⌥⇧G** (Alt+Shift+G). The clips come back where they were. |
| Media | Compound clips appear under **Media › Subprojects**. Dragging one to the timeline makes another instance. |
| Propagation | Every instance shows the same subproject, so an edit inside appears in every use. |
| Clip props | The compound clip has its own transform / opacity / blend / animations / adjust, applied to the nested picture as a whole. Trimming its edges shows less of the subproject. |

## What Our Editor v1 does (ctx-compound)

- **Model**
  - `Project.sequences: Record<id, Sequence>`: a nested timeline (`tracks` + `duration`).
  - New clip type `compound`: `{ sequenceId, inPoint }` plus every VisualFields field.
  - Both are optional and additive: old projects load unchanged. `migrateProject` runs every clip
    migration on nested clips too.
- **Create (⌥G, right-click › Create compound clip)**
  - The selection, plus the audio linked to it, moves into a new sequence. Relative timing,
    transitions between selected clips, and the source track id and position are kept.
  - The compound clip goes into the selection's main-track slot, so the magnetic main track stays
    packed. With no main-track clip selected, it goes on the topmost selected overlay track, or on
    a new overlay track right above it.
  - One undo step.
  - Refused (menu item disabled, toast on ⌥G) when the selected main-track clips are not adjacent,
    or another main-track clip lies inside the selection's time span.
- **Undo compound (⌥⇧G)**
  - The clips of the compound clip's window go back at the right times, trimmed to the window if
    it was trimmed.
  - Main-track clips return to the main track. The other clips return to their original track if
    it is still there and free; otherwise a track is recreated at its old position.
  - Ungrouping the last instance deletes the sequence and keeps every id. Create + undo compound
    therefore restores the project JSON exactly; a unit test and the e2e check this.
  - Ungrouping while other instances exist makes copies with new ids.
- **Render / export**
  - `getFrameState` builds a compound clip's nested frame with the same code as the timeline, at
    local time `inPoint + (t − start)`. The depth limit is 8, and a cycle guard stops a sequence
    that is already on the stack.
  - The compound op is a `media` op carrying `nested`. The compositor draws the nested ops onto an
    offscreen layer, then draws that layer through the compound clip's transform, opacity, blend,
    animations and colour.
  - Nested audio ops are added to the frame's audio with prefixed ids. `planMix` recurses with
    each compound clip's time window.
  - Preview pixels before and after ⌥G are identical (MAD 0 in e2e). Export matches the preview.
- **Nested editing**
  - Double-click a compound clip to open its sequence in the timeline. The open sequence's tracks
    become `project.tracks`, and the outer timeline waits in `project.focus`.
  - A breadcrumb "Main › Compound 1" (with Back) closes back to any level.
  - Opening and closing re-frame the whole undo history instead of being undo steps, so ⌘Z inside
    stays inside.
  - On close, the sequence duration follows its content. Instances that showed the sequence to
    its end follow it; the others are cut to the new end.
  - Saving, reloading and exporting always use the main timeline (`rootProject`).
- **Media › Subprojects**: lists every sequence with its duration and number of uses. Each can be
  dragged onto the timeline or added at the playhead ("+"). Placing a sequence inside itself is
  refused.
- **Invariants**: every track scope is checked with the timeline rules: the open timeline, the
  focus stack and every closed sequence. Clip ids are unique across all scopes. Sequences must
  resolve, contain no cycles, and have `duration` equal to their content end. A compound clip may
  not show past its sequence's end. The magnet binds only the open timeline.

## Deferred

- Speed on the compound clip (Speed tab), and the compound clip's own volume / mute.
- Mask / chroma / canvas on compound clips: the Video tab shows Transform and Blend only.
- Renaming a subproject from the UI (the `renameSubproject` action exists).
- Thumbnails of the nested picture on the compound clip body; it shows a striped body and an icon.
- An instance of a sequence that is open further down the stack shows the stored copy, not the
  live edits, until the sequence is closed. Only the open timeline is drawn, so this is invisible.
