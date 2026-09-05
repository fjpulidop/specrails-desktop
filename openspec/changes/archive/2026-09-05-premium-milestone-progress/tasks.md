## 1. Loop step idle watchdog (server)

- [x] 1.1 Add `resolveLoopStepIdleTimeoutMs(env)` in `server/loop-constants.ts` (default 30 min; `0|false|off` disables; clamp ≥ `resolveStuckThresholdMs()` with a one-time warning) + unit tests
- [x] 1.2 Thread `idleTimeoutMs` through `loop-executors.ts` (`runAiStep` one-shot + `planInteractiveAiStep`) alongside `aiStepTimeoutMs`
- [x] 1.3 One-shot path: arm/reset an idle timer on every stream line next to the `updateLoopStepActivityCheckpoint` call (`loop-run-manager.ts` ~1054); on fire kill the child with a `stalled` marker
- [x] 1.4 Interactive path (`_runInteractiveAiStep`): arm/reset the idle timer on every session event (~1966); on fire `session.abort()` with a distinct `stalled` flag (not `timedOut`); clear on settle
- [x] 1.5 Persist `loop_step_end { status:'stalled', reason:'idle_timeout', idleMs }`; extend `LoopStepEndEventPayload` + client `loop-log-model.ts` / `narration-model.ts` to render the stall milestone
- [x] 1.6 Retry-once by resume inside the same step (reuse the resume-miss plumbing; emit `loop_step` with `attempt: 2`); second stall → step fails, run outcome `stalled`
- [x] 1.7 `job.stuck` payload gains `actions: ['stop']`; `useOsNotifications` renders "Stop run" → existing loop stop route; i18n `jobs:stuck.stop` ×8
- [x] 1.8 Tests: `loop-run-manager.test.ts` (timer arm/reset/fire one-shot + interactive, retry-once, second stall settles, disabled = no timer, clamp), `stuck-run-detector.test.ts` payload, client notification action test
- [x] 1.9 Docs: `docs/internals/interactive-jobs.md` § watchdog, `CLAUDE.md` Interactive jobs loop-path bullet (replace "the loop's ai-step timeout is the sole watchdog")

## 2. Milestone progress model (server)

- [x] 2.1 `server/milestone-progress.ts`: pure `deriveMilestoneProgress({ blueprint, tickets, deliveries, activeRuns, activeJobs, chains, now })` → `MilestoneProgress[]` (counts, `failed` from newest delivery unit, rails, chain snapshot, derived `state`) + exhaustive unit tests (delivered ≠ done, partial launch, failed attempt, manual regression)
- [x] 2.2 `GET /:projectId/blueprint` returns `{ blueprint, progress }` (project-router); reads deliveries via `rail-pr-store`, active runs via `railLoopRuns`/`railJobs`
- [x] 2.3 `MilestoneProgressBroadcaster` on `ProjectContext` (150 ms debounce, memoized blueprint-existence check invalidated by `/blueprint/commit` + `commit-milestone`); WS type `blueprint.milestone_progress` (+ `blueprint.milestone_completed`) added to `ws-types`, NOT mobile-translated
- [x] 2.4 Wire broadcast triggers: after ticket outcome apply in `onLoopRunFinished` + `onJobFinished` (`project-registry.ts`), manual status moves (`project-router-tickets.ts`), every `rail.pr_state` broadcast (`rail-pr-store`/`rail-pr-decision`), chain transitions
- [x] 2.5 Milestone `done` persistence: when derived `done` and stored ≠ `done`, write via `writeBlueprintPair` (idempotent) + `blueprint.milestone_completed`; `blueprint-render.md` output reflects the status
- [x] 2.6 Tests: route shape, broadcaster debounce/no-blueprint silence, done persistence idempotence

## 3. Milestone launch chain (server)

