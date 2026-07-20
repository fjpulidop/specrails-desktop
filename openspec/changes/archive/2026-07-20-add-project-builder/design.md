# Design — Project Builder

## Context

Every existing spec surface assumes a registered project: `ChatManager` needs a `ProjectContext`, Explore needs a repo to symlink, the setup wizard needs an existing path. The only project-less AI surface in the app today is the **desktop agent chat** (`AgentChatManager` + `agent-cwd-manager.ts` + `agent_conversations`/`agent_messages` in `desktop.sqlite` + app-global WS events). The Project Builder's day-0 chat is architecturally the same animal: an app-level conversational spawn with no `projectId`, streaming over the shared WS bus to all clients.

Everything the orchestrated commit needs already exists as separately-proven pieces:

- **Workspace assemble (offline)**: `workspace-manager.ts` `ensureWorkspace` + `assembleWorkspaceFramework` (bundled framework, symlink/copy), already driven by `SetupManager.startInstall` in the wizard flow.
- **Registry allocation**: `artifact-registry.ts` `resolveArtifacts`/`mirrorProjectEntry` (canonical realpath → slug/workspace, advisory lock).
- **Ticket batch insert**: `ticket-store.ts` `mutateStore` (surgical, locked, collision-safe id allocation).
- **Project registration**: `ProjectRegistry.addProject` → `desktop-db.ts` `addProject` (already exercised by `POST /api/projects` in `desktop-router.ts`).
- **Draft protocol mechanics**: `spec-draft-parser.ts` (`parseSpecDraftBlocks`, last-valid-wins, streaming tail cut) — reused pattern, new block type.
- **PATH/gh resolution**: `path-resolver.ts` bundled node/git/gh; `gh auth` signal from `setup-prerequisites.ts`.

Constraints: repo stays pristine (artifact relocation), coverage gates (80% server / 80% client), i18n ×8, mobile wire-compat untouched.

## Goals / Non-Goals

**Goals:**

- One conversational path from "I have an idea" to a registered project with a reviewed M1 backlog and a bootstrapped git repo.
- Zero disk mutation before the single "Create specs" commit; crash mid-commit never leaves a half-registered project.
- Reuse existing machinery (assemble, ticket store, registry, batch rail) — no parallel implementations.
- M1-only detailed generation (walking skeleton); M2+ deferred to project-level grounded generation.
- Make every detailed Builder item a canonical normal Specrails spec and reject incomplete batches before mutation.

**Non-Goals:**

- No Jira on day 0 (M2+ rides existing spec→Jira machinery unchanged).
- No template/starter-kit gallery — the blueprint is conversational, not a picker.
- No multi-milestone upfront planning (anti-waterfall: M2+ carries titles only).
- No public-repo or non-GitHub remote support in v1 (`gh repo create --private` only, best-effort).
- No editing of an existing project's blueprint via the day-0 Builder (re-entry is read + "Generate M2" only).
- No backfill of day-0 spend into the project ledger after creation.

## Decisions

### D1 — Day-0 chat: dedicated `BlueprintChatManager`, sibling of `AgentChatManager`

A new thin manager reusing `runAiCliInvocation` (spawn→stream→settle core) with its own system prompt (interview discipline, blueprint-draft protocol, generation rules) and its own cwd (`~/.specrails/builder-cwd/`, mirroring `agent-cwd-manager.ts` — always-rewritten instruction file, no `./project` symlink because there is no project). **No MCP wiring** — the Builder has nothing to operate; it only converses and emits fenced JSON.

*Alternatives considered:*
- **Reuse `AgentChatManager` with a "builder mode" flag** — rejected: different system prompt, no tier ladder, no pinned project, no tool activity chips, different draft protocol. The flag would fork half the class; a sibling that shares `runAiCliInvocation` is smaller.
- **Reuse per-project `ChatManager`** — impossible: requires a `ProjectContext` that doesn't exist yet.

