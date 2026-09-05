## Context

**As-built (verified 2026-09-04).** "Launch Milestone 1" chunks the `M1` todo tickets into ≤3-spec rails (`client/src/lib/milestone-launch.ts`) and, in the default *sequential* mode, `client/src/context/MilestoneSequencerContext.tsx` launches chunk 1 and parks chunks 2..n in `localStorage`, polling `GET /rails` every 10 s and launching the next chunk once the previous rail has been observed busy then idle. The server maps the bare `batch-implement` mode to `factory:batch`, allocates a worktree off the **integration branch**, and runs the loop; at settle every spec parks at `on_review` (ask-first PR) and the `rail_pr_deliveries` row waits for a decision.

Four independent defects produce the observed "3 launched, jobs running for hours, 0/8":

1. `loop-factory.ts` sets `aiStepTimeoutMinutes = 0` on every factory loop (untimed by design — implement runs legitimately take 30–60 min). `loop-executors.ts:216/338` therefore arm NO step timer, and the loop's interactive step session arms no inactivity detector (`loop-run-manager.ts:1948`, "byte-parity" with the one-shot path). A provider process that wedges never settles; `stuck-run-detector.ts` only *notifies* (`job.stuck`, ≥10 min floor).
2. `BuilderSidebarEntry.tsx:71` counts `status === 'done'` only, fetches the board only when the flyout opens, and subscribes to nothing. `done` is reachable only via merge, so a delivered milestone reads `0/N`.
3. The sequential plan is browser-local (dies with the window/machine; `observedBusy` can be missed by a sub-10 s failure; no UI states "waiting"), its `sequential.done` toast says "complete" at settle, and — decisive for a greenfield walking skeleton — chunk k+1 is based on the integration branch, not chunk k's delivered branch. Automatic PR continuation (`active-pr-continuation.ts:177`) only applies to tickets already `on_review` in the same set, so it never stacks chunks.
4. `MilestoneStatus` has `'done'` (`blueprint-draft.ts:14`) but no server code writes it; `blueprint.json` stays `committed`.

**Constraints.** specrails is a PR producer, never a merge authority (safe-pr-review-flow) — the chain must not auto-merge. The rails launch handler (`rails-router.ts` `POST /:i/launch`, ~600 lines, ~15 guards) is the single launch authority; every launch door must behave identically. `rail_pr_deliveries` is the single source of truth for delivery state and `transitionDecision` is compare-and-set. Mobile wire compat freezes `hub.*` names; `blueprint.*` events are app-internal and NOT mobile-translated. Coverage gates: 80 % server, 80 % client.

## Goals / Non-Goals

**Goals:**
- A loop AI step can never run forever: inactivity bounds it, the step is retried once by resume, and the failure is structured (`stalled`, reason `idle_timeout`) so narration and the sidebar can say why.
- One server-derived progress model per milestone (counts by state, active rails, deliveries, chain state, derived milestone state) that every surface renders live over WS — zero client-side derivation from stale fetches.
- A sequential launch chain that is durable (SQLite), advances in `onLoopRunFinished`, survives restart, is visible and controllable (pause reason, Resume, Cancel), and **stacks** chunk k+1 on chunk k's delivered branch so the walking skeleton accumulates without waiting for a merge.
- Stacked deliveries converge on merge: accepting a later chunk marks its merged ancestors merged (specs → `done`) instead of leaving phantom `on_review` rows.
- Milestone `done` persisted in the blueprint pair; honest copy everywhere (delivered ≠ done).
- Premium surfaces: segmented bar, per-rail rows with decision + Review, chain row, elapsed time, i18n ×8.

**Non-Goals:**
- Auto-accepting / auto-merging chunk deliveries (violates the PR-producer invariant).
- Changing the ≤3-specs-per-rail cap or the batch factory loop's prompt.
- A generic "stacked PR" product for non-milestone rails (the explicit base-branch launch param is added, but only the chain drives it in this change).
- Replacing `job.stuck` OS notifications with a new notification system.
- Backfilling progress for milestones launched before this change (their deliveries still show; no chain row exists).

## Decisions

### D1. Inactivity watchdog on loop AI steps, not a fixed step timeout