- [x] 3.1 Migration: `milestone_launch_chains` table + partial unique index (one non-terminal chain per milestone); `server/milestone-chain-store.ts` CRUD with CAS transitions + tests
- [x] 3.2 `server/internal-api.ts`: lift the loopback master-token client from `server/mcp/tools/types.ts` `apiCall` (shared by MCP tools + chain) + tests
- [x] 3.3 `server/milestone-chain.ts` `MilestoneChainManager` (DI IO: `launchChunk`, `createRail`, `assignTickets`, `now`, `broadcast`): `start(n, mode)`, `onRunSettled(runId, outcome, delivery)`, `resume(id)`, `cancel(id)`, `recoverOnStartup()`; chunking reuses the ≤3 rule + `M<n> · k` naming; pause reasons per spec
- [x] 3.4 Routes (project-router): `POST /blueprint/milestones/:n/launch { mode }` (202 / 409 `chain_active` / guard passthrough), `POST /blueprint/chains/:id/resume`, `POST /blueprint/chains/:id/cancel`; kill switch `SPECRAILS_MILESTONE_CHAIN=false` ⇒ parallel, no row
- [x] 3.5 Hook `chainManager.onRunSettled` into `onLoopRunFinished` after the ticket outcome apply; startup recovery after `_recoverOrphanLoopRuns`, gated on HTTP `listening`
- [x] 3.6 Explicit base branch: `POST /rails/:i/launch` accepts `baseBranch` (validate `isValidBranchName` + `git rev-parse --verify`; 400 `invalid_base_branch` / `base_branch_requires_isolation`); `IsolatedLaunchInput.baseBranch` → `resolveIntegrationBranch({ explicit })`; delivery row records it as `base_branch`; `deliverRailAsPr` uses `--base <base_branch>`
- [x] 3.7 Stacking in the chain: chunks ≥2 pass `baseBranch: head_branch`; `head_missing` pause when the branch no longer resolves; `head_discarded` pause when the head delivery is discarded (`rail-pr-decision` discard path notifies the chain)
- [x] 3.8 Ancestor sweep: `sweepMergedAncestors(deps, mergedRow)` in `rail-pr-decision.ts` after merge-local + poll-merge `merged` transitions (chain-local, `git merge-base --is-ancestor <finalSha> <integration>`, CAS + ticket effect + Jira `onRailMerged(…, null)`)
- [x] 3.9 Tests: chain manager (sequential advance, parallel completes, pause on failure/stall/stop/launch_rejected, resume, cancel leaves runs, restart replay exactly once), routes, base-branch validation, stacked `base_branch` recorded, ancestor sweep (merged ancestor / unrelated untouched)
- [x] 3.10 MCP: `specrails_rails(launch)` documents `baseBranch`; operator prompt unchanged otherwise

## 4. Client: retire the browser sequencer, new launch client

- [x] 4.1 Delete `client/src/context/MilestoneSequencerContext.tsx` + its App.tsx mount; drop the legacy `localStorage` plan key on load; keep `readMilestoneLaunchMode`/`saveMilestoneLaunchMode` in `milestone-launch.ts`
- [x] 4.2 `milestone-launch.ts` → `launchMilestone(projectId, n, mode)` (single POST), `resumeChain`, `cancelChain`; typed results for `chain_active` + guard errors; update `milestone-launch.test.ts`
- [x] 4.3 `useBuilderSession.launchM1` + `BuilderSidebarEntry.handleLaunchM1` call the new client; error toasts per typed reason

## 5. Client: premium milestone surfaces

- [x] 5.1 `useMilestoneProgress(projectId)` hook (`/blueprint` fetch + `blueprint.milestone_progress`/`milestone_completed` WS filtered by projectId ref, `useProjectCache`-backed) + tests
- [x] 5.2 `MilestoneProgressBar` (segmented, semantic tokens, legend), `MilestoneRailRow` (state pill via `PrDecisionPill`, 1 s elapsed ticker, Review → `/review/:prDeliveryId` or dashboard rail), `MilestoneChainRow` (k of n, waiting/paused reason, Resume/Cancel)
- [x] 5.3 `BuilderSidebarEntry`: 320 px flyout rendering the model (no board fetch on open), Launch + mode toggle (hidden while a chain is active), Generate M<next>; tests for delivered-not-done copy, live update, Review
- [x] 5.4 Builder done screen (`BuilderConversation` phase `done`): live milestone card after launch, "Open the project" exit
- [x] 5.5 Toasts: chunk launched, chain paused (Resume action), milestone delivered (Review action), milestone completed; remove `sequential.done` "complete" copy
- [x] 5.6 Decision surfaces (`RailPrDecisionStrip`, `AgentPrDecisionCard`, review packet verbs): "later rails build on this" note on Discard when the delivery is a stacked head
- [x] 5.7 i18n: `builder:progress.*`, `builder:chain.*`, `builder:milestoneToast.*`, `packet`/`dashboard` discard note ×8; locale-parity test green