Conversations persist in `desktop.sqlite` (new `blueprint_conversations`/`blueprint_messages` tables, additive migration; same shape as `agent_conversations`). Streaming rides new app-global WS types `blueprint.stream` / `blueprint.done` / `blueprint.error` (no `projectId` — fans to all, matching `agent_*` precedent; NOT added to the mobile-ws translation layer).

Provider/model/effort selection mirrors the mission composer: default provider = first enabled adapter, model and `reasoningEfforts` from `/models?provider=`; provider/model persist on the conversation while a catalog-valid reasoning effort rides each `/send`. Providers without the capability receive no effort field.

### D2 — `blueprint-draft` protocol: single block type, full snapshot, atomic detailed generation

Fenced ```` ```blueprint-draft ```` JSON, parsed with the `spec-draft-parser.ts` mechanics (scan all blocks, last **valid** snapshot wins, streaming-tail cut ignores an unterminated block). New pure module `server/blueprint-draft-parser.ts` + shared schema types.

Schema (top-level): `blueprintVersion: 1`, `product {name, pitch, audience}`, `coreFlow`, `platform`, `stack {language, framework, db, notes}`, `assumptions[]`, `milestones[] {id, title, goal, status, plannedSpecs[]}`, `specsComplete`, and `m1Specs[] {kind, title, shortSummary, description, acceptanceCriteria[], priority, labels[], dependsOnIndex?}`. `kind ∈ scaffold|feature|verification`; `priority ∈ low|medium|high|critical`. The version remains 1: readers default absent `specsComplete=false`, kind to `feature`, summary to empty, criteria to `[]`, and absent/invalid priority to `medium`, keeping older persisted blueprints readable while strictness remains at new-commit time.

The parser returns a paired result for each last-valid block: normalized `blueprint` for rendering/compatibility reads and exact pre-coercion `rawBlueprint` for readiness and commit. `blueprint.done` transports both and the client mirrors both. Quality analysis and commit payloads use the raw representation, so an invalid enum, dependency, or missing field cannot be defaulted/dropped into validity. Persisted files intentionally use the other boundary: `readBlueprint()` applies `coerceBlueprint()` server-side so legacy v1 JSON stays readable, returning null only when absent or corrupt.

Growth by phase: interview and Surprise Me turns emit product/coreFlow/platform/stack/assumptions + milestone skeletons with `m1Specs: []` and `specsComplete: false`. Only explicit user approval or a direct request to generate the backlog begins detailed generation. The next assistant response emits ONE full snapshot containing the entire self-validated 5–10-spec M1 walking skeleton and `specsComplete: true`; it never emits a closed partial 2–3-spec snapshot or leaves an incomplete set as the latest commit-ready state. M2+ follows the same atomic-response rule when its target milestone is explicitly generated: every detailed spec for that milestone arrives together in one response/snapshot. Full-snapshot parsing keeps the client stateless and self-healing, while the completion flag makes the atomic review/commit boundary explicit.

Every detailed spec uses exactly the normal Specrails base-description headings, once and in order: `## Problem Statement`, `## Proposed Solution`, `## Out of Scope`, `## Technical Considerations`, `## Estimated Complexity`. Out of Scope and Technical Considerations each contain at least 2 bullets. Acceptance criteria are NOT embedded in that description: a separate array holds 4–10 non-empty independently testable outcomes and the normal persistence helper folds one `## Acceptance Criteria` section into the Board ticket. A spec also has an English action-oriented unique title, a one-sentence summary ≤240 characters, a valid priority, non-empty domain labels, and an optional dependency pointing strictly to an earlier item. The first M1 item is explicitly `kind='scaffold'` and omits the dependency. Day-0 technical considerations reference the planned stack/components/contracts/risks/dependencies without fabricated paths; later-milestone specs may name only paths and identifiers verified from the real project.

*Alternative — delta/patch blocks or partial spec waves*: rejected. Both make the client/review state incremental and allow a dropped or interrupted message to leave an ambiguous partial backlog. One full snapshot at ≤10 M1 specs is an acceptable bounded payload and gives approval, review, and commit a single atomic representation.

