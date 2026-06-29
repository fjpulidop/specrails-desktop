## Context

Rails today launch a spec in one of three modes (implement / batch-implement / ultracode), each a single AI-CLI invocation that runs to completion once. There is no iterative, self-correcting execution and no reusable notion of a "workflow". This change adds **Loops**: a global library of visually-authored, app-governed iterative workflows, plus a 4th rail mode that runs a published loop against the dragged spec.

Current building blocks this design reuses (verified against the codebase):
- `spawn-lifecycle.ts` `runAiCliInvocation(hooks)` — spawn → stream → settle, timeout + treeKill, captures `sessionId`; `result-event.ts` `finaliseInvocationResult` — tokens/cost/model extraction; `ai-invocations.ts` `recordInvocation` — analytics rows + `spending.invalidated` broadcast.
- Provider adapters (`buildArgs`/`parseStreamLine`), with `--resume <sessionId>` (Claude + Codex) for cross-iteration context, and persistent-stdin (`InteractiveJobSession`, Claude only).
- The rail lifecycle: `rails-router.ts` launch/stop, `project-registry.ts` `railJobs` map + `onJobFinished` (ticket release + broadcast), `RailControls`/`RailRow`.
- Global app surfaces mounted on the desktop-router (`/api/*`) + `desktop.sqlite`; the global analytics modal (`desktop-analytics.ts` iterates project DBs).
- The `@dnd-kit` + Monaco lazy-load + i18n (8 locales, key-parity) + coverage-exclusion (browser-capture) precedents.

Constraint confirmed by spike: `@xyflow/react@12.11.1` installs and renders under React 19.2.7 (zustand → 4.5.7, no peer conflict). Constraint confirmed by code map: a `loop` mode requires **zero specrails-core changes** (raw prompts, like ultracode).

## Goals / Non-Goals

**Goals:**
- A global, cross-project library of reusable loops with a Draft/Published/Running lifecycle.
- A node-graph visual builder (n8n-style) that is genuinely easy for 3–5 node linear-with-cycle loops.
- An **app-driven** execution engine that owns iteration count + timeout, where the stop/continue decision is made by a dedicated AI node ("Loop Decider"), not by app heuristics.
- A 4th `loop` rail mode that runs a published loop against the dragged spec, on Claude or Codex, with model + reasoning-effort selection.
- Full cost + run-metric measurability in both the per-project and the global analytics dashboards.
- Internationalization across all 8 locales; clean opt-out via feature flags.

**Non-Goals (this change):**
- Event-triggered loops (git-commit / file-edit hooks) — manual launch only in v1.
- True branching graphs beyond AND-sequence / OR-fallback (tree/DAG editor deferred).
- Importing/scraping loops live from loops.elorm.xyz — starter templates are Specrails-owned and bundled.
- Per-rail override of a loop's internal config (e.g. its commands) — deferred.
- Committing loops to a repo for team-sharing via git — loops are a personal global library in v1.

## Decisions

### D1 — App-driven engine (not prompt-assembly)
The engine (`LoopRunManager`) owns the iteration loop, runs Shell nodes, and enforces `maxIterations`/timeout. **Alternative considered**: assemble one rich kickoff prompt and let the agent self-loop (faithful to loops.elorm.xyz, near-zero new infra). **Rejected** because the user requires *serious* loops with guaranteed iteration control and supervised, visible iterations — which a single self-looping prompt cannot guarantee.

### D2 — The end-of-loop decision is a dedicated AI node
A "Loop Decider" node is an AI invocation that receives the goal + iteration history + last node output and returns `{ continue | stop, reasoning }`. **Alternative considered**: app-evaluated exit conditions (shell exit code 0, stdout regex). **Rejected as the primary mechanism** because the user explicitly wants the decision reasoned by AI (handles ambiguous outputs like "1 flaky test"). Shell exit codes still feed the Decider as input.

### D3 — `@xyflow/react` for the canvas
Chosen for node + edge + cycle + pan/zoom semantics. **Alternatives**: `@dnd-kit` (already present — but lists only, cannot express edges/cycles), a hand-rolled SVG canvas (high effort), `rete.js`/`cytoscape` (heavier / non-idiomatic React). React-19 compatibility was the one open risk; a spike confirmed clean install + render. Lazy-loaded behind the `/loops` route (Monaco precedent) so the main bundle is unchanged.

### D4 — Loop definitions are GLOBAL; runs are PER-PROJECT
Definitions live in `desktop.sqlite` (`loops` table) because a loop is a reusable recipe, not a project asset (mirrors framework/themes/language). A loop **run** is bound to a project + rail + spec, so it persists in that project's `jobs.sqlite` (`loop_runs`). **Alternative**: per-project loop definitions (like profiles) — rejected: forces re-creation per project and conflicts with the global-library UX the user chose.