**Choice.** Add an *idle* timer to every loop AI step (one-shot and interactive) keyed on **provider stream activity** — the same touch point that already calls `updateLoopStepActivityCheckpoint` (`loop-run-manager.ts:1054` one-shot, `:1966` interactive). Default `SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS = 30 min`; `0`/`false`/`off` disables; the effective value is clamped to ≥ the stuck-notification threshold (`resolveStuckThresholdMs`) so a notification always precedes teardown. It coexists with the per-step timeout: a step with `aiStepTimeoutMinutes > 0` keeps that hard cap AND the idle bound; factory loops (0) get the idle bound only.

**On fire.** Interactive: `session.abort('stalled: no provider output for Ns')` with a distinct `stalled` flag (not `timedOut`); one-shot: kill the child. The step's `loop_step_end` payload carries `status:'stalled'`, `reason:'idle_timeout'`, `idleMs`. The engine then retries the step ONCE by resume on the captured session id (the interactive/one-shot resume plumbing that already serves crash-restore — `resumeLoopRun` / `isResumeMiss` retry pattern), inside the same step; a second stall fails the step, the run settles `stalled` (→ ticket outcome `canceled` → specs back to `todo` via the existing `loop-run-manager.ts:1834` mapping), the delivery row auto-closes as today.

**Why not a fixed timeout?** 58-minute implement runs are legitimate (profiled 2026-07-21); a fixed cap either kills real work or is so long it is useless. Silence is the actual wedge signal — the QueueManager path already uses exactly this (`WM_ZOMBIE_TIMEOUT_MS`, `zombie-detection` spec). **Why 30 min and not 5?** A claude turn emits nothing while a Bash tool runs (a full test suite is 3–5 min silent; a cold `npm install` can be 10). 30 min is comfortably above any single observed tool call and still bounds the failure to one coffee break. **Alternative rejected:** lowering factory `aiStepTimeoutMinutes` to 60 — still lets a wedge burn an hour and kills legit 61-minute runs.

**Actionable stuck.** `job.stuck` gains `actions: ['stop']`; the client OS/in-app notification path (`useOsNotifications`) renders "Stop run" calling the existing loop stop route. No new route.

### D2. Progress is derived on the server from durable rows, broadcast on mutation

**Choice.** New pure module `server/milestone-progress.ts`: `deriveMilestoneProgress({ blueprint, tickets, deliveries, activeRuns, chains, now })` → `MilestoneProgress[]`. Per milestone: `{ id, n, title, storedStatus, state, counts: { total, done, onReview, inProgress, todo, failed }, rails: MilestoneRail[], chain: ChainSnapshot | null }`. Ticket ↔ milestone by `M<n>` label (unchanged rule). `state` derivation (first match wins): `done` iff `total > 0 && done === total`; `delivered` iff `todo + inProgress === 0 && onReview > 0`; `running` iff `inProgress > 0` or the chain is `running|waiting`; `committed` iff `total > 0`; else the stored status (`planned`). `failed` counts milestone specs currently `todo` whose NEWEST delivery unit (`branches[].implementationOutcome === 'failed'` or `deliveryOutcome === 'blocked'`) failed — "last attempt failed", never a guess. `rails[]` = rails carrying milestone tickets that have an active run (`railLoopRuns`/`railJobs`) or a non-terminal delivery, each with `{ railIndex, name, runId, startedAt, delivery: PrDeliverySnapshot | null, chunkIndex }`.

`GET /:projectId/blueprint` returns `{ blueprint, progress }`. A per-project `MilestoneProgressBroadcaster` (in `ProjectContext`) debounces 150 ms and emits `blueprint.milestone_progress { projectId, progress }` from the chokepoints that already exist: after the ticket-outcome apply in `onLoopRunFinished`/`onJobFinished`, after manual ticket status moves (`project-router-tickets.ts`), after every `rail.pr_state` broadcast, and on chain transitions. It is a no-op for projects without a blueprint (memoized existence check, invalidated by `POST /blueprint/commit` and `commit-milestone`).

**Milestone done persistence.** When derived `state === 'done'` and `storedStatus !== 'done'`, the broadcaster writes `status:'done'` through `writeBlueprintPair` (idempotent, never reverts) and emits `blueprint.milestone_completed { projectId, milestoneId, n }`. Display always uses the DERIVED state, so a manual `done → todo` move is reflected honestly while the blueprint record stays a record.

**Why server-side?** Three surfaces (flyout, Builder done screen, future MCP/agent) must agree, and only the server sees deliveries, active runs and the chain. Client derivation is exactly what produced `0/8`.