Client mirror parser lives in `client/src/lib/blueprint-draft.ts` (same extraction approach as `agent-spec-draft.ts`), feeding the live blueprint panel (5 dimensions ✓/✗ + the complete detailed spec set appearing together when the final fence closes).

### D3 — Orchestrated commit: one endpoint, strict ordering, register-project-LAST

`POST /api/blueprint/commit` (app-level, desktop-router mount) → validates synchronously (name, location writable + empty-or-absent, providers non-empty, exact raw blueprint has 5–10 m1Specs, `specsComplete=true`, and every spec passes the shared rich-spec quality contract) → 202 + streamed progress over `blueprint.commit_progress` WS events (step id + status + optional error), terminal `blueprint.commit_done` / `blueprint.commit_failed`. The pure shared validator checks the raw generated fields before compatibility coercion: complete-set size, exact section presence/order/content, summary, criteria count, priority, labels, unique titles, scaffold-first, and backward-only dependencies, returning stable spec/field-oriented issues. The project commit and the M2+ milestone commit invoke it before ANY filesystem, registry, blueprint, milestone, or ticket-store mutation; prompt compliance and the normalized preview are never integrity evidence.

Ordering (each step names its module):

```
1. mkdir + validate            fs (abort-safe: nothing created on validation failure)
2. git init -b main            bundled git via resolved PATH
   + README.md (from pitch)    deterministic render, no AI call
   + initial commit
3. registry allocate + assemble  mirrorProjectEntry → ensureWorkspace
                                 → assembleWorkspaceFramework (headless, per provider)
4. write blueprint.json + .md    <workspace>/.specrails/ (workspace, NOT repo)
5. insert M1 tickets             mutateStore on <workspace>/.specrails/local-tickets.json
                                 status 'todo', label 'M1', source/creator
                                 'project-builder', generated priority/summary,
                                 domain labels, acceptance criteria folded once,
                                 dependencies mapped, scaffold spec first
6. register project              ProjectRegistry.addProject (LAST)
7. gh repo create --private      best-effort; failure → warning step, never aborts
   --source . --push
```

**Crash posture**: steps 1–5 touch only the target dir + `~/.specrails` (workspace/registry). A crash before step 6 leaves an orphan dir + registry entry but NO project row — the app shows nothing broken; re-running the commit with the same location surfaces "directory not empty" and the user picks a new location or clears it (v1: manual; a sweeper is deferred). A crash AFTER step 6 is an ordinary registered project missing only the GitHub remote.

*Alternative — register project first, then fill in*: rejected. A half-assembled registered project is a zombie visible in the sidebar with broken per-project routes; an orphan directory is invisible and cheap.

*Alternative — client-orchestrated multi-call (like the multi-provider wizard)*: rejected. The wizard client-orchestrates because each provider install streams its own long log; here the steps are fast and atomic-ish, and a single server-side orchestration gives one place for the crash posture.

### D4 — Headless assemble: prefer the bundle, dev fallback only

`SetupManager.startInstall` couples assemble to wizard state (phases, WS `setup_*` events, per-project DB resolution). The Builder needs the same work WITHOUT the wizard. Extract it into a callable `assembleProjectOffline(projectPath, slug, providers[])` that both callers share: the wizard keeps its streaming/phase shell around it; the Builder calls it directly inside commit step 3. The callable PREFERS the bundled core and stays offline when it exists. When no bundle is present in dev or another non-desktop runtime (`SPECRAILS_IS_DESKTOP !== '1'`), it falls back to `npx specrails-core` so local development and runtimes-less builds remain usable. A packaged desktop (`SPECRAILS_IS_DESKTOP='1'`) with a missing/corrupt bundle fails validation early with the reinstall-app error; it SHALL NOT use the network fallback.

### D5 — Blueprint persistence: workspace-resident pair, board-derived progress

