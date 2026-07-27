# Tasks — nontech-review-experience

Three waves; each wave is independently shippable behind its flag. Do not start a wave's UI tasks before its foundation tasks are green (typecheck + vitest + coverage 80% server / 80% client).

## 1. Wave 1 — Evidence foundations (server-only, silent)

- [x] 1.1 Additive migration on `rail_pr_deliveries`: launch-time spec snapshot column (JSON: per-ticket title/description/labels) + settle evidence columns (sentinel verdict, verify output tail ≤4 KB, confidence-score JSON, harvest status)
- [x] 1.2 Capture the spec snapshot at delivery row INSERT (fresh launches AND continuation/revision generations) in `rail-isolated-launch.ts`; unit tests incl. mid-run spec edit
- [x] 1.3 Evidence harvest module (pure, DI): parse `VERIFICATION: PASS/FAIL` sentinel (reuse the `rail-merge-orchestrator` regex precedent), extract the verify step's output tail from persisted events, read `confidence-score.json` per unit from the mounted worktree with branch-content fallback; tolerant of absence, never throws
- [x] 1.4 Wire harvest into the settle path BEFORE any `releaseRailWorktrees` call (both success and failure outcomes); persist onto the row; failure logged + non-fatal; tests for absent score, malformed JSON, harvest exception
- [x] 1.5 Duration percentile query (p25/p75 + count) over `loop_runs.total_duration_ms` per loop id and `jobs.duration_ms` per command shape; REST endpoint; returns nothing below n=5; tests for sparse data
- [x] 1.6 Stuck detection: server-side staleness sweep over per-step activity checkpoints (flat env-overridable threshold, floor 10 min — DEVIATION: no per-STEP duration aggregate exists in the schema, and a per-RUN p75 is far too lenient as a step threshold; documented in stuck-run-detector.ts); broadcast one project-scoped `job.stuck` event per stall episode; re-arm on new activity; tests
- [x] 1.7 Client: route `job.stuck` through `useOsNotifications` with plain-language copy; respect existing preference filters; i18n ×8
- [x] 1.8 Gates: typecheck, vitest, server+client coverage green

## 2. Wave 2 — Review packet

- [x] 2.1 Verb→state mapping table as a pure, unit-tested function over `derivePrDeliveryPresentation`: every decision × outcome × statusCode presentation state maps to {human verb set | fine-control-only}; document the ~14 states in the module header
- [x] 2.2 Server packet composer (pure module, no model calls): variants Success / Nothing-to-change / Partial / Failed composed from delivery row + snapshot + evidence + `file_story_contributions` stats + `units[]` + `sumInvocationCostForRuns`; per-ticket cards for batches; exhaustive unit tests per variant
- [x] 2.3 Proof tiers in composer output: APP-VERIFIED / AI-REPORTED (with the mandated labeling copy) / REVIEWER SCORE (aspects, flags, human-review band); hard rule enforced by test: no numeric claim without a structured source
- [x] 2.4 Ladder pre-resolution helper: remote presence + offline `gh auth token` probe (reuse blueprint-commit preflight pattern) → Accept resolves to create-pr(+publish) or merge-local; unit tests for all capability combinations
- [x] 2.5 REST: `GET /:projectId/rails/pr-deliveries/:id/packet` returning composed packet + verb resolution; feature-gated by `SPECRAILS_REVIEW_PACKET`
- [ ] 2.6 Client packet page (routed under ProjectLayout, JobDetailPage precedent): inverted pyramid (one-line verdict + confidence pill + verbs above the fold; sections as progressive disclosure); semantic tokens only; `VITE_FEATURE_REVIEW_PACKET`
- [ ] 2.7 Decision wiring: packet consumes `useRailPrDecisions().act()` + `rail.pr_state` + authoritative POST-response snapshot; no optimistic state; race renders neutral already-resolved outcome; merge-local plain-language consequence confirm; plain-language copy for `merge_local_blocked` reasons
- [ ] 2.8 Fine-control disclosure embedding the existing `RailPrDecisionStrip` actions verbatim for recovery/partial/no_changes/degraded states
- [ ] 2.9 Agent-chat card: "Open review" affordance on `AgentPrDecisionCard` linking the packet page + an expanded packet summary section; "discuss this delivery" routes into agent chat with delivery context attached (existing `origin_conversation_id` linkage)
- [ ] 2.10 Cost lines: per-cycle + cumulative-chain cost on the packet (`~` estimated marker, `—` until authoritative); no projected figures
- [ ] 2.11 i18n: new `packet` namespace ×8 locales, key-parity green; all packet prose from deterministic templates
- [ ] 2.12 Entry points: packet link on the rail strip's on_review pill and on the `on_review` ticket pill/detail modal
- [ ] 2.13 Docs: `docs/internals/review-packet.md` (composer contract, tiers, verb table); update CLAUDE.md section; mark safe-pr-workflow tasks 7.1/7.2 as discharged-by this change with a pointer
- [ ] 2.14 Gates: typecheck, vitest, coverage 80/80 green