### D3. Chain lives in SQLite, advances in `onLoopRunFinished`, launches chunks through the launch authority

**Store.** Migration adds `milestone_launch_chains` (per-project `jobs.sqlite`): `id, milestone_n, milestone_id, mode ('sequential'|'parallel'), chunks JSON, next_chunk, current_rail_index, current_run_ids JSON, current_delivery_id, integration_branch, head_branch, status ('running'|'waiting'|'paused'|'completed'|'cancelled'), pause_reason, launched_ticket_ids JSON, created_at, updated_at` + partial unique index on `(milestone_n) WHERE status IN ('running','waiting','paused')` (one active chain per milestone). `server/milestone-chain-store.ts` owns CRUD with compare-and-set transitions (same discipline as `transitionDecision`).

**Engine.** `server/milestone-chain.ts` `MilestoneChainManager` per `ProjectContext` with an injected IO bag (`launchChunk`, `createRail`, `assignTickets`, `now`, `broadcast`) so unit tests never touch HTTP. `start(n, mode)` prepares chunks exactly like today (todo `M<n>` tickets, ≤3 per chunk, rails named `M<n>` / `M<n> · k`), persists the row, and launches chunk 1 (sequential) or every chunk (parallel — same row, `status` goes straight to `completed` once all launched, so parallel milestones are visible in the same progress model). `onRunSettled(runId, outcome)` — called from `onLoopRunFinished` right after the ticket outcome is applied — matches the run to the chain's `current_run_ids`; on `success` with a delivery `branch`, sets `head_branch` and launches the next chunk; on `no_changes` keeps `head_branch`; on failure/stall/stop → `paused` with `pause_reason` (`chunk_failed|chunk_stalled|chunk_stopped`). After the last chunk settles → `completed`. `resume(id)` relaunches the paused chunk from the current `head_branch`; `cancel(id)` → `cancelled` (in-flight runs are NOT killed — they're ordinary rails).

**Launching a chunk.** The manager calls the app's own REST over loopback with the master token — `POST /rails`, `PUT /rails/:i/tickets`, `POST /rails/:i/launch { mode:'batch-implement', baseBranch }` — through `server/internal-api.ts`, lifted from the MCP tools' `apiCall` (`server/mcp/tools/types.ts`). **Why not call `launchIsolatedRail` directly?** The launch handler is the single authority for ~15 guards (`tickets_in_flight`, `pr_decision_pending`, `rail_ticket_cap_exceeded`, provider/model/effort/profile resolution, PR-mode capture, origin tagging); duplicating that derivation for chunk launches would drift, and hoisting the 600-line handler into a service is a refactor out of proportion. Loopback REST has precedent (every MCP domain tool) and turns every guard's 4xx into a typed chain `pause_reason` (`launch_rejected:<error>`) for free. Startup recovery waits for the HTTP server's `listening` before advancing.

**Startup recovery.** After `_recoverOrphanLoopRuns`, chains in `running|waiting` whose `current_run_ids` are no longer live are re-evaluated from their delivery row: settled → `onRunSettled` replays; missing → `paused` (`run_lost`). Nothing is ever advanced twice (the run id is consumed by CAS).

**Client.** `MilestoneSequencerContext.tsx` and both `localStorage` keys are deleted; `milestone-launch.ts` collapses to `POST /:projectId/blueprint/milestones/:n/launch { mode }` (+ `resume`/`cancel` on `/chains/:id`). The Sequential | Parallel toggle stays and rides the body. Legacy `localStorage` plans found on load are dropped (they reference runs the server already settled; the chain row is authoritative from now on).

**Kill switch.** `SPECRAILS_MILESTONE_CHAIN=false` ⇒ the launch route runs `mode:'parallel'` regardless (every chunk at once from the integration branch — the pre-change parallel behaviour) and no chain row is written.

### D4. Stacking = explicit base branch on the ordinary launch path