`<workspace>/.specrails/blueprint.json` is the source of truth for the day-0/M1 full snapshot (including `specsComplete` and every reviewed M1 rich-spec field) plus the milestone roadmap/status machine (`planned → committed → done`) and advisory `ticketIds`. The version-1 schema has one detailed collection, `m1Specs`; it deliberately has no detailed-M2-per-milestone collection. After an M2+ commit, the target milestone stores only `status='committed'` and its ticket ids, while the inserted tickets are authoritative for the detailed reviewed description/criteria/priority/summary/labels/prerequisites. `blueprint.md` is a deterministic render (pattern: `renderContractLayerMarkdown`) regenerated on every json write, never hand-edited.

Progress shown in the sidebar derives from the ticket board (label `M1`, live statuses), never from stored ticket ids — survives manual ticket edits/deletes. New M1 and M2+ tickets carry `source='project-builder'` and `created_by='project-builder'`, generated priority/short summary/domain labels plus `M<n>`, and mapped prerequisites. Their separate structured criteria are folded exactly once via the normal `formatDescriptionWithCriteria` helper, so the reviewed preview and Board body match apart from that deterministic fold. For compatibility, the board also accepts older Builder rows with `source='manual'` and `created_by='project-builder'`; no persistence migration is required. `ticketIds` remain advisory (deep-link convenience only).

*Alternative — repo-resident `blueprint.md`*: rejected, violates the pristine-repo invariant. The README carries the human-facing pitch; the blueprint is app state.

### D6 — Launch M1 = one `batch-implement` rail

The Builder's final screen (and the sidebar entry) offers "Launch Milestone 1": select all `M1`-labeled `todo` tickets into one rail and launch with the batch factory loop (sequential, single worktree, single PR). Reuses `POST /rails/:i/launch` unchanged — the client places tickets and launches exactly as a human would (rail creation via `POST /rails` if none free). Greenfield M1 specs are chain-dependent; parallel per-ticket rails from a near-empty `main` would each build on nothing.

### D7 — M2+ generation: project-level, Explore-grounded, same protocol

"Generate M2" opens a PROJECT-level `ChatManager` conversation with `kind='milestone'`, seeded with `blueprint.json` + the target milestone's `plannedSpecs`. Its dynamic prompt carries the same detailed payload, exact headings, 4–10 criteria, completion/dependency rules, the one-response/one-complete-snapshot rule, and the stronger later-phase requirement to inspect the real code before naming verified paths/identifiers and to cover behavior, failures/edge cases, and tests. It also defines an explicit read-only boundary: no repository/workspace/ticket/config/git mutation, no write-capable commands/tools, and no builds/tests. For relocated projects it names the real repo absolute path, its `./project` mount, and `SPECRAILS_REPO_DIR`, warning that Read/Grep/Glob paths must not be literal shell-variable expressions.

`ChatManager` passes `toolPolicy='read-only'`. Claude receives plan + safe mode and only `Read,Grep,Glob`; Codex receives its native read-only filesystem sandbox (or `sandbox_mode="read-only"` on resume); Gemini receives `--approval-mode plan` and never `--yolo`. Gemini CLI has no selectable Codex-style filesystem sandbox, so its guarantee is the native approval/policy layer plus the prompt, not an OS/filesystem sandbox; a CLI incompatibility fails the turn rather than retrying under yolo. The complete prompt and blueprint context reach Claude through the system-prompt argument and are folded into the effective user turn for adapters without that argument.

Committing validates the exact raw batch before mutation, inserts authoritative detailed `M<n>` tickets, and changes only the milestone status/advisory ids in the blueprint. On 201, `MilestoneGenerateShell` invokes `onCommitted`; `BuilderSidebarEntry` increments its refresh key, refetches the no-store blueprint, and therefore selects the first later milestone still `planned` for the next Generate CTA.

### D8 — Client shell

