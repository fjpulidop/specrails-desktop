## 1. Foundation: dependency + feature flags (F0)

- [x] 1.1 Confirm + pin `@xyflow/react` (verified to install/render under React 19.2.7, zustand 4.5.7) in `client/package.json`; do not add a zustand override unless a future bump regresses.
- [x] 1.2 Add `FEATURE_LOOPS_SECTION` to `client/src/lib/feature-flags.ts` (default ON, `VITE_FEATURE_LOOPS_SECTION !== 'false'`).
- [x] 1.3 Add `isLoopsEnabled()` to `server/feature-flags.ts` (`SPECRAILS_LOOPS_SECTION !== 'false'`).
- [x] 1.4 `loops` i18n namespace created across all 8 locales (`client/src/locales/<lang>/loops.json`) + `nav.arcSidebar.loops`; key-parity test passes.

## 2. Global loops library: storage + API (F1) — capability `loops-library`

- [x] 2.1 `desktop.sqlite` migration: new `loops` table (id, name, description, status `draft|published`, graph JSON, created_at, updated_at) in `server/desktop-db.ts`. (migration 14)
- [x] 2.2 Global loops store module (`server/loops-store.ts`: CRUD + state transitions; publish/unpublish/duplicate; "running" is derived, not stored). Graph model + validator in `server/loop-graph.ts`. 27 unit tests (TDD) green.
- [x] 2.3 `loops-router` (`server/loops-router.ts`, `registerLoopsRoutes`) on the desktop `/api` router → `/api/loops*`; 404 when `isLoopsEnabled()` is false. Endpoints: list, get, create, update, publish, unpublish, duplicate, delete, templates, from-template.
- [x] 2.4 Specrails-owned starter templates (`server/loop-templates.ts`: Ship & Green, Verify Pass, CI Watch, Lint & Fix, Type Safe, Coverage Climb, Build Fix, Deploy Check) — bundled, publishable graphs (validated in `loop-templates.test.ts`); Ship & Green showcases `{{cmd:implement}} {{spec.id}}`; `from-template` clones into a new Draft.
- [x] 2.5 Guard: `isLoopRunning` DI rejects edit/unpublish/delete with 409 while running (wired to the engine in F6/F7). (Delete-published confirm is a client concern.)
- [x] 2.6 Server tests (`:memory:` desktop db): CRUD, lifecycle, publish 422, running-guard 409, flag-off 404 — 15 router tests + 27 store/validator tests.

## 3. Global section + navigation (F1) — capability `loops-library`

- [x] 3.1 "Loops" entry in `ArcSidebar.tsx` ABOVE the project list + separator below; gated by `FEATURE_LOOPS_SECTION`.
- [x] 3.2 Global `/loops` route in `App.tsx` (outside `ProjectLayout`, lazy); right sidebar hidden on `/loops`; `/loops` excluded from per-project route memory.
- [x] 3.3 `LoopsPage` library view: Published / Drafts / Templates sections; status badges; Edit / Publish / Unpublish / Duplicate / Delete (+confirm) / Use-template. 7 component tests.
- [x] 3.4 Loops API client (`client/src/lib/loops-api.ts`, global `/api/loops`, typed `LoopPublishError`). 8 tests.

## 4. Canvas builder (F2) — capability `loop-builder-canvas`

- [x] 4.1 `loop-canvas-setup` + lazy-loaded `LoopBuilder` page/component wrapping `@xyflow/react` (`ReactFlowProvider`, Background, Controls) behind Suspense.
- [x] 4.2 Node components: Start, AI Step, Shell, Loop Decider, Condition, End (custom node types) + a right-side inspector panel for the selected node.
- [x] 4.3 Edge model + the "+" between-nodes affordance (primary add path) + drag-to-reposition; allow cycles.
- [x] 4.4 AI Step config: prompt only (provider/model/effort are NOT on the node — the RAIL governs them; see D10) + a **magic-token palette** (draggable + click-to-insert chips grouped by category): data tokens `{{spec.title|description|id|status|priority|labels|jira_key|jira_url}}` and command tokens `{{cmd:implement}}`. Engine resolves `expandCommands()` then `interpolateSpec()` so `{{cmd:implement}} {{spec.id}}` works end-to-end. Generic `interpolateSpec` (any `LoopSpec` field) + `getTicketSpec` returns all fields + open command catalog (`loop-command-catalog.ts`). Palette strings in 8 locales.
- [x] 4.5 Shell node config (command) + Loop Decider config (goal/criteria) + Condition node AND/OR + general config (maxIterations, timeout).
- [x] 4.6 Publish-time graph validation (exactly one Start, ≥1 End, ≥1 Decider/exit, no orphan nodes) with concrete per-node errors; wire to the publish action.
- [x] 4.7 Pure-logic unit tests for the graph validator and `{{spec.*}}` interpolation (kept testable, outside the canvas component).
- [x] 4.8 Exclude the react-flow canvas component from client coverage with a documented jsdom rationale (mirror the browser-capture exclusion in `client/vitest.config.ts`).