**Choice.** `POST /rails/:i/launch` accepts optional `baseBranch` (validated by `isValidBranchName`, must resolve locally via `git rev-parse --verify`, 400 `invalid_base_branch` otherwise; ignored with a 400 `base_branch_requires_isolation` when the launch would not take the isolated path). `launchIsolatedRail` threads it as `resolveIntegrationBranch({ explicit })` — the `explicit` source already exists and is documented as "launch-time-chosen override, left untouched by the origin fetch policy". The delivery row records `base_branch = baseBranch`, so `deliverRailAsPr` creates a **stacked PR** (`gh pr create --base <chunk-k-branch>`) when gh/remote exist, and `merge-local` merges the chunk head into the integration branch (which by then contains chunk k if it was accepted first — a clean fast-forward-style merge — or brings chunk k along if not).

**Ancestor sweep.** After any `merged` transition (`rail-pr-decision.ts` merge-local + poll-merge paths), `sweepMergedAncestors(deps, mergedRow)` looks at non-terminal deliveries of the SAME milestone chain whose unit `finalSha` is an ancestor of the integration branch (`git merge-base --is-ancestor <sha> <integration>`) and transitions each → `merged` through the same CAS + ticket effect + Jira `onRailMerged(…, null)` path. Scope is deliberately chain-local: a general "any ancestor delivery" sweep is a separate decision.

**Discard of a stacked head.** `discard` on a delivery that later chunks build on is allowed (the existing action) but the decision surfaces show a "later rails build on this" note; the chain pauses (`head_discarded`) when the discarded row is its current head, and Resume relaunches that chunk from the previous head.

**Why stack rather than wait for merge?** Waiting for merge makes the chain attended (a human must Accept between every chunk) and, without a remote, requires the user's checkout to sit clean on the integration branch each time — the opposite of "launch and come back". Stacking keeps the chain unattended, keeps every chunk's own review packet, and needs no new merge authority. **Why not one cumulative branch/PR for the whole milestone?** It would collapse N review packets into one and fight the per-launch delivery state machine (one row per launch); stacking reuses that machine unchanged.

### D5. Surfaces

- `useMilestoneProgress(projectId)` hook: initial fetch of `/blueprint`, then `blueprint.milestone_progress` / `blueprint.milestone_completed` over the shared WS, filtered by `projectId` via ref (project conventions). `useProjectCache`-backed so a project switch shows the cached progress instantly.
- `MilestoneProgressBar` (segmented: `done` success, `onReview` warning, `inProgress` info + pulse, `failed` destructive, `todo` muted) with a legend on hover; `MilestoneRailRow` (rail name, state pill reusing `PrDecisionPill`, elapsed via the 1 s ticker pattern from `JobStatusPanel`, **Review** → `/review/:prDeliveryId` when the packet flag is on else the rail on the dashboard); `MilestoneChainRow` ("Sequential · rail 2 of 3 · waiting for rail 1", pause reason, Resume / Cancel).
- The sidebar flyout (`BuilderSidebarEntry`) widens to 320 px, renders the bar + rows per milestone, keeps Launch (with the mode toggle) and Generate M<next>, and no longer fetches on open — it reads the hook.
- The Builder done screen (`BuilderConversation` phase `done`) shows the same live milestone card after Launch instead of exiting immediately; "Open the project" remains the exit.
- Toasts: `milestone.launched` (chunk/rail framing), `milestone.chunkLaunched`, `milestone.paused` (with reason, action Resume), `milestone.delivered` ("M1 delivered — 8 specs waiting for review", action Review), `milestone.completed`. The old `sequential.done` "complete" copy is removed.
- i18n: `builder:progress.*`, `builder:chain.*`, `jobs:stuck.stop` ×8.

### D6. One premium spec contract, shared by the three spec authors

**Choice.** `server/spec-contract-prompt.ts` exports the contract once — a full markdown form (for instruction files / prompt bodies) and a compact one-paragraph form (for `--system-prompt` channels) — and the three authors import it: the day-0 Builder (`blueprint-operator-prompt.ts`), M2+ milestone generation (`chat-manager.ts` `_buildMilestoneSystemPrompt`) and the agent super-spec mode (`agent-operator-prompt.ts`). Grounding rules stay per author (day 0 = *planned* artifacts explicitly labelled as such, never claims about existing files; M2+/agent = only verified paths), the depth bar does not.

