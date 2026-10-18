# Integration notes

Three builders work in parallel. The shared contracts are frozen for them:

- `src/model/**` (types, defaults, catalog, time helpers, project helpers)
- `src/store/**` (the Zustand store, ops, persistence, autosave, selectors)
- `src/engine/frameState.ts` (the render contract)
- `src/media/import.ts`, `src/media/registry.ts`
- `src/App.tsx`, `src/main.tsx`, `src/theme.css`, `package.json`

**If you need a change in any of them, do NOT edit them.** Instead:

1. Append a request to `docs/integration-notes/<area>.md` (`library-inspector.md`, `timeline.md`,
   `player-export.md`, or `engine.md`). One section per request:

   ```md
   ## <short title>
   - File: src/store/index.ts
   - Need: <the action / field / helper and its exact signature>
   - Why: <the feature that needs it>
   - Workaround in place: <what you did locally meanwhile, and where>
   ```

2. Work around it locally inside your own folder (a local helper, a derived value, a TODO), so
   your part still builds and runs.
3. QA applies the requests to the frozen files, removes the workarounds and marks the section
   `**Applied**`.

Other rules:

- Need a new npm dependency? Request it here; do not run `npm install` (parallel installs corrupt
  the lockfile).
- CSS: put your styles in a file inside your own folder (e.g. `src/timeline/timeline.css`) and use
  the tokens from `src/theme.css`. Missing token → request it here.
- Shared UI (`src/ui/**`): import freely. `controls.tsx` is owned by the Library + Inspector
  builder; `icons.tsx` / `Icon.tsx` / `primitives.tsx` are append-only for everyone (add new icons
  at the end, never change existing ones).
- Definition of done for every builder: `npm run typecheck`, `npm test`, `npm run build` pass.