### D5 — A Loop Run is its own entity, AND is surfaced as an inspectable Job (REVISED)
`LoopRunManager` owns the run lifecycle (separate from `QueueManager`), tracked per-rail via `railLoopRuns` + `onLoopRunFinished` (ticket-release + broadcast machinery reused). **However**, the run is ALSO backed by a job row (`jobs` table, `id === runId`) and streams its full session (AI text + tool use, Shell stdout/stderr, Decider reasoning, per-node headers) as live `log` WS messages + persisted events, settling via `finishJob` + `job.finalized`. **This reverses the original "run ≠ job" decision**: hands-on testing showed a run with no job row + no log view is impossible to inspect, and the product requirement (from the very first ask: "veremos el comando ejecutándose con todas las instrucciones") is to watch the session live — exactly like `implement`/`ultracode`. The engine still drives the iteration (it is not a QueueManager job); the job row is the visibility/log surface. Cost lives in both `ai_invocations` (`surface='loop'`, per-project analytics) and the job row (global modal, jobs-based) — different dashboards, not summed in one view, so no single-view double-count.

### D6 — Cross-iteration context via session resume (default), persistent-stdin optional
Default: spawn per iteration with `--resume <sessionId>` (works for **both** Claude and Codex). **Alternative/optional fast-path**: one persistent-stdin child (`InteractiveJobSession`) for Claude only, gated on `capabilities.persistentStdin`. Resume is the multi-provider baseline; persistent-stdin is a latency optimization, not required for v1 correctness.

### D7 — Reasoning effort: native on Codex, soft + capability-gated on Claude
Add `reasoning_effort` to `SpawnOptions` and `supportsReasoningEffort` to `ProviderCapabilities`. Codex emits `-c model_reasoning_effort=<value>`. Claude headless has no native flag → the selector is gated by the capability (hidden or applied softly at prompt level); it MUST never emit an invalid CLI flag. **Alternative**: Claude-only or omit effort — rejected, the user requires effort selection across providers.

### D8 — Starter templates owned by Specrails (agent-driven verification)
Templates are authored from scratch (own text + own naming) inspired by common patterns; loops.elorm.xyz content is not copied. Conceptual patterns are not copyrightable; this avoids any licensing dependency and lets templates be native (use `{{spec.*}}`, `{{cmd:*}}`, the Decider node, etc.).