## 5. Reasoning effort plumbing (F4) — capability `reasoning-effort`

- [x] 5.1 `reasoning_effort?: ReasoningEffort` on `SpawnOptions` + `supportsReasoningEffort?` on `ProviderCapabilities` (`server/providers/types.ts`).
- [x] 5.2 Codex adapter: emits `-c model_reasoning_effort="<value>"` in every build action; `supportsReasoningEffort: true`.
- [x] 5.3 Claude adapter: soft effort (thinking directive folded into the prompt, no native flag); `supportsReasoningEffort: true` so the selector shows on both providers.
- [ ] 5.4 `EnqueueOptions.effort` + `_jobEffortSelection` map in `queue-manager.ts` (capture at enqueue, read+delete at spawn, cleanup on exit).
- [ ] 5.5 `rails` table migration: `reasoning_effort` column; update `rails-store.ts` (`RailState`, getRails/getRail/setRailTickets) + new `setRailEffort()`.
- [ ] 5.6 `rails-router.ts`: `VALID_REASONING_EFFORTS` set, `PUT /rails/:i/effort`, accept+validate `reasoning_effort` in `/launch`, include in `broadcastRailUpdated`.
- [ ] 5.7 `RailEffortSelector.tsx` (clone of `RailModelSelector`); wire through `RailRow`/`RailsBoard`/`DashboardPage`; show only for capability-supporting providers.
- [x] 5.8 Adapter argv tests (codex `-c`, claude soft-prompt + never a native flag, capabilities) — 8 tests. (Rail effort persistence tests land with F7.)

## 6. Execution engine (F3) — capability `loop-execution`

- [x] 6.1 `loop-graph.ts`: graph model + traversal helpers (resolve next node, detect cycle back-edges, AND-sequence / OR-fallback).
- [x] 6.2 Loop Decider prompt module: build the structured decision system prompt; parse the `{ continue|stop, reasoning }` decision; fallback to "continue" (bounded by maxIterations/timeout) on parse failure.
- [x] 6.3 `loop_runs` table migration (per-project `jobs.sqlite`): id, loop_id, rail_index, ticket_id, iteration_limit, iteration_count, final_outcome, totals (cost/tokens/duration), status, started_at, finished_at. Add `loop_run_id` column + index on `ai_invocations`.
- [x] 6.4 `LoopRunManager`: drive the graph per iteration; AI Step via `runAiCliInvocation` with `--resume` context carry; Shell node via `/bin/sh -c` / `cmd /c` capturing stdout/stderr+exit code; enforce maxIterations + timeout (treeKill).
- [x] 6.5 Record each AI invocation (`recordInvocation`, surface=`loop`, `loop_run_id`) + `finaliseInvocationResult`; persist/update the `loop_runs` row; broadcast `spending.invalidated`.
- [x] 6.6 Shell node security: publish-time acknowledgement for loops containing Shell nodes; run in project cwd; reuse `win-spawn`/treeKill; document the trust model.
- [x] 6.7 WS message types `loop.run_started` / `loop.run_stopped` / `loop.run_completed` (`server/types.ts` + WsMessage union, project-scoped).
- [x] 6.8 Stop/cancel path: terminate the active process, settle the run as `stopped`.
- [x] 6.9 Server tests (`:memory:`): iteration counting, decider continue/stop, shell capture, maxIterations/timeout settle, loop_runs persistence, invocation linkage, stop.

## 7. Rail loop mode (F4) — capability `rail-loop-mode`

