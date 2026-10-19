# Functional audit — timeline and editing operations

Date: 2026-10-19. Branch `agent/qa-timeline`. Scope: every timeline toolbar button, every
keyboard shortcut in `src/timeline/shortcutDefs.ts` (except the A / B tool modes, which are being
reworked elsewhere), every timeline gesture, and the model invariants behind them.

The question was "does it **work**", not "does it look right". Every check below asserts the effect
on the project model (exact µs values for clip start / duration / in-point), the invariants after
each step, and that undo / redo restore the **exact** previous / next project (deep-equal JSON).
Where it matters, the rendered preview (canvas pixels) and the live audio voices are checked as
well.

## How it is tested

| Layer | File | What it does |
|---|---|---|
| Invariants | `src/store/invariants.ts` | `projectViolations(project, {magnet, selection})`: one main track at the bottom of the visual stack; no empty non-main tracks; clips sorted, never overlapping, `trackId` consistent, accepted by their track kind; integer times, start ≥ 0, duration ≥ 1 frame; **no gap on the main track while the magnet is on**; in-point ≥ 0, speed in range, **`inPoint + duration × speed` inside the media**; fades and animations fit; transitions only between adjacent clips of their own track, one per cut, not on audio, ≤ half the shorter clip (**no orphan transitions**); **every `audioLink` has both a video and an audio side**, and a linked video is muted; markers sorted and unique; selected clips exist and are not on locked tracks. Exposed in dev as `window.__oeCheck()` for the e2e tests. |
| Property / fuzz | `src/store/fuzz.test.ts` | 40 seeds × **200 random edits** through the real store actions (add, add-to-track, text, move, multi-move, trim both edges, live trim gesture, split, split at playhead, split all, Q, W, delete, delete selected, duplicate, cut + paste, speed, duration, extract / restore, fades + animations, add / update / remove / apply-to-all transitions, lock / hide / mute, markers, magnet, linkage, mirror / rotate, volume). After **every** step: invariants; an undo step must change the document; undo restores the exact previous JSON and redo the exact result. At the end: undo-all returns to the exact starting document and redo-all to the exact end. A final test proves the fuzz is not vacuous (every kind of edit changed the document ≥ 10 times). |
| Deterministic audit | `src/store/fuzz.test.ts` (`audit:` blocks) | Exact values for every operation and one regression test per bug below. |
| Real browser | `e2e/audit-timeline.spec.ts` | Six Chromium tests driving the real UI with the mouse and keyboard: toolbar, shortcuts, gestures, track headers, transitions + markers, and a UI fuzz (60 random keyboard / toolbar edits, invariants after each, ⌘Z back to the exact start). |

## Bugs found and fixed