## 7. Premium spec generation

- [x] 7.1 `server/spec-contract-prompt.ts`: the shared premium contract (full markdown + compact form + a premium example spec) with per-author grounding hooks (day-0 planned artifacts / verified paths)
- [x] 7.2 Rewrite `server/blueprint-operator-prompt.ts` on the shared contract: premium example, batched generation protocol (outline → `APP CONTINUE` detail turns → `APP AUDIT`), `GENERATION MODE: single response` fallback line, `truncated` repair copy no longer says "tighten"; update `blueprint-operator-prompt.test.ts`
- [x] 7.3 `server/blueprint-chat-manager.ts`: outline detection (`isOutlineSnapshot`), continuation driver (`SPECS_PER_DETAIL_TURN = 2`, `MAX_GENERATION_TURNS = 8`, target-filled check, stop on a stalled turn), audit turn, `blueprint.generating` WS + `blueprint.done { continuing, generation }`, no-resume fallback; tests in `blueprint-chat-manager.test.ts`
- [x] 7.4 Raise the gate floors in `server/blueprint-spec-quality.ts` + `client/src/lib/blueprint-spec-quality.ts` (`section_depth`, `section_bullets` min, criteria 6–10, criterion ≥ 20 chars); update both test suites and the `builder:quality.*` i18n ×8; update `M1_READINESS_BOUNDS` copy if it names criteria bounds
- [x] 7.5 `chat-manager.ts` `_buildMilestoneSystemPrompt` and `agent-operator-prompt.ts` super-spec section consume the shared contract; update their tests
- [x] 7.6 Client: `BuilderSnapshotState` gains `generating` (phase/from/to/total), `useBuilderSession` handles `blueprint.generating` + continuing done frames (busy stays true, panel updates), `BuilderGenerationProgress` shows "Writing specs 3–4 of 8…" with a real ratio; i18n `builder:generation.*` ×8; tests
- [x] 7.7 Docs: `docs/internals/project-builder.md` (contract + batched protocol), `CLAUDE.md` Project Builder bullets, `openspec` specs synced at archive

## 8. Wave checkpoints

- [x] 8.1 Store: `auto_advance` column (amend migration 58 — unshipped) + status `awaiting_approval` (active set, index, `ChainPatch.autoAdvance`); `MilestoneChainSnapshot.autoAdvance`; tests
- [x] 8.2 Manager: `start(n, mode, { autoAdvance })`; successful settle with `auto_advance = 0` → `awaiting_approval` (head recorded, no launch); `resume` from `awaiting_approval`; `setAutoAdvance(id, on)` (advances immediately when awaiting); recovery unaffected; tests
- [x] 8.3 Routes: launch body `autoAdvance?`, `PATCH /:projectId/blueprint/chains/:id { autoAdvance }`; client `launchMilestone(projectId, n, mode, { autoAdvance })`, `setChainAutoAdvance`; `milestone-launch.test.ts`
- [x] 8.4 UI: auto-continue toggle in the launch controls (stored preference `specrails-desktop:milestone-auto-advance`, default off) and on the chain row; `awaiting_approval` chain row copy + **Launch next rail** / toggle / Cancel; `useMilestoneNotifications` checkpoint toast (Launch next + Auto-continue); i18n `builder:milestoneProgress.*` ×8; tests
- [x] 8.5 Docs: project-builder.md + CLAUDE.md milestone lifecycle bullets mention checkpoints

## 6. Verification & docs

- [x] 6.1 `npm run typecheck`, `npm test`, `npm run test:coverage` (server ≥80 %), `cd client && npm run test:coverage` (client ≥80 %) — iterate until green
- [ ] 6.2 Manual: greenfield Builder project, 8-spec M1 sequential → rail 1 runs, settles, rail 2 launches stacked on rail 1's branch; flyout live; Accept rail 2 first → rail 1 auto-merged; wedge simulation (`SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS` low + stuck floor) → stalled + retry + settle
- [x] 6.3 Docs: `docs/internals/project-builder.md` (milestone lifecycle rewrite: chain, stacking, progress model, events, routes, kill switches), `CLAUDE.md` Project Builder "Milestone lifecycle" bullet + Interactive jobs loop-path bullet, `docs/internals/safe-pr-review-flow.md` (explicit base branch + ancestor sweep)
