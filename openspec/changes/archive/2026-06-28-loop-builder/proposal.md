## Why

Users today launch a spec on a rail in one of three modes (implement / batch-implement / freestyle) — each a single, fire-and-forget AI invocation. There is no way to express an **iterative, self-correcting workflow** ("keep implementing and running the tests until they pass", "verify the build, and if it fails, fix and re-verify"). Closed-loop agent workflows are a proven pattern (cf. loops.elorm.xyz), but no first-class, reusable, app-governed mechanism exists.

This change introduces **Loops**: a global, cross-project library of reusable, visually-authored automation loops, executed by an app-driven engine whose stop/continue decision is made by a dedicated AI node — and a new `loop` rail mode that runs a published loop against the dragged spec, on Claude or Codex, with selectable model and reasoning effort.

## What Changes

- **New global "Loops" section** (`/loops`) reachable from a sidebar entry placed ABOVE the project list with a separator. It is **global** (cross-project), not per-project — loops are reusable recipes, built once and used everywhere.
- **Visual node-canvas builder** (n8n-style) using `@xyflow/react`. Authors drag nodes onto a canvas and connect them with edges (cycles allowed). Node types: **Start, AI Step, Shell, Loop Decider, Condition (AND/OR), End**. `AND` = sequence (both phases required), `OR` = fallback (try first; on exhaustion, the alternative).
- **App-driven execution engine** (`LoopRunManager`): the app owns the iteration counter, runs Shell nodes, carries context across iterations, and enforces `maxIterations` + timeout. The **end-of-loop decision is a dedicated AI node** ("Loop Decider"), NOT app logic — it returns `{continue|stop, reasoning}` from the goal + iteration history + last node output.
- **Loop lifecycle**: `Draft` / `Published` / `Running`. Only **Published** loops appear in the rail picker. Publishing validates the graph (has Start, has End, has a Decider/exit, no orphan nodes). Editing a Published loop returns it to Draft. A loop currently executing is `Running` and is read-only (shows which project/rail uses it).
- **New `loop` rail mode** (4th mode alongside implement / batch-implement / freestyle). Selecting it reveals: published-loop picker + AI engine (Claude/Codex) + model + reasoning effort. The rail's spec flows into the loop as `{{spec.title}}` / `{{spec.description}}` context.
- **Reasoning-effort selection** (new, does not exist today): real on Codex (`-c model_reasoning_effort=low|medium|high`), soft on Claude (prompt-level, gated by a provider capability flag).
- **Specrails-owned starter templates** (Ship & Green, Verify Pass, CI Watch, etc.) — own text and naming, inspired by common loop patterns; no third-party content is bundled.
- **Analytics**: a new `loop` invocation surface (additive on the per-project AnalyticsPage), a new per-project run-metrics block (iterations, success rate, avg-iterations, distribution), and an extension of the global analytics modal with cross-project loop metrics. All cost/tokens are captured.
- **All user-facing strings** ship in the 8 supported locales; a new `loops` i18n namespace is added and enforced by the key-parity test.
- **Feature flags**: `FEATURE_LOOPS_SECTION` (client) and `SPECRAILS_LOOPS_SECTION` (server), default ON / opt-out, for emergency rollback.

Not breaking: existing rail modes, jobs, analytics surfaces, and providers are unchanged when no loop is used. Single-provider projects and projects that never open Loops behave identically to today.

## Capabilities

### New Capabilities
- `loops-library`: Global storage, CRUD, and Draft/Published/Running lifecycle of loop definitions; the `/loops` section and sidebar entry; feature-flag gating; Specrails-owned starter templates.
- `loop-builder-canvas`: The visual node-graph editor — node types, edge/connection model, AND/OR joins, `{{spec.*}}` variable interpolation, and the publish-time graph validation.
- `loop-execution`: The `LoopRunManager` engine — graph traversal, the AI Loop Decider node contract, Shell node execution, per-iteration context carry, iteration/timeout limits, the per-project `loop_runs` record, and `loop.run_*` WebSocket events.
- `rail-loop-mode`: The 4th rail mode — launch/track/stop integration, the published-loop picker, and binding a run to a rail + spec (ticket release on completion, mirroring the job lifecycle).
- `reasoning-effort`: Per-invocation reasoning-effort selection across providers (Codex native `-c model_reasoning_effort`; Claude soft/capability-gated), threaded through adapters, enqueue options, and the rail header selector.
- `loop-analytics`: The `loop` invocation surface (per-project AnalyticsPage), the per-project loop run-metrics block, and the cross-project loop metrics in the global analytics modal.

### Modified Capabilities
<!-- None: openspec/specs/ is currently empty; rails/analytics behavior changes are captured as new capabilities above. -->

## Impact

- **New dependency**: `@xyflow/react` (React Flow v12, MIT). Verified to install and render under React 19.2.7 (zustand resolves to 4.5.7, no peer conflict, no override); lazy-loaded like Monaco so the main bundle is unaffected.
- **Server (new)**: `loop-run-manager.ts`, `loop-graph.ts`, Loop Decider prompt module, global loops store; `loops-router` on the desktop-router (`/api/loops`, global mount).
- **Server (modified)**: `rails-router.ts` (+`loop` mode, launch/stop branches, `PUT /rails/:i/effort`), `rails-store.ts` (+`reasoning_effort`), `project-registry.ts` (+`railLoopRuns` map, `onLoopRunFinished`), `providers/types.ts` + `claude-adapter.ts` + `codex-adapter.ts` (+effort), `queue-manager.ts` (+effort selection map), `spending.ts` + `desktop-analytics.ts` (+`loop` surface, loop metrics). Reuses `spawn-lifecycle.ts` / `finaliseInvocationResult` / `recordInvocation`.
- **Database**: `desktop.sqlite` — new `loops` table (global definitions + lifecycle). Per-project `jobs.sqlite` — new `loop_runs` table + `loop_run_id` column on `ai_invocations`; new `reasoning_effort` column on `rails`. All additive migrations.
- **WebSocket**: new `loop.run_started` / `loop.run_stopped` / `loop.run_completed` (project-scoped) messages.
- **Client (new)**: `LoopsPage`, `LoopBuilder` (canvas) + node components, `LoopRunDetail`, `RailEffortSelector`, loop picker in the rail header.
- **Client (modified)**: `ArcSidebar.tsx`, `App.tsx`, `feature-flags.ts`, `RailControls.tsx` / `RailRow.tsx` / `RailsBoard.tsx` / `DashboardPage.tsx` (+`loop` mode, effort), `AnalyticsPage.tsx` + `components/analytics/*` + `DesktopAnalyticsPage.tsx`.
- **i18n**: new `loops` namespace × 8 locales; key-parity test must pass.
- **specrails-core**: ZERO coupling. Loops use raw prompts (like freestyle's `_buildFreestylePrompt` → `claude -p`), no slash command, no core-version gate.
- **Coverage**: the react-flow canvas component is excluded from coverage (jsdom-unreachable) with a documented rationale, mirroring the browser-capture precedent; `LoopRunManager` and stores are unit-tested with `:memory:` SQLite to meet the 80% server / 80% client thresholds.
- **Security**: Shell nodes execute arbitrary user-authored commands (`/bin/sh -c` / `cmd /c`) in the project cwd — a real exec surface addressed in design (publish-time acknowledgement + documented trust model).