- **Chooser**: `AddProjectDialog` gains a pre-screen (two cards: Existing | New). Existing → current flow byte-identical. New → `ProjectBuilderShell`.
- **Builder shell**: full-screen overlay (ExploreSpecShell-inspired): chat left, live blueprint panel right (5 dimension rows ✓/✗, complete detailed spec set revealed atomically after approval, "surprise me" chip on turn 1). Cards expose short summary, priority, and criteria count; the detail modal shows the complete canonical description and separate criteria, for both M1 and M2+. No minimize-to-dock in v1 (no `projectId` to tag the chip with; deferred).
- **Commit form**: name (prefilled from `product.name`), location (default `~/projects/<slug>`), provider multi-select (same component as AddProjectDialog), GitHub checkbox (enabled iff `gh` authenticated per prerequisites signal).
- **Progress view**: streamed step list (reuses the wizard's step-render idiom, not its component).
- **Sidebar entry**: visible in board + mission modes when the active project's workspace has `blueprint.json`; shows per-milestone progress bar + "Generate M2" CTA. A successful milestone commit invalidates/refetches its blueprint and advances the action to the next `planned` milestone.
- i18n: new `builder` namespace ×8 locales.

### D9 — Accounting

Day-0 Builder turns → `recordAgentInvocation` into the app-level `agent_invocations` ledger with `project_id NULL` (established Home-turn precedent). No backfill after creation. M2+ turns record per-project (`ai_invocations`, surface `explore-spec` or the new kind's mapping — pinned at spec time).

## Risks / Trade-offs

- **[SetupManager extraction regressions]** — the wizard is load-bearing; extracting assemble risks subtle behavior drift. → Extraction is mechanical (move + delegate); wizard tests stay green as the guard; bundle selection and the non-desktop npx fallback are covered independently.
- **[Orphan dirs on mid-commit crash]** — step-3–5 crash leaves `~/projects/<slug>` + registry entry with no project row. → Accepted for v1 (invisible, cheap, user-resolvable); commit validation gives a clear "directory not empty" on retry. A startup sweeper is deferred.
- **[LLM emits invalid/oversized or shallow blueprint JSON]** — → last-valid-wins parser (a bad block never destroys the panel); the shared server-side quality validator is the hard gate (`specsComplete`, complete-set size, schema, all canonical fields/sections, 4–10 criteria, scaffold-first, dependency order); prompts pin the complete-set size and make generation self-audit before completion.
- **[gh repo create failures]** (no auth, name taken, network) — → best-effort by design: warning toast, project fully usable, remote addable later by hand. Safe-PR's `local-only` ladder + `merge-local` already cover remote-less projects.
- **[Coverage gates]** — new server surface (manager, parser, commit orchestrator, render) is substantial. → Parser + render + orchestrator are pure/DI-friendly by construction (the commit orchestrator takes an IO bag like `rail-pr-decision.ts` does); chat manager reuses tested `runAiCliInvocation`.
- **[Output-token cost of a complete rich snapshot]** — the post-approval response carries the whole detailed backlog at once. → Bounded by the 10-spec M1 cap (and the target milestone's planned set); accepted to guarantee one atomic review/commit representation rather than exposing partial waves.
- **[Slug/name collisions]** — target dir exists, or registry already maps the realpath. → Commit validation checks both before touching disk; the mini-form suggests `-2` suffixes client-side.

## Migration Plan

Purely additive: new desktop-db migration (blueprint conversation tables), new routes under `/api/blueprint/*`, new WS types, new client surfaces behind the chooser. No existing flow changes shape; the Existing path is byte-identical. Rollback = hide the chooser (client flag `VITE_FEATURE_PROJECT_BUILDER`, server `SPECRAILS_PROJECT_BUILDER`, both default ON / opt-out per house pattern); tables/routes are harmless when unused.

## Open Questions

- `kind` value for M2+ conversations: reuse `'explore'` vs new `'milestone'` (leaning `'milestone'`; decide in specs).
- README content: pure deterministic template from pitch vs one cheap AI call (leaning deterministic — commit must be offline-capable).
- Whether the sidebar entry also surfaces on Home/mission mode project cards or only inside the active project (leaning inside-project only for v1).