- [ ] 7.1 Add `'loop'` to `VALID_MODES` (`rails-router.ts`) and to `RailMode` (`RailControls.tsx`); add the 4th segmented-control button.
- [x] 7.2 `/rails/:i/launch` loop branch: resolves the published loop (global `desktopDb`), runs one `LoopRunManager` run per ticket (with `{{spec.*}}` from `getTicketSpec`), tracks `railLoopRuns`, validates effort. Engine broadcasts `loop.run_started`.
- [x] 7.3 `onLoopRunFinished` (in `project-registry.ts`): releases rail tickets + updates ticket status + `rail.updated` + Jira write-back; cleans `railLoopRuns`. (Job path left untouched.)
- [x] 7.4 `/rails/:i/stop` extended: cancels active loop runs for the rail + broadcasts `loop.run_stopped`; `GET /rails` exposes `activeLoopRuns`. Running-guard wired (`isLoopRunning` → `countRunningForLoop` across contexts).
- [x] 7.5 Rail header loop mode: `RailControls` "Loop" segment + `RailLoopSelector` (Published-only) + `RailEffortSelector`, wired through `RailRow`/`RailsBoard`/`DashboardPage`; Play guarded until a loop is chosen; spec fed as `{{spec.*}}` server-side via `getTicketSpec`.
- [x] 7.6 `DashboardPage` WS handler for `loop.run_completed` (mirrors `rail.job_completed` → strips tickets, resets rail); launch sends `{mode:'loop',loopId,reasoning_effort}`.
- [ ] 7.7 `LoopRunDetail` surface: live iteration timeline (Decider reasoning, active-node indicator). PENDING — a running loop shows "running" on the rail; `loop.run_progress` WS has no UI consumer yet.
- [x] 7.8 Server tests: loop launch (per-ticket, effort, spec interpolation, published-only, 404/400 guards) + loop stop/cancel — in `rails-router.test.ts`. (Client picker tests land with 7.5.)

## 8. Analytics (F5) — capability `loop-analytics`

- [ ] 8.1 Add `'loop'` surface additively: `server/ai-invocations.ts` (Surface + ALLOWED_SURFACES), `server/spending.ts` (ALL_SURFACES, DailyEntry `loopCostUsd` + switch, bySurface), `client/src/types/spending.ts` (Surface + SURFACE_ACCENT colour), `AnalyticsPage.tsx` SURFACE_CHIPS, CostScatter, SpendingTimeline, SpendingHero, export.
- [ ] 8.2 Per-project "Loops" run-metrics block: runs, success rate, avg iterations, iteration distribution, top loop — sourced from `loop_runs`; new endpoint + component under `components/analytics/`.
- [ ] 8.3 Extend the global modal: `queryProjectLoops()` in `server/desktop-analytics.ts` aggregating `loop_runs` cross-project; new cross-project loop block in `DesktopAnalyticsPage.tsx` (top loops by usage/cost, global success rate, avg iterations).
- [ ] 8.4 Tests: surface aggregation includes `loop`, run-metrics queries, global aggregation; estimated-cost flag honored.

## 9. Internationalization (all 8 locales)

- [ ] 9.1 Fill `client/src/locales/en/loops.json` with all builder / nodes / library / rail / run-detail / analytics / error strings (English source of truth).
- [ ] 9.2 Translate the `loops` namespace into es, fr, de, pt, it, zh, ja (identical key tree + placeholders).
- [ ] 9.3 Confirm the key-parity test (`client/src/lib/__tests__/locale-parity.test.ts`) passes for the new namespace.

## 10. Verification

- [ ] 10.1 `npm run typecheck` clean (server + client).
- [ ] 10.2 `npm test` + `npm run test:coverage` (server ≥80% lines/functions/statements, 70% branches).
- [ ] 10.3 `cd client && npm run test:coverage` (client ≥80% lines/statements, 70% functions) — canvas exclusion documented, logic covered.
- [ ] 10.4 Manual end-to-end: author a loop → publish → drag a spec to a rail → mode=loop → pick loop/provider/model/effort → Play → watch iterations in Loop Run Detail → verify cost appears in per-project + global analytics.
- [ ] 10.5 `openspec validate loop-builder --strict` passes.
