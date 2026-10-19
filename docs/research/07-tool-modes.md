# 07 — Timeline tool modes (CapCut desktop)

Researched 2026-10-19 for "pressing A returns to the normal mode, B turns the mouse into the cut
mode — CapCut has more of these". Question: which **cursor tools** does CapCut desktop's timeline
have, with which keys, and how does each one behave?

No official CapCut desktop help page documents the tools (searched capcut.com/help; the only
official hit covers the *web* editor's captions). Everything below is from third-party cheat
sheets, tutorials and guides, cross-checked against each other and against our own CapCut
screenshot `docs/capcut-screens/08-timeline-toolbar.png` (pointer icon + ▾ right after "+").

## Verdict

| Tool | Key | Status | Implemented |
|---|---|---|---|
| **Select** | A | verified | yes |
| **Split** (blade) | B | verified | yes |
| **Select leftward** | `[` | verified (exists, in the cursor dropdown, key `[`) | yes |
| **Select rightward** | `]` | verified (exists, in the cursor dropdown, key `]`) | yes |
| Trim / ripple tool | — | **not found** in CapCut (trimming is the clip handles in Select; Q / W are delete-left / -right actions, not a tool) | no |
| Slip / slide tool | — | **not found** | no |
| Hand / pan tool | — | **not found** (the timeline scrolls with the wheel / ⇧ / ⌥ + wheel) | no |
| Zoom tool | — | **not found** (zoom is ⌘+ / ⌘− / ⌘ + wheel / the slider) | no |
| Track select forward / backward (Premiere-style, one track) | — | **not found**; CapCut's leftward / rightward work on all tracks | no |

So CapCut's dropdown has exactly four entries; those four are what we ship.

## Sources

1. fastshortcuts.com — "CapCut Keyboard Shortcuts 2026" — https://fastshortcuts.com/shortcuts/capcut/
   — "A — Select mode (leave split mode)", "B — Split mode — every click cuts", "[ / ] — Select clips
   to the left or right", ⌘B split, ⇧⌘B split all tracks. No trim / slip / hand / zoom tool.
2. tutorialtactic.com — "50 CapCut Keyboard Shortcuts" — https://tutorialtactic.com/blog/capcut-shortcuts/
   — Select mode A, Split mode B, Select to the left `[`, Select to the right `]`. "If you're in Split
   mode or Select mode, certain shortcuts may behave differently."
3. Filmora — "Master CapCut Timeline Settings: 2026 Guide" — https://filmora.wondershare.com/advanced-video-editing/capcut-timeline.html
   (German edition: https://filmora.wondershare.de/advanced-video-editing/capcut-timeline.html)
   — section **"The Cursor"** lists four tools: Select "Move or highlight clips", Split "Cut footage at
   cursor position", Select Leftward "Select all clips on the left of the playhead", Select Rightward
   "Select all clips on the right of the playhead".
4. vicvideopic.com — "CapCut video editing tutorial for PC" — https://vicvideopic.com/capcut-video-editing-tutorial-for-pc/
   — "With the first one [icon], we can modify the behavior of the mouse from Select (shortcut A) to
   Split (Shortcut B) which turns it into a knife, to Select all the clips to the left or Select all
   clips to the right."
5. CliffsNotes "Capcut shortcuts for PC" (title/snippet only, page 403) — https://www.cliffsnotes.com/study-notes/27637441
   — "SELECTS ALL TRACKS TO THE LEFT — SELECT LEFTWARD — [ — AKA THE ARROW CURSOR".
6. YouTube — "How to Use Select Leftward and Select Rightward in CapCut PC — Lesson 92"
   https://www.youtube.com/watch?v=1MC_LS2u0uk and "How To Use Select Leftward And Select Rightward
   (Updated 2026)" https://www.youtube.com/watch?v=6MwmEko5hew — confirm the names (no transcript
   reachable).
7. HyperFrames Studio PRs #4714 / #4755 (an editor that copied CapCut's picker) —
   https://github.com/heygen-com/hyperframes/pull/4714 — one tool button showing the active tool's
   icon + ▾, menu rows "icon · name · key": Select, Split (B), Select leftward ([), Select rightward (]).
   Not a CapCut source; used only as corroboration of the menu's shape.
8. Low-quality / conflicting (discounted): ytzolo.com "How to turn off blade in CapCut"
   (https://ytzolo.com/blog/how-to-turn-off-blade-in-capcut/) says ⌃B *enters* blade mode and V
   leaves it, and S splits — contradicts sources 1–4; not used.

## Per tool

### Select (A) — verified
- Cursor: the normal arrow (clips show the grab hand of our clip body).
- Click selects, ⌘/⇧-click toggles, drag moves, edge handles trim, drag on empty lane = marquee.
- It is the default; A, Esc, or choosing it in the dropdown returns to it.

### Split / blade (B) — verified
- Cursor: a knife / razor (source 4: "turns it into a knife"; source 1: "every click cuts").
- Click on a clip cuts that clip at the cursor (source 3: "Cut footage at cursor position").
  The tool stays active: every further click cuts again (sources 1, 8) until A / Esc.
- Clips are not moved or trimmed in this mode (every press is a cut).
- **Unverified, ours:** the thin vertical cut line that follows the mouse over the hovered clip with a
  timecode tip, snapping to the playhead and to frames. CapCut shows a blade cursor; whether it also
  draws a line is not documented — the user asked for it, so it is drawn (and it is exactly where
  the click cuts).
- **Unverified, NOT implemented:** ⇧+click to split every track at that time. No CapCut source
  mentions it (only HyperFrames has it). ⇧⌘B splits all tracks at the playhead, which CapCut does
  have.

### Select leftward (`[`) / Select rightward (`]`) — verified (existence, key, all tracks)
- In the same dropdown, they change "the behavior of the mouse" (source 4) and select across all
  tracks (source 5: "selects all tracks to the left").
- Anchor: source 3 says "of the playhead"; source 4 says the *mouse* selects. **Unverified which one
  CapCut uses on click.** We do both, so either reading holds:
  - pressing `[` / `]` selects every clip on unlocked tracks left / right of the **playhead** at
    once (the shortcut-sheet reading) and arms the tool;
  - with the tool armed, a click (on a clip or on empty lane) selects everything left / right of the
    **click**, and a drag from a clip moves the whole selection.
- Rule (same for key and click): leftward = clips that start before t; rightward = clips that end
  after t; a clip crossing t belongs to both; locked tracks are skipped.
- Cursor: **unverified** — we use an arrow with a bar and a ← / → chevron, matching the dropdown icon.
- Hover feedback (a vertical line with a timecode tip, the clips a click would take outlined):
  **ours**, not documented for CapCut.

### Returning to Select
- A (sources 1, 2) and the dropdown (sources 4, 8). **Esc** is not documented for CapCut; we keep it
  because the user asked for it and it was already our behaviour (Esc first leaves a tool, then
  clears the in/out area, then the selection).

### Mode indicator
- CapCut: the pointer icon in the toolbar shows the active tool, and the dropdown lists every tool
  with its key (screenshot 08 + source 7's copy). **No toast / hint on switching is documented**, so
  we show none — the toolbar icon and the cursor are the indicator.

### Keys
- Plain letters only: A / B / `[` / `]` with any modifier held are other commands (⌘A select all,
  ⌘B split at playhead, ⇧B curve speed, ⇧⌘B split all). Physical keys, so a Hebrew layout works.
- They work whatever has focus except text fields (and not behind a modal).

## Implementation map

- `src/timeline/tools.ts` — the tool table (id, label, icon, command, SVG cursor with hotspot),
  `bladeTime` (where the blade cuts), `clipsOnSide` (what leftward / rightward take). Unit tests:
  `src/timeline/tools.test.ts`.
- `src/timeline/shortcutDefs.ts` — the four tools in the "Tools" group (panel + tooltips).
- `src/timeline/Toolbar.tsx` — the dropdown is generated from `TOOLS`; the button shows the active
  tool's icon.
- `src/timeline/Timeline.tsx` — cursor (`--tl-tool-cursor` on `.tl[data-tool]`), blade line + tip,
  side line + target outline, click behaviour per tool; trim handles hidden outside Select.
- e2e: `e2e/tool-modes.spec.ts`.