**The bar.** Problem Statement: 3–5 sentences (persona, trigger, pain today, why it belongs in this milestone, what "good" looks like). Proposed Solution: a numbered user journey, then `###` sub-blocks — *User experience* (screens/states incl. empty, loading, error, success), *Data model* (entities, fields, types, constraints), *Interfaces & contracts* (routes/commands/events with request/response shapes), *Planned modules* (responsibility per module, marked planned at day 0), *Key decisions* (2–3 with the rejected alternative). Out of Scope: ≥3 bullets, each what + why deferred + where it lands. Technical Considerations: ≥5 labelled bullets from a fixed menu (Architecture, Data & contracts, Failure handling & edge cases, Security & privacy, Performance & limits, Observability, Testing strategy with named scenarios, Dependencies by spec title, Risks & mitigations). Estimated Complexity: level + 1–2 sentences + the main uncertainty. `acceptanceCriteria`: 6–10 Given/When/Then-shaped outcomes covering the happy path, ≥1 failure/edge case, ≥1 automated verification (and an empty-state/accessibility criterion for UI specs). `###` sub-headings are safe: both gates match `^##[ \t]+` only, so a third `#` never counts as a canonical section.

**Why not just a longer example?** Models mirror the example AND the floor; with "at least two bullets" the floor became the ceiling. The contract now states targets, the example shows them, and the gate enforces the floors (D8).

### D7. App-driven batched generation (the structural fix)

**Problem.** The single-response contract ("emit all 5–10 specs in one snapshot") caps per-spec depth by the output budget; a premium spec is ~600–900 words, ten of them do not fit, and the `truncated` repair told the model to *tighten to the essentials* — institutionalising thin specs.

**Choice.** After approval the Builder emits an **outline** snapshot: every spec with `kind/title/shortSummary/priority/labels/dependsOnIndex` filled, `description: ""`, `acceptanceCriteria: []`, `specsComplete: false`. `BlueprintChatManager` recognises it (`isOutlineSnapshot`: ≥ min specs, every description empty) and drives resumed **continuation turns** on the same session: `APP CONTINUE: write the full premium detail for specs k..k+1` (two per turn, `SPECS_PER_DETAIL_TURN = 2`), each answered with one fenced `spec-detail { index, spec }` block per spec — **as-built delta:** small PATCHES merged by index (`mergeSpecDetails`), not a re-emitted full snapshot, so the reply size stays constant however many specs are already written and an earlier spec can never be silently rewritten; one `APP CHECK` re-ask per unfilled range; then ONE **audit turn** (`APP AUDIT`) answered with a `spec-audit { specsComplete, issues, fixes }` block (fixes merge the same way; a verdict with zero fixes still applies; `false` + issues ⇒ ONE corrections turn of `spec-detail` patches for the affected specs). The existing quality-repair turn still runs after the audit turn when the gate disagrees, and its reply may be patches too. Bounds: `MAX_GENERATION_TURNS = 8` (outline + 5 detail turns for 10 specs + audit + repair); a detail turn that still leaves its target specs empty after the re-ask, or whose spawn fails, HALTS the drive (partial snapshot persisted, `specsComplete:false`, `generationHalted` on the final frame) and the panel offers **Continue generating** — the manual `repair-snapshot` route resumes from the next unfilled range on the same session (`kind:'resume'`, turn ordinal re-derived from what is written) whenever no rejection is pending and unfilled specs remain. Each turn persists its snapshot and broadcasts `blueprint.done { continuing: true, generation: { phase, from, to, total, turn, totalTurns } }` so the panel fills progressively; the client keeps `busy` until the final done. A new `blueprint.generating` message announces each phase for the progress surface ("Writing specs 3–4 of 8…", real ratio). Providers without `capabilities.nativeResume` receive a `GENERATION MODE: single response` line in the per-turn prompt and keep today's behaviour (the manager never drives continuation without a resumable session).

**Why in the manager, not the prompt?** The prompt cannot make the model send itself a second turn; only the app can, and it already owns the repair-turn precedent. Cost is N/2+2 turns per generation — the user explicitly accepted the effort for the quality.

### D8. Raised deterministic floors (server gate + client mirror)

Floors become: Problem Statement ≥ 200 chars, Proposed Solution ≥ 500 chars, Out of Scope ≥ 3 bullets, Technical Considerations ≥ 5 bullets, 6–10 criteria, each criterion ≥ 20 chars. New issue codes `section_depth` (heading, min chars) and `section_bullets` now carry `min`; `criteria_count` params carry the new bounds; i18n `builder:quality.*` ×8 updated. Legacy snapshots resumed under the old bar fail the audit and are healed by the existing quality repair turn — no data loss. Coverage semantics (failure case / test criterion) stay prompt guidance: regex heuristics would produce repair loops on legitimate prose.