## 3. Wave 3a — One-sentence revisions

- [ ] 3.1 Additive migration: `revision_note` + `revision_of` columns on `rail_pr_deliveries` (metadata on the NEW generation row; no decision enum changes)
- [ ] 3.2 Guard exemption in `rails-router.ts`: launch flagged `revisionOfDeliveryId` + decision `on_review` + exact full ticket set ⇒ allowed; all other on_review launches keep the 409; mirror the identical logic in `server/mcp/tools/rails.ts`; tests: valid revision, subset rejected, unflagged rejected, post-PR continuation unaffected
- [ ] 3.3 Revision generation path: launch creates a superseding generation via `createPrDeliveryGeneration` carrying the sentence; failed revision restores predecessor (existing machinery) — integration tests for supersede + restore + wire (only known decision values broadcast)
- [ ] 3.4 Factory `revision` loop (4th factory loop, desktop-only, Architect-less): distilled revision command ai-step — goal = sentence + injected durable context (spec snapshot, PR-body digest, branch diff summary, harvested evidence), instructions orchestrate an `sr-reviewer` pass over the resulting diff producing `confidence-score.json` (agents present via worktree overlay; zero core changes) — + standard `{{cmd:verify}}`; flows through `classifyLoopEffect`/isolated launch unchanged; branch resume onto the ticket's existing branch verified by test
- [ ] 3.4b Post-PR door uses the same loop: a packet/agent revision on `pr_draft`/`pr_ready` launches the factory `revision` loop through the existing continuation machinery (new generation, born-attached); integration test proving no Architect step runs on a post-PR iteration
- [ ] 3.5 Fresh-seed contract: seed builder module (pure, tested); opportunistic `--resume` only when recorded `worktree_path` exists, one-time fresh fallback on missing-session diagnostic (contract-refine pattern)
- [ ] 3.6 Packet revision input: "What would you change?" box → flagged launch; expected-cost line only from real revision-run history; disabled states (already deciding, operation lease held); i18n ×8
- [ ] 3.7 Version lineage UI on the packet: v1/v2/… chain from `supersedes_delivery_id`, each with its sentence; "Back to version 1" verb riding restore; failed-revision packet variant ("could not be applied — version 1 still on review", sentence preserved for retry)
- [ ] 3.8 Drift nudges: triggers (cumulative cost >50% of original, majority out-of-set churn from `file_story_contributions`, count ≥3 backstop); advisory banner with real numbers + one-click "turn notes into an updated spec" agent handoff; trigger logged; never blocks
- [ ] 3.9 MCP + operator intelligence: `specrails_rails(launch)` gains `revisionOfDeliveryId` + `revisionNote` params (validated against the rail's active delivery; actionable errors); operator prompt taught to route ANY "modify this delivery/PR" ask through the factory `revision` loop with those params — both doors — replacing the current full-implement relaunch guidance; rebuild the staged bridge bundle if the tool schema changes
- [ ] 3.10 Flag `SPECRAILS_DELIVERY_REVISIONS` (default on, opt-out); kill-switch test = byte-identical legacy guard
- [ ] 3.11 Gates: typecheck, vitest, coverage green

## 4. Wave 3b — Narrated progress

- [ ] 4.1 Pure narration model (`client/src/lib/` or `components/loop-log/` sibling): structured events + parsed lines → milestone list; handles plain jobs, loop jobs, legacy runs without `loop_graph`, interrupted steps (no end event + settled job); exhaustive unit tests per stream shape
- [ ] 4.2 i18n milestone templates ×8 (`narration` namespace): step kinds, iterations, durations, decider verdicts, tool activity lines (file paths/commands verbatim, outcomes only from structured verdicts); key-parity green
- [ ] 4.3 Narrated|Log mode toggle in JobDetailPage + JobDetailModal (Story|Log precedent, per-project localStorage persistence); raw log view byte-identical; glance surfaces untouched; `VITE_FEATURE_NARRATED_PROGRESS`
- [ ] 4.4 Honest waiting line: p25–p75 band + sample count from the Wave 1 endpoint, absent below floor; elapsed from real clock
- [ ] 4.5 Provider degradation: predictable narration from loop events alone where tool granularity is absent (codex/gemini/kimi); test per provider stream fixture
- [ ] 4.6 Docs: narration section in `docs/internals/loop-step-log-explorer.md` (or sibling doc) + CLAUDE.md update
- [ ] 4.7 Gates: typecheck, vitest, coverage green

## 5. Parallel track (non-blocking, separate repo)

- [ ] 5.1 File the specrails-core ask: structured test counts (pass/fail/total) emitted into `confidence-score.json` by the verify/review step + delta-scoped verification (pipeline-cost-economy program); when counts land, packet tier-2 auto-upgrades (composer already checks for the structured field — add the check in 2.3)