| # | What was wrong (and how it showed) | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | **Refused and no-op edits pushed empty undo steps.** Q on a locked track, moving a clip back to its spot, setting a transition to its current value, magnet-on when already packed, a slider dragged back to where it started: each left an undo step that did nothing, so ⌘Z appeared broken. | `normalize()` re-assigned `track.transitions = …filter()` (and `removeEmptyTracks` `p.tracks = …filter()`) on every edit, so immer always produced a new project; `edit()` never saw "no change". `commitTx()` compared by reference only. | `retain()` filters in place (the draft is only touched when something is removed); `edit()` also skips results structurally equal to the input (cheap: only changed subtrees are walked); `commitTx()` drops a gesture that ended where it began. | `audit: no empty undo steps` (2 tests); the fuzz now fails on any empty step |
| 2 | **New media went INTO a locked main track.** With the main track locked, adding a video (+ in the bin, drop, ⌘V paste) inserted it into the locked track and rippled its clips. | `addClipFromAsset` / `insertClips` fell back to `insertOnMain` without checking the lock. | A locked main track is never touched: video / image goes to a free overlay track. | `REGRESSION: with the main track locked, new media goes to an overlay track`; e2e track-header test |
| 3 | **Clips read past the end of their media.** Speed 3 on a 6.000017 s file read 1 µs too far; speed 100 on a 3 s clip read 3.33 s (one frame × 100); repeated splits at fractional speed drifted 0.5 µs per split; trimming the left edge at fractional speed could do the same. | `setSpeed` rounded the new duration up; the 1-frame minimum ignored the media; `splitClip` / `trimStart` rounded the new in-point. | `setSpeed` floors the duration and caps the speed so one frame still fits; split / trim floor the in-point; `normalize()` has a `fitToMedia` safety net. | `REGRESSION: speed 3 …`, `REGRESSION: speed 100 …`, `split at a fractional speed never reads past the media end` |
| 4 | **Dangling `audioLink`s.** Deleting extracted audio left the video pointing at nothing; deleting the video left the audio linked to nothing; a duplicated / pasted extracted video stayed linked to the ORIGINAL audio (restoring one then deleted the other's audio). | Nothing cleaned links; copies kept the source link id. | `normalize()` drops one-sided links (the video stays muted; ⌘⇧S extracts again); duplicate / paste give copies fresh link ids (a video + its audio copied together stay paired). | 3 `REGRESSION` tests in `audit: extract / restore audio and linkage`, `… copy / cut / paste / duplicate` |
| 5 | **Linkage only looked like it worked.** The toolbar button and `~` toggled an icon; nothing read the flag. | No implementation. | `linkage` is now store state (still persisted by the timeline UI store). With it on, an extracted audio clip that lines up with its video follows it when the video is moved or rippled along the magnetic main track (trims are not moves). Off: the audio stays. | `FIXED: linkage on …`; e2e gestures test drags a linked video with linkage on and off |
| 6 | **Locked clips stayed selected.** Locking a track kept its clips in the selection (Delete / mirror then silently did nothing, the inspector still edited nothing). | `pruneSelection` only dropped missing ids. | Locked-track clips are dropped from the selection. | lock test asserts `selection == []`; the invariant checks it after every fuzz step |
| 7 | **Q on a locked main track moved the playhead** though nothing was cut. | The playhead jump ran regardless of the result. | Only when the project changed. | `REGRESSION: Q on a locked main track …` |
| 8 | **Magnet + undo silently closed gaps later.** Undo of "magnet on" brought back a gapped main track while the magnet stayed on, so the NEXT unrelated edit (a marker, a volume change) packed the main track behind the user's back. Redo of "magnet on" did not turn the magnet back on. | Magnet is UI state, history only holds documents. | Undo / redo / load / Esc-cancel turn the magnet off when the restored main track has gaps; redo restores the magnet that was on when that document was current. | `REGRESSION: undoing it turns the magnet off again`, `audit: magnet undo / redo symmetry` (2); e2e toolbar test |
| 9 | **Double-click on a marker never removed it.** | The first click seeks the playhead onto the marker; the playhead head (z-index 3) then sat on top of the marker (z-index 1) and took the second click. | Markers stack above the playhead head. | e2e transitions + markers test (`remove marker (double-click)`) |

## Control → expected effect → result

Result: **pass** (worked, now proven), **fixed** (was broken, fixed here, regression test added),
**open** (still not working / not built — see the end).

### Toolbar

| Control | Expected effect | Result | Evidence |
|---|---|---|---|
| Undo / Redo buttons | Restore the exact previous / next project; disabled when nothing to undo / redo | pass | e2e toolbar: deep-equal JSON after each; disabled state |
| Split | Splits the selected clips under the playhead (else every unlocked clip there); right piece in-point = left in-point + left duration × speed | pass | e2e toolbar `[0,2s,0] [2s,3s,2s]`; audit split test |
| Delete left (Q) | Removes the part before the playhead; magnet on: clip keeps its slot, playhead goes to the cut; magnet off: leaves the gap | pass / fixed (#7) | e2e toolbar + shortcuts; audit Q tests |
| Delete right (W) | Removes the part after the playhead | pass | e2e; audit W test |
| Delete | Deletes the selected clips or the selected transition; main track ripples with the magnet on | pass | e2e toolbar / shortcuts / transitions |
| Add marker | Marker at the playhead, frame-snapped, one per frame | pass / fixed (#9 removal) | e2e: 1 234 567 µs → 1 233 333 µs |
| Mirror / Rotate 90° | flipH toggles / rotation +90°, on the selected visual clips; disabled without one | pass | e2e toolbar |
| Main track magnet | On: main track packed from 0 (one undo step); off: gaps kept | pass / fixed (#8) | e2e toolbar; fuzz invariant |
| Auto snapping | Turns snapping of moves / trims / drops on and off | pass | e2e flags; gestures snap with it on, exact pixels with Alt |
| Linkage | Extracted audio follows its video | **fixed (#5)** | audit + e2e gestures |
| Preview axis | Hover line + hovered frame in the player; off: neither | pass | e2e toolbar (`timeline-hover`, `previewTime === null`) |
| Zoom − / + / slider / fit | ×1/1.25, ×1.25, slider mapping, fit puts the whole edit in the lane; not undo steps | pass | e2e toolbar |
| Crop | Not in the toolbar in v1 (model + render only, SPEC) | n/a | — |

### Keyboard shortcuts (`shortcutDefs.ts`)

| Key | Expected effect | Result | Evidence |
|---|---|---|---|
| Space | Play / pause | pass | e2e shortcuts |
| ⌘B / ⇧⌘B | Split selection / split every unlocked track | pass | e2e (`⌘⇧B` splits video + audio at 2 s, in-points 2 s) |
| Q / W | Delete left / right | pass | e2e exact values |
| ← → / ⇧← ⇧→ | ±1 / ±10 frames | pass | e2e (1 033 333 µs, 1 333 333 µs) |
| ↑ ↓ | Previous / next edit point | pass | e2e (5 s, end of the audio, 5 s) |
| Home / End | Start / project end | pass | e2e |
| ⇧Z | Fit timeline | pass | e2e |
| = − (with or without ⌘) | Zoom in / out | pass | e2e |
| [ ] | Select clips left / right of the playhead | pass | e2e + audit |
| ⌘A | Select all on unlocked tracks | pass | e2e (locked track skipped) |
| ⌫ / ⌦ | Delete selection / transition | pass | e2e |
| V | Enable / disable | pass | e2e |
| M | Marker | pass | e2e |
| I / O / ⇧X / ⌥X / Esc | In, out, area from clip, clear area, clear | pass (state) / **open** (nothing uses the area yet) | e2e area values + `timeline-area` attributes |
| S / P / N / ~ | Preview axis, magnet, snapping, linkage | pass (linkage fixed #5) | e2e flags |
| ⇧⌘S | Extract audio (exact span, video muted, linked) / restore | pass / fixed (#4) | e2e + audit |
| ⌘. / ⌘, | Volume ±1 dB | pass | e2e (1 dB, then −1 dB) |
| ⌘R / ⇧B | Speed tab / Speed › Curve, no page reload | pass | e2e |
| ⌘C ⌘X ⌘V ⌘D | Copy / cut / paste at the playhead / duplicate after itself | pass / fixed (#2, #4) | e2e exact starts; audit |
| ⌘Z / ⇧⌘Z | Undo / redo | pass / fixed (#1, #8) | every `exactUndo` in the e2e spec |
| ⌘E / ⌘I / Tab ⇧Tab / ⇧⌘F / ⌥⇧Z | Export dialog, import chooser, library tabs, full-screen preview, fit preview | pass | e2e |
| ⌘G, ⇧⌘G, ⌥G, ⌥⇧G, ⌘J, ⌥K, Enter | "Coming soon" toast (declared `soon`) | pass (as declared) | `e2e/shortcuts.spec.ts` |
| A / B | Tool modes | excluded (reworked elsewhere) | — |

### Gestures

| Gesture | Expected effect | Result | Evidence |
|---|---|---|---|
| Click / ⇧-click / ⌘-click | Select / add / toggle | pass | e2e gestures |
| Click on empty lane | Playhead there (frame-exact), deselect | pass | e2e (4 s) |
| Marquee | Selects clips in the rectangle on unlocked tracks | pass | e2e (overlay + 2 main clips, not the audio) |
| Move within the magnetic main track | Reorder by insertion, packed | pass | e2e `[l 0][v 4 s]` |
| Move in time (Alt = no snap) | Exact pixel delta | pass | e2e 150 px → +1.5 s |
| Snap to playhead / marker / clip edge | Start lands exactly on it within 8 px | pass | e2e 4.2 s, 6 s, 5 s |
| Move across tracks | Main → overlay at the drop time; cross-kind drop refused | pass | e2e |
| Drop in the top / bottom band | New overlay / audio track; the emptied track goes away | pass | e2e |
| Trim right / left edge | Exact; stops at media end / in-point 0; scaled by speed; ripples on the magnetic main track | pass / fixed (#3) | e2e (5 s cap, in-point 0 cap, 2.5 s at speed 2) |
| Trim snapping | Edge snaps to the playhead / a marker | pass | e2e 2.2 s, 3 s |
| Esc during a trim | Exact document restored, no undo step | pass | e2e |
| Every gesture | One undo step, exact restore | pass | e2e `exactUndo` |

### Tracks, transitions, markers

| Control | Expected effect | Result | Evidence |
|---|---|---|---|
| Lock | No edit of any kind changes the track: clicks, drags, trims (no handles), Q W ⌘B ⇧⌘B ⌫ ⌘D, inspector patches, speed, transitions, paste / add into it; its clips cannot be selected | pass / fixed (#2, #6, #7) | audit "a locked track refuses EVERY edit" (26 attempts, track JSON unchanged); e2e track headers |
| Hide (eye) | Pictures leave the player and the export; audio still plays | pass | e2e: canvas luminance > 10 → < 3 and back on undo; audit: `getFrameState` (used by player AND exporter) draws 0 ops, `planMix` keeps the audio |
| Mute (speaker) | Track silent in the player and the export | pass | e2e: 0 live voices while playing muted, ≥ 1 unmuted; audit: `getFrameState().audio` and `planMix` exclude it |
| Cover | Cover picker on the main track | **open** — button present on the main track only, disabled "Cover (coming soon)" | e2e asserts present + disabled |
| Transition: add | On the cut after the selected clip (Transitions tab), 0.5 s | pass | e2e |
| Transition: select | Click on the timeline marker → selected, inspector shows it | pass | e2e |
| Transition: duration / type | Typed duration applied, clamped to half the shorter clip; type buttons | pass | e2e 1.5 s, 9 → 2 s, zoom |
| Transition: delete | Delete key / removing a clip of the cut removes it (no orphan); split hands it to the right piece | pass | e2e + invariant |
| Markers | M adds; click seeks; double-click / right-click removes; snapping targets | pass / fixed (#9) | e2e |

## Still open

- **In / out area has no consumer.** I / O / ⇧X / ⌥X set and draw the area correctly, but nothing
  uses it yet (export, playback and delete ignore it). Needs a product decision (export range or
  loop playback) before it can do something.
- **Cover** is a disabled "coming soon" button (spec: optional for v1).
- **Multi-selection dropped into a band** moves only the dragged clip to the new track (a
  multi-selection dragged onto existing rows moves together).
- Undo does not restore the selection that existed before a delete (the restored clip is not
  re-selected). Not a model bug; noted for parity.

## Results

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **426 / 426 pass** (24 files; `src/store/fuzz.test.ts` = 40 fuzz seeds × 200 edits + coverage check + 41 deterministic audit / regression tests) |
| `npm run build` | passes |
| `e2e/audit-timeline.spec.ts` | **6 / 6 pass** (toolbar, shortcuts, gestures, track headers, transitions + markers, UI fuzz) |
| `smoke`, `flows`, `shortcuts`, `file-drop`, `timeline-stability`, `memory` specs | all pass (1, 1, 2, 2, 7, 2), each run alone through the browser lock, workers = 1, port 5160 |