**Verification is agent-driven, NOT hardcoded Shell (revised 2026-06-25, per user).** The starters are composed of PROMPT pieces (AI steps) — they do NOT embed a Shell node with a fixed `npm test`. A hardcoded command is brittle (a real run on a vitest project where `npm test` didn't exist looped forever: shell exit 1 → Decider "continue" → re-implement → repeat, burning ~$3). Instead a new `{{cmd:verify}}` curated command tells the AGENT to detect the project's tooling and run the right verification (`npx vitest run` / `pytest` / `cargo test` / …), fix on failure, and end with `VERIFICATION: PASS|FAIL` — which the Decider reads. The `aiLoopGraph` helper builds the chain; the Decider's "continue" edge loops back to the LAST (verify/fix) step so a retry never re-runs the expensive implement. The Shell node TYPE still exists for power users; the starters just don't depend on it. Works on any stack, no `npm test` assumption.

### D9 — Surface placement & sidebar
A global "Loops" entry sits ABOVE the project list in `ArcSidebar` with a separator below it, opening a full-page `/loops` surface (a canvas needs full width — not the `max-w-5xl` Analytics-style modal). Gated by `FEATURE_LOOPS_SECTION` / `SPECRAILS_LOOPS_SECTION`.

### D10 — AI Step authoring: magic-token palette + RAIL governs provider/model/effort
The AI Step inspector exposes a **token palette** (draggable + click-to-insert chips), grouped by category, instead of asking the user to hand-type tokens. Two token kinds, resolved in this ORDER by the engine: `expandCommands()` FIRST, then `interpolateSpec()`.
- **Data tokens** `{{spec.<field>}}` — substitution of the launch ticket's fields. `interpolateSpec` is now GENERIC (any field on `LoopSpec`: title, description, **id**, status, priority, labels, jira_key, jira_url), and `getTicketSpec` returns them all. Arrays join with ", "; null/unknown → "".
- **Command tokens** `{{cmd:<name>}}` — expand (catalog `server/loop-command-catalog.ts`, open/append-only) to either a **native specrails-core slash command** (a `coreCommand`, resolved PER PROVIDER) or a provider-invariant curated `template`. The bundled `implement` is a **native** command: `expandCommands(text, { provider, specId })` emits the SAME invocation the rail uses — claude `/specrails:implement #<id> --yes`, codex `$implement #<id> --yes` (codex has no `/ns:cmd` parser → the scaffold's `$<name>` skill, mirroring QueueManager's translation), gemini `/specrails:implement …`. The loop spawns it via the `rail-job` action (`claude -p "/specrails:implement #4 --yes"`), so the actual core pipeline runs — NOT a paraphrased prompt. **Trade-off (reverses the earlier B2 decision, per explicit user request 2026-06-25):** a native `coreCommand` REINTRODUCES specrails-core coupling (the command must be installed in the spawn cwd) and is provider-specific; this is accepted for fidelity ("ejecutar el `/specrails:implement` real"). `template` commands remain zero-coupling for cases that don't need the pipeline. Expansion runs FIRST (injects `#<id>`), then `interpolateSpec()` resolves remaining `{{spec.*}}`.

**`batch` deliberately NOT a command:** a loop run is scoped to ONE ticket (per-ticket, like ultracode), so `batch` (multi-spec) would degenerate to `implement`. True batch = a future multi-spec loop SHAPE, not a prompt token.

**Provider / model / reasoning effort are removed from the AI Step (and every) node — the RAIL governs them for the whole run** ("lo que pongamos en el rail manda"). The engine uses `req.provider/model/effort` only; node-level overrides are dropped. A per-node cheap-model override (e.g. Haiku decider) is a deferred advanced option.

## Risks / Trade-offs

- **react-flow × React 19** → Mitigated/closed: spike confirmed `@xyflow/react@12.11.1` installs (zustand 4.5.7, no override) and renders under React 19.2.7. Pin the version; re-verify on dependency bumps.
- **Shell node executes arbitrary commands** → Real exec surface. Mitigation: commands run in the project cwd via `/bin/sh -c` / `cmd /c` (pipes, no PTY), the trust model is "the loop author is trusted", and publishing a loop that contains Shell nodes requires an explicit acknowledgement. Reuse `win-spawn`/treeKill.
- **Loop Decider reliability (parsing its decision)** → A malformed decision could hang the loop. Mitigation: strict structured-decision contract; if the decision can't be parsed, treat as "continue" but always bounded by `maxIterations` + timeout as the hard stop.
- **Context-window growth across iterations** → Long runs accumulate history. Mitigation: carry session via `--resume` (CLI manages context) and cap/trim the explicit iteration-history injected into the Decider.
- **Canvas not unit-testable in jsdom** → react-flow needs DOM APIs absent in jsdom. Mitigation: exclude the canvas component from coverage with a documented rationale (browser-capture precedent); unit-test `LoopRunManager`, stores, graph validation, and the Decider parser with `:memory:` SQLite to hold the 80%/80% thresholds.
- **Windows shell quoting / signal propagation** → `cmd /c` re-parses and may orphan grandchildren on kill. Mitigation: reuse the `cli-prompt.ts`/`win-spawn` patterns and treeKill escalation.
- **Scope creep toward a full workflow engine** → Mitigation: Non-Goals fence triggers, branching, and import; v1 is manual-launch, AND/OR only.

## Migration Plan

All schema changes are additive:
- `desktop.sqlite`: new `loops` table (id, name, status, graph JSON, timestamps).
- per-project `jobs.sqlite`: new `loop_runs` table; new `loop_run_id` column on `ai_invocations`; new `reasoning_effort` column on `rails`.
- New WS message types `loop.run_started|stopped|completed` (additive to the union).
- New i18n `loops` namespace × 8 locales.

Rollback: set `SPECRAILS_LOOPS_SECTION=false` (404s the routes, hides the section) and/or `FEATURE_LOOPS_SECTION=false`. Existing rows/tables remain inert and harmless. No existing surface changes behavior when no loop is used.

Sequencing (also reflected in tasks): F0 react-flow/React-19 spike (done) → F1 global store + section → F2 canvas builder → F3 engine + Decider + Shell + loop_runs + WS → F4 rail loop mode + effort → F5 analytics + i18n → F6 starter templates.

## Open Questions

- Should the rail expose a per-launch override of a loop's `maxIterations` / a Shell command, or keep the loop definition authoritative? (Leaning authoritative for v1.)
- Persistent-stdin fast-path (D6) — ship in v1 for Claude, or defer until resume-per-iteration is proven?
- Loop Decider model: always inherit the rail's model/effort, or allow a cheaper dedicated model for the decision node?
- Do we surface a standalone "run loop on project" path (no spec) in a later version for repo-level loops (CI Watch, Deploy Check)? Deferred, but the engine should not assume a spec is always present.