### D9. Wave checkpoints (`autoAdvance`)

**Choice.** `milestone_launch_chains.auto_advance` (default 1 for API callers; the UI sends the user's stored preference, default OFF = checkpoint) + a new non-terminal chain status `awaiting_approval`. On a successful chunk settle: `auto_advance` ⇒ advance (unchanged); else ⇒ record the head, set `awaiting_approval` (next chunk NOT launched), broadcast `milestone.chain_changed`. `resume` accepts `paused | awaiting_approval`; `PATCH /:projectId/blueprint/chains/:id { autoAdvance }` flips the flag and, when turning it on while `awaiting_approval`, advances immediately. `listActiveChains` and the one-active-chain index include the new status; `chainIsLive` stays running|waiting (the milestone is not "running" at a checkpoint — the chain row is what says "waiting for your go"). Surfaces: the chain row shows "Rail k delivered — launch the next rail?" with **Launch next rail** / **Continue automatically** (toggle, PATCH) / **Cancel**; the launch controls carry the same toggle; the app toast for a checkpoint offers Launch next + Auto-continue. Failure pauses (`paused`, D3) are unchanged — a checkpoint is only reached by success.

**Why a status and not a paused reason?** `paused` means something went wrong and Resume retries the SAME chunk; a checkpoint is healthy and Launch next starts the NEXT chunk. Conflating them would mislabel the recovery copy.

## Risks / Trade-offs

- [Idle watchdog false positive on a very long silent tool call] → 30 min default clamped ≥ stuck threshold, env raise, retry-once by resume preserves the worktree and session so no work is lost; the stall reason is visible in narration.
- [Loopback launch depends on the HTTP server being up] → chain advances only run in a listening server; startup recovery is gated on `listening`; IO is injected for tests.
- [Chunk k+1 based on an unmerged branch the user later discards] → chain pauses `head_discarded`; Resume relaunches from the previous head; decision surfaces warn before discarding a stacked head.
- [`base_branch` recorded as a feature branch confuses consumers assuming the integration branch] → `rail_pr_deliveries` already carries `base_branch` per row and every consumer reads it from the row; the review packet states the base explicitly.
- [Ancestor sweep marks a delivery merged that the user meant to review separately] → scoped to chain-local deliveries whose head is PROVABLY an ancestor (`merge-base --is-ancestor`); the packet/strip show "merged as part of M1 · 3".
- [Progress broadcast storms during batch ticket updates] → 150 ms debounce per project; payload is the whole milestone array (small).
- [Parallel-mode chunks still branch from the integration branch] → documented; the mode toggle copy says "independent rails (no stacking)".
- [Batched generation costs N/2+2 turns and the resumed context grows] → bounded by `MAX_GENERATION_TURNS`; two specs per turn keeps each output well under the limit; the user accepted the cost for the depth.
- [A detail turn ignores its instruction and rewrites earlier specs] → every turn is a full snapshot and the manager only checks that the TARGET specs became non-empty; the final gate still audits everything, and the audit/repair turns fix regressions.
- [Raised floors reject legitimately short specs (a tiny verification spec)] → floors are modest (200/500 chars, 3/5 bullets) and the quality repair turn asks the model to enrich rather than failing the commit.
- [A checkpoint left unattended blocks the milestone silently] → the chain row, the sidebar pill and a persistent toast all show "waiting for your go"; the flag can be flipped to auto at any time.

## Migration Plan

1. Additive migration `milestone_launch_chains`; no changes to `rail_pr_deliveries`.
2. Ship server first: watchdog (env default on), progress endpoint enrichment (additive field), chain routes. Old clients keep working (they ignore `progress`, still launch chunks client-side — their `baseBranch`-less launches are plain rails).
3. Ship client: delete the sequencer, switch launches to the chain route, new surfaces.
4. Rollback: `SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS=0` (no teardown), `SPECRAILS_MILESTONE_CHAIN=false` (parallel launch, no chain rows). Progress derivation has no switch — it is read-only.

## Open Questions

- Threshold value: 30 min is the recommendation; revisit once `run-duration-stats` has per-STEP bands (today only per-run).
- Whether the general (non-chain) ancestor sweep should exist for any stacked/explicit-target delivery — deferred, separate change.
