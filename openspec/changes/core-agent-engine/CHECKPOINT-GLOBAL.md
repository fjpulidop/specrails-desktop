# Checkpoint — 26 September 2026

## Linked historical forks — 26 September 2026, 23:47 CEST

- Migration 68 persists idempotent fork intents and marks superseded settlement
  allocations without rewriting their frozen snapshots. Core creates the exact
  historical cut; one Desktop transaction adopts the child job/run, causal ticket
  ownership, inherited addenda and original isolated allocation. Late original
  callbacks cannot commit Git, settle tickets or replace the child's delivery.
  Pending intents fence source execution and preserve retry identity after an
  uncertain response. Retained Core must advertise `forkIdempotency: 1`.
- Explorer attempts offer **Repeat from here**, preserving node, scope and visit.
  A reload recovers the server request; project switches discard late responses.
  The linked child is explicitly paused for the user to open and resume. Eight
  locales and both routed/modal job views are wired. StrictMode effect remounts
  have a separate regression test.
- Paired real Core test creates/adopts/resumes the child, answers its question and
  completes without providers while preserving source database bytes and Desktop
  rows. Focused settlement tests also fence a late successful original callback.
- Full server coverage: **402 suites / 8,961 tests passed**, two Windows-only
  suites / seven cases skipped on macOS, 210.11s with two workers. Statements
  86.99%, branches 80.18%, functions 90.83%, lines 90.08%; thresholds unchanged.
  An earlier attempt failed ECONNRESET in the old agent-chat HTTP helper. Its
  per-request servers now disable socket pooling and await close; 66 focused
  tests and the repeated full gate passed. Other previously observed HTTP flakes
  are not claimed fixed by this change.
- Full client coverage before the final StrictMode fix: **393 suites / 4,691
  tests passed**, 180.73s, statements/lines 89.70%, branches 84.18%, functions
  75.69%. The final hook regression passed 5/5; full typecheck and architecture
  audit passed on the final code. A final client coverage run remains necessary.
- Remaining acceptance includes real multi-repository Git settlement after fork,
  already-released workspace handling and older isolated runs without migration
  67 snapshots. These still reject uncertain ownership safely; this is not a
  claim that D3/D4 or the full rollout is complete.

The user requested a checkpoint because their weekly quota was almost exhausted.
The original objective remains **the entire plan, not just the foundations**.
This checkpoint is unfinished implementation, not production acceptance. Do not
merge, release, check off pending gates, or describe the complete migration as done.

## Runtime graph and recorded events — 26 September 2026, 22:58 CEST

- Read-only ReactFlow explorer consumes Core's actual public topology, including labelled transitions and nested components. Node selection focuses exact scoped attempts; latest status per scope cannot hide a failed sibling. Recorded trace/span metadata is retained. All eight locales updated.
- Browser verification used the actual component with a disposable parallel-branch fixture. Corrected dark-theme control contrast and refit on component navigation; selecting the failed branch focused its exact scope. Preview files/server/tab were removed.
- Client full coverage: **392 suites / 4,687 tests passed**, 182.30s; statements/lines 89.69%, branches 84.21%, functions 75.77%. Original thresholds unchanged. Focused explorer suites passed 188 tests. Full typecheck and architecture audit passed for the UI block.
- Added a real Core/LangGraph JSONL capture (Core 54946aae) using a deterministic local executor: two physical calls, concurrent scopes, pause/resume and replay. Desktop projection agrees with recorded Core tokens and known-cost totals, preserves unknown billing, and does not bill replay. Eleven projection/manager tests passed. This is contract evidence, not rollout/provider billing telemetry.
- D2 remaining checks include final evidence/paired delivery acceptance and trace surface integration. D3 fork lifecycle and D4 pre-migration recovery remain open; no completion claim is made for those blocks.

## Saved execution controls — 26 September 2026, 22:30 CEST

- Saved v2 executions and job headers now route resume/recovery and terminal-settlement retry to the definition lifecycle. The legacy continuation rejects v2 before accounting/execution effects. Compact status preserves exact recoverable attempt IDs and maps displayed questions/approvals to authoritative pending interrupt identities.
- Added explicit attempt checkboxes (node, scope, attempt) on both surfaces. No attempt is selected by default; refreshed status removes stale selections. Eight locales updated. Duplicate in-flight actions are fenced and late action responses are ignored after project switching.
- Verification: 76 server tests (controls, HTTP admission, resume validation), 37 client tests (saved runs, header, selection), full typecheck and architecture audit passed. Locale parity/i18n passed 49 tests. The earlier broad coverage remains a baseline, not a final gate for this block.
- Completed task bookkeeping for the verification-aware delivery verdict and durable-request/startup reconciliation already covered by focused and broad baseline tests. Full D3/D4 acceptance remains open; cancellation completion/fork/old snapshot recovery are still next.


## Recovery continuation — 26 September 2026, 22:25 CEST

- D4 isolated settlement now persists immutable per-unit admission snapshots before Core fan-out (migration 67), durable per-unit results, and transactional provenance receipts. Fresh and recovered work share the extracted Git settlement coordinator. Reattachment verifies frozen Core acceptance/verification, ledger/branch/mount ownership, claims execution and every delivery leg, preserves accounting and terminal outbox, and refreshes repository groups. Existing-PR results remain retryable through the existing delivery path; no automatic push or PR merge.
- Added POST `/loop-runs/:id/resume` with fresh retained status, exact attempt/interrupt validation, synchronous manager admission, foreign-project protection and safe orphan-claim replacement checks. Resident tasks keep their original settlement callback; inactive resumed tasks reconnect to frozen isolated settlement or the standalone terminal callback. Completed Desktop rows can explicitly retry original settlement. Resume clears restart_reason.
- Corrected the earlier completion-policy classification: a valid Core negative acceptance verdict (or missing required verification) is `blocked`, not malformed protocol/process failure. Frozen policy is still enforced.
- Validation on this block: full typecheck and architecture audit passed; combined isolated launch/recovery, bridge, HTTP controls, resume validation/store and architecture regression passed 228 tests in seven files. Additional existing standalone routes passed with new HTTP cases (24 tests combined). Recovery operation conflict regression passed 7 tests. Source map and boundary manifest reviewed; eight common locales now include restart_pending.
- This is not completion of D4/D3: fork HTTP/ownership transfer, inactive cancellation completion, pre-migration snapshot recovery, client controls/graph remain open. Existing agent-runtime saved-run controls still need to route v2 operations through the definition lifecycle. Real paired multi-repository/crash reattachment acceptance and new full coverage gates remain required. Do not count earlier full-coverage results as verification of these new edits.


## Codex continuation — 26 September 2026, 20:30 CEST

- Broad stable-tree gates on Desktop 2fa3054a: server coverage 396 suites / 8,895 tests passed, two Windows-native suites / seven cases skipped on macOS; 105.27s with four workers, statements 87%, branches 80.17%, functions 90.90%, lines 90.01%. Original thresholds unchanged. Client coverage: 389 suites / 4,673 tests, 205.38s, statements/lines 89.68%, branches 84.17%, functions 75.70%.
- Full build passed, script tests 94/94 passed, paired compatibility explicitly selected Core's bin and confirmed contract 5.1. The default compatibility command had skipped because Core was not installed globally; that skip is not used as evidence. Actual packed Desktop production install/CLI/MCP/shell/integrity acceptance passed with a private npm cache and registry access. Generated tracked native bundles were restored after build rather than mixed into source changes.
- The initial serial server coverage run overlapped a source edit and loaded inconsistent module/test revisions; discarded that result and reran the whole stable tree above. No production files changed during the successful run.


- Completion-policy hardening: the process bridge now rejects an exit-zero succeeded frame when completion.ok is false or the frozen definition requires verification but completion.verified is false. Fresh launches and resumes use the same frozen policy. Bridge tests passed 29 cases; full typecheck passed.
- D2 evidence implementation: isolated settlement now prefetches full retained status with bounded concurrency and projects host commands plus exact scoped reviews. Failed inspection marks harvest unavailable; legacy journals are not substituted for v2. Regression passed 200 tests across evidence, isolated launch and paired recovery; Core full-status regression passed 12 tests. Packet healing now queries retained Core for historical v2 runs, preserves file confidence, and never substitutes a legacy journal after a failed v2 probe. Routes/architecture regression passed 214 tests; full typecheck and architecture audit passed. Custom reviewer selection UI remains to integrate.
- D2 evidence decision: full retained CLI status exposes scoped committed outputs. Delivery will use the exact attempt/scope identities for verification commands and declared reviewer output. Ambiguous parallel reviews cannot be reduced to a fabricated single score; file-based confidence remains authoritative. Compact recovery probes remain bounded and omit output payloads.

- Agent Studio now edits explicit Core access/artifact policy, optional OpenSpec skill, provider/model/effort/thinking/maxTurns and escalation while preserving instructions and provider-native metadata. Identity validation applies across providers; built-in roles cannot be shadowed. Eight locales updated. All agent client suites passed (80 tests); locale parity previously passed (30 tests).
- Closed AI-refinement bypass: applying a draft validates the Core descriptor and Kimi native requirements before file/version/session mutation, including force-apply. Manager regression passed 40 tests, including rejection without disk/version/session changes. Structured frontmatter editing normalizes YAML formatting; this behavior is documented in the feature guide.

The interrupted wave is being completed, preserving its uncommitted work. No merge or release occurred.

- Completed the D7 server transport: retained CLI signal via stdin, stable request id, bounded control output, project/frozen-context checks, Core acceptance timestamp, 400/409/503 error mapping, POST `/agent-runtime/runs/:runId/steer` and MCP `runtime_steer` with write permission.
- Core owns durable steering receipts and consumption; Desktop projects bounded previews and does not invent consumption or maintain a second receipt journal. Core status supplies counts and consuming attempt/time. UI remains pending.
- Corrected the v2 status-cache database path to `agent-workflow/run.sqlite`; legacy implementation checkpoints cannot invalidate v2 status.
- Desktop full typecheck passed after removing the incomplete steering scaffold through implementation. Controls/bridge/MCP targeted suites passed 83/83 (HTTP tests require local socket permission). A subsequent endpoint naming alignment to the planned `/steer` path and its tests is included; final checks still required.
- D4 admission now uses durable execution claims before async work, releases claims during human pauses and reacquires on continuation. Added conflict, stale-owner, failed-admission and restart tests.
- D4 startup now probes retained Core status (bounded fan-out/time/output) before orphan/worktree recovery. Inaccessible or completed Core work is preserved for explicit settlement; live leases remain fenced. Restart-paused engine-v2 building deliveries retain `restart_pending`. Reattachment and lifecycle HTTP routes are still pending.
- Recovery/claims/delivery/startup targeted suites passed 147 tests; subsequent extra stale/surviving owner tests passed (18 tests in three focused suites). Architecture audit and its 21 tests pass; source map updated. Full Desktop coverage still pending.
- The recovery probe also passed a provider-free paired test against the actual Core CLI (5 tests including malformed/unavailable cases). The authoritative lease expiry is epoch milliseconds and interrupt identity is `id`; these supersede the preliminary Claude API sketch below.
- D5 template routes now select all eight Core starter graphs by capabilities, retaining legacy fallback for older Core. The template/factory/router suites passed 58 tests, including validation of every starter against the real Core CLI. Mutating starters require verification; read-only monitoring starters do not invent write requirements.
- D6 server projection now discovers provider-native custom agents and maps `custom-<id>` to non-built-in Core roles with read/none defaults. Explicit project settings and prompts win. Engine escalation, access, artifacts and OpenSpec skill metadata are validated; plain Markdown remains supported. Catalog metadata is named `runtimeRoleDefaults` to avoid implying effective project overrides. The role/settings/profile/architecture suites passed 156 tests and full typecheck passed. Agent Studio editing UI remains pending.
- D2 projection now caches usage between new physical invocations, rejects divergent evidence for an existing physical invocation, persists event cursors and runtime result checkpoints atomically with events/accounting, and retains trace/span correlation. Focused projection/store tests passed 15 tests, including rollback/cursor and aggregate-read-count checks. Core result now includes its authoritative revision/event cursor (CLI acceptance 7/7). Delivery v2 evidence and the graph explorer remain pending.
- D7 client inbox is wired into saved executions and job details with all eight locales. Retry uses the same request identity after an uncertain response, edited text gets a new identity, project switches ignore late responses, and acceptance never implies consumption. Client inbox/saved-run/i18n suites passed 33 tests and full typecheck passed. Final job-header, locale-parity and server route regression checks remain to run.
- Final focused D7 checks passed: job header/locale parity 54 tests; server controls/routes/projection/store 64 tests. Broad paired server regression passed 998 tests across 45 files (loops, runtime, profiles/roles, architecture, database, startup and PR store). No paired tests skipped.
- Migration 66 now creates the legacy telemetry store and its indexes. The preserved helper normalizes timestamps before window comparisons; database/telemetry tests passed 74 tests. Actual launch call sites, analytics and two-release retirement evidence remain pending; an empty store is not rollout evidence.
- Subsequent D8 integration wires the counter into legacy Loop Manager admission, both Queue Manager slash spawn paths, and legacy merge-back. Added GET `/analytics/legacy-launches` with validated time windows; it explicitly does not assert retirement evidence. Call-site/API/architecture regression passed 503 tests before two additional direct spawn assertions (final check pending). Compatibility compilation and actual two-release evidence remain outstanding.
- Subsequent D4 integration sends cancellation to retained Core before ending a resident human pause, uses SIGTERM plus a bounded SIGKILL fallback for a child, and preserves the pause on failed acknowledgement. Manager/bridge suites passed 171 tests; actual paired CLI probe/fork/cancel suite passed 5 tests, including source database byte preservation after fork. Inactive-run cancellation/settlement, resume/fork HTTP routes and reattachment still remain.
- Direct legacy spawn/merge-back assertions passed (310 tests in queue-manager and rail-isolated-launch); final full typecheck and architecture audit passed. Core cancellation idempotency is committed as 81f351eb; Desktop foundation/steering block is committed/pushed as 0873075f. No PR has been merged or release published.
- The other Claude partial changes (claims, templates, telemetry, fork/cancel bridge) are preserved and still require their integration and acceptance. D4 recovery/settlement and lifecycle routes are next. Original D2/D5/D6/D8 and client/Web plan remains outstanding.

## Continuation checkpoint — 26 September 2026, 19:55 CEST (Claude Code session)

A second assistant session resumed from this checkpoint, verified every claim
against code and tests, planned the remaining Desktop/Web work, and started a
first server-side implementation wave with seven parallel agents. The wave was
cut by the account's session limit before any agent finished or verified its
work. **Nothing from the wave is verified or committed on this branch.** Partial
edits remain uncommitted in `/private/tmp/specrails-desktop-engine` and are
backed up on branch `wip/claude-wave1-desktop` (check `git branch -r`). Treat
them as a head start, not accepted work. Read this section first, then the rest.
The paired Core section is in `/private/tmp/specrails-core-engine-v2/openspec/changes/core-agent-engine/CHECKPOINT.md`.

### Verified baseline (HEAD `bf638fbd`, system Node 25.9.0)

| Check | Result |
| --- | --- |
| `npm run typecheck` (root, cli, mcp-bridge, local-runner, client) | pass |
| `npm run audit:architecture` | pass (supersedes the D1B note "not yet green") |
| `git diff --check` (tree and vs `origin/main`) | clean; the three trailing spaces in `desktop-release.yml` were removed by PR707 commit `c11cb19d` — the D1-D3 note item 9 is stale |
| Server suites | loops **458 passed / 2 skipped**, agent-runtime **205 / 2 skipped**, delivery **1011**, execution **345**, architecture+db+project-router-loop-runs **107**; 0 failures |
| Client suites | loops **279**, settings **290**, jobs **282**, i18n + locale parity **49**; 0 failures |
| Migration numbering | 64 entries, contiguous; 64 = frozen definition launches (`server/db/migrations.ts:1608`) |
| The 4 skips | paired-Core guards (`loop-core-factory.test.ts:33`, `loop-definition-schema.test.ts:17`, `agent-runtime-package.test.ts:62`, `agent-runtime-settings.test.ts:223`) because `../specrails-core` does not exist. Export `SPECRAILS_CORE_SOURCE_DIR=/private/tmp/specrails-core-engine-v2 SPECRAILS_EFFICIENCY_CORE_ROOT=/private/tmp/specrails-core-engine-v2` to run them (a `/private/tmp/specrails-core` symlink was not created). |
| PR707 ancestry | `97cfabbb` is **not** an ancestor of HEAD; `.github` + `scripts` are byte-identical to `origin/codex/ci-engine-optimization` (`c11cb19d`), i.e. copied not merged — still to reconcile |
| CI | PR #708 run `36235416535`: 18/18 green. `windows-parity.yml` has never run on this branch (main-only trigger) |
| Full root/client coverage, build, `check:package` on this HEAD | **not run** |

Structural audit confirmed the gaps exactly as the checkpoint notes describe:
no execution claim guard (only the in-memory `_definitionTasks` check at
`loop-run-manager.ts:1066`), no `loop-definition-recovery.ts`,
`project-registry.ts:1528` calls `reconcileOrphanLoopRuns` without
`definitionStates`, `rail-pr-store.ts:462-500` marks every unfinished building
delivery `settlement_interrupted` at startup, no `reattachIsolatedSettlement`,
`project-router-loop-runs.ts` has only GET run / GET duration-range / POST
launch (no resume/fork/cancel; `resumeDefinition` has zero non-test callers),
bridge args are only `run|resume` (`agent-runtime-bridge.ts:126`), cancel is
treeKill-only, no `signal`/`steer`/`runtime_steer` anywhere,
`loop-definition-events.ts:88` re-sums `ai_invocations` per event and never
stores the Core cursor, `delivery-evidence.ts:497-560` reads only the legacy
layout, the eight templates in `loop-templates.ts` are legacy graphs, template
routes are not capability-aware, D6/D7/D8 absent, no run-graph or fork lineage
rendering in the loop log explorer (`loop-log-model.ts:179-189` parses
`runtime-graph` but nothing renders it).

### Partial, unverified edits left in the worktree

`npm run typecheck` currently **fails** with five `TS6133/TS6196` unused
declarations in `server/modules/agent-runtime/runtime/agent-runtime-controls.ts`
(lines 31-33, 56-57: steering constants/types scaffolded, implementation cut).
Focused run of loop-runs-store, loop-definition-store, loop-templates, bridge,
controls, db and loop-core-factory tests: **186 passed / 1 failed** —
`loop-definition-store.test.ts` "appends migration 64 ..." now sees version 65.

| File | State |
| --- | --- |
| `server/db/migrations.ts` | Migration **65** appended: `definition_execution_claims` (synchronous admission guard). Migration 66 (`legacy_launch_events`) was **not** appended although its module exists. |
| `server/modules/loops/runtime/loop-runs-store.ts` | New exports `claimDefinitionExecution`, `releaseDefinitionExecution`, `readDefinitionLineage` (~lines 201-260) per the contract below. No callers, no tests yet. |
| `server/modules/loops/runtime/legacy-launch-telemetry.ts` (new, 90 lines) | `recordLegacyLaunch`, `readLegacyLaunchSummary`; needs migration 66, tests, analytics exposure and call sites. |
| `server/modules/agent-runtime/runtime/agent-runtime-bridge.ts` | `runAgentRuntimeControl` gains `kind: 'fork'` (Core `fork --context --from --run-id [--scope-id --visit --state]`) and `kind: 'cancel'` (`cancel --context --request-id`) result types (~lines 306-451). Untested. |
| `server/modules/agent-runtime/runtime/agent-runtime-controls.ts` | Steering scaffolding only (breaks typecheck). |
| `server/modules/loops/runtime/loop-templates.ts` | The eight starters re-declared through a Core-graph builder (`type: 'core'` nodes at ~line 471). Not validated against the paired Core catalog; legacy versions/capability fallback and route selection not done; tests not updated. |

### Shared server API contracts (already partially implemented; keep them)

```ts
// server/modules/loops/runtime/loop-definition-recovery.ts (to create)
export interface DefinitionRunProbe { runId: string; engineVersion: 2; status: 'paused'|'running'|'succeeded'|'failed'|'blocked'|'cancelled'|'unavailable'; resumable: boolean; lease: { owner: string; epoch: number; expiresAt: string; active: boolean } | null; recoverableSteps: Array<{ attemptId: string; nodePath: string; scopeId?: string }>; pendingInterrupts: Array<{ interruptId: string; nodePath: string; kind: string }>; coreRevision: number | null; probedAt: string; error?: { code: string; message: string } }
export interface DefinitionProbeContext { db: DbInstance; cwd: string; env: NodeJS.ProcessEnv }
export function probeDefinitionRun(ctx: DefinitionProbeContext, runId: string): Promise<DefinitionRunProbe>
export function probeDefinitionRuns(ctx: DefinitionProbeContext, runIds: string[]): Promise<Map<string, DefinitionRunProbe>>
export function toDefinitionStates(probes: Map<string, DefinitionRunProbe>): /* definitionStates shape of reconcileOrphanLoopRuns; null = missing/non-resumable */
// Runs `runtime status --compact` through the RETAINED runtime with the frozen host
// (readFrozenRuntimeHost); never infers lease expiry from updatedAt.

// server/modules/loops/runtime/loop-runs-store.ts (present, untested)
export function claimDefinitionExecution(db, runId, claim: { owner: string; repositoryMounts: string[]; parentRunId?: string }): { ok: true; release: () => void } | { ok: false; reason: 'active_owner'|'lineage_conflict'; conflictingRunId: string }
export function releaseDefinitionExecution(db, runId, owner: string): void
export function readDefinitionLineage(db, runId): { runId: string; forkOf: string | null; children: string[]; forkCut: unknown | null }
// Atomic single transaction; rejects overlapping live claims on any shared repository
// mount (parent/child share the worktree); paused rows never imply a live process;
// claims are released on settlement/cancel and cleared by restart reconciliation.

// server/modules/loops/runtime/legacy-launch-telemetry.ts (present, untested)
export function recordLegacyLaunch(db, event: { kind: 'legacy_loop_traversal'|'queue_manager_slash'|'merge_back'; projectId: string; runId?: string; at?: string }): void
export function readLegacyLaunchSummary(db, since?: string): { total: number; byKind: Record<string, number>; lastAt: string | null }
// Table legacy_launch_events via migration 66; idempotent per (kind, run_id).
```

### Remaining Desktop work (planned as three waves; file ownership kept disjoint)

**Wave 1 — server (restart here).**

1. *D4 recovery* — create `loop-definition-recovery.ts` per the contract; in
   `project-registry.ts` probe engine-2 rows asynchronously (bounded concurrency,
   per-run timeout, failure ⇒ `unavailable`) before orphan reconciliation /
   worktree recovery / admission and pass `definitionStates`; add the durable v2
   restart exception to `rail-pr-store.ts reconcileFailedBuildingPrDeliveries`
   (paused-by-restart run ⇒ keep building, preserve worktrees, note
   `restart_pending`); add `checkCoreWorkflowCompletion(contextPath, cwd, env,
   runId)` in `server/core-execution.ts` (valid ⇔ succeeded ∧ completion.ok ∧
   (verified ∨ no write effect)); use it in `rail-isolated-launch.ts` for v2 runs
   (`completion.ok:false` ⇒ `implementation_failed`, never `on_review` without a
   receipt) and implement `reattachIsolatedSettlement(ctx, deliveryId, runId)`
   by extracting the settlement continuation of `launchIsolatedRail` (no copy of
   the closure); crash-recovery test to `on_review` with idempotent effects.
   Call `recordLegacyLaunch({kind:'merge_back'})` from `runMergeBack`.
2. *D4/D3 routes and lifecycle* — call `claimDefinitionExecution` before spawn in
   `run()`/`resumeDefinition()`, release on all terminal paths, HTTP 409 on
   conflict; `forkDefinition(runId, { fromNodePath, scopeId?, visit?, state? })`
   freezing the child from the source run's durable request, calling Core `fork`
   through the bridge, persisting `fork_of` + `fork_cut_json`, reusing
   worktree/settlement ownership, launching via resume, leaving the source
   pipeline directory byte-identical; graceful cancel = Core `cancel
   --request-id` first, bounded grace, then the existing treeKill; a cancel path
   for restart-paused rows with no live task; routes `POST /:projectId/loop-runs/:id/resume|fork|cancel`
   and `GET /:projectId/loop-runs/:id/recovery` (probe + lineage) — never through
   `AgentRuntimeControls.resume`; route tests; `recordLegacyLaunch({kind:'legacy_loop_traversal'})`
   once per legacy run start. Fix `loop-definition-store.test.ts` to expect the
   latest migration.
3. *D2 completion* — cache usage totals in `loop-definition-events.ts` until an
   invocation row changes; persist Core event cursor/revision in the same
   transaction; reject a repeated `invocationId` with divergent payload; v2 path in
   `delivery-evidence.ts readRuntimeEvidence` (retained `runtime status --compact`,
   reviewer `$outputs`/`reviewerStepId`, confidence projection preserved); record a
   real Core v2 JSONL (provider-free definition: shell + condition + question +
   end) as a fixture and replay it through `createDefinitionEventProjection`;
   parity assertion `SUM(ai_invocations) == runtime-result.invocationUsage`
   (null-preserving).
4. *D5 templates* — finish the eight Core templates (watchers read-only, mutating
   templates end with real `verify` + `requiresVerified`, `ship-and-green` =
   `implementation → verify → decider → prompt(fix)`), keep legacy graphs for
   older Core, capability-aware `GET /loop-templates` and `POST
   /loops/from-template/:id` like `loops-router.ts:107-135`, paired-Core validation
   tests that actually run (env above), structural Quick SDD parity in
   `loop-core-factory.test.ts`.
5. *D7 server* — `AgentRuntimeControls.signal(runId, text)` (≤ 20000 UTF-16
   units, retained runtime, `signal --context --stdin`), `POST
   /:projectId/agent-runtime/runs/:runId/steer` (202 `{id, acceptedAt}`; 400/404/409),
   receipts in run status (pending vs consumed with `consumedAttemptId` if Core
   status exposes them), MCP action `runtime_steer` in `server/mcp/tools/jobs.ts`,
   docs (`docs/agent-live-steering.md`, programmatic runtime guide).
6. *D6 server* — pure projection of `custom-*.md` agents to
   `roles.<id>` descriptors (id without `custom-`, `^[a-z][a-z0-9-]{0,63}# Checkpoint — 26 September 2026

The user requested a checkpoint because their weekly quota was almost exhausted.
The original objective remains **the entire plan, not just the foundations**.
This checkpoint is unfinished implementation, not production acceptance. Do not
merge, release, check off pending gates, or describe the complete migration as done.

,
   `access` read default, `artifacts` none default, engine, `openspecSkill`),
   merged into the effective RuntimeConfig below explicit settings roles,
   built-in id conflicts rejected, exposed through `/catalog` and
   `/agent-runtime/config`; orchestrator/routing flagged deprecated (no removal).
7. *D8 preparation only* — migration 66 + tests for the telemetry module,
   analytics exposure of `readLegacyLaunchSummary`, `recordLegacyLaunch({kind:'queue_manager_slash'})`
   at the QueueManager slash launch in `rails-router.ts`; `loop-compat.ts
   upgradeLegacyGraph` (contract §11 mapping) with parity tests over every
   template/factory graph validated by the paired Core. **Do not** add the
   `graph_legacy` loops migration or remove any legacy traversal: D8.3–D8.5 stay
   gated on two telemetry releases.
8. *Wave-1 close* — regenerate `server/modules/boundaries.json` only through the
   audit script (review the diff: real new edges only), `npm run docs:source-map`,
   `npm run typecheck`, `npm run audit:architecture`, affected suites,
   `npm run check-core-compat`.

**Wave 2 — client.** "Repeat from here" on finished steps in
`LoopStepExplorer` calling the fork route and showing lineage (`forkOf`);
"Resume" on the job card with the `recoverableSteps` list when Core requires
`--recover`, interrupt selection already exists in `InteractiveJobComposer`;
render the run topology from `runtime-graph` (`loop-log-model.ts` already
parses it) and the fork lineage; steering composer semantics for v2 runs
(accepted vs consumed receipts) and a per-run trace/span view; Agent Studio
access/artifacts/engine/openspecSkill fields. Add all new keys to the eight
locales in one pass and run the locale-parity tests; note
`LoopBuilderPage.tsx` is excluded from client coverage, so keep logic in `lib/`.

**Wave 3 — documentation and gates.** Desktop guides in all eight locales
(`docs/guide/*/pipeline/1,2,5`, `docs/running-pipelines.md`, internals for
recovery/steering/lineage), module READMEs; full root + client coverage,
`npm run build`, `npm run check:package`; reconcile PR707 ancestry; tick
`tasks.md` only with evidence; rewrite the PR #708 body.

### Web (specrails-web) state and plan

PR #218 (`docs/core-engine-rollout`, worktree `/private/tmp/specrails-web-engine-docs`,
clean, no `node_modules`) adds only `README.md` (+4) and
`docs/core-engine-documentation-rollout.md` (+63): a gate table, no guide change.
Guide source of truth is `src/content/guide/<lang>/<category>/<N>-<slug>.md`
(8 languages × 8 categories; English drives the 37 routes; a translation is
current only when its first line is `<!-- guide-revision: mission-first-v1 -->`).
en/es cover all 37; the other six languages have 32 files each of which only 3
are current. 14 routes concern pipelines/loops/agent runtime;
`pipeline-the-loop-builder` (en and es) has zero Core-workflow content, while
Desktop's `docs/guide/*/pipeline/5-the-loop-builder.md` already carries a
"Core workflows" section in all eight languages (only on branch
`feat/core-engine-desktop-v2`, commit `4c84e95c`). Adding/updating a page:
write en+es with the marker, `npm run docs:sync` (regenerates
`src/lib/docs-generated.json`, `src/lib/docs-loaders.ts`, `public/sitemap.xml`),
then update the hard-coded counts in `scripts/sync-guide.test.mjs` (37 entries,
3 translations per non-en/es language) and `src/test/docs-registry.test.ts`
(37, fallback assertions), and `src/content/guide/README.md`. Web CI runs only
`npm run test:coverage`; `docs:check`/`test:docs-sync` run only via `prebuild`
in release — add them to `ci.yml` if the parity gate should protect PRs. The
original checkout `/Users/javi/repos/specrails-web` has 17 unrelated untracked
`src/content/*` paths: never stage them.

### Decisions recorded in this continuation

- Core now advertises engine v2 (`engineVersion 2`, 16 `nodeKinds`,
  `engineV2/workflowDefinitions/fanOut/fork/steeringInbox`) so that Desktop
  capability-aware factories/templates/steering can be exercised; the
  three-platform robustness CI remains a release gate. Reverse explicitly if
  the maintainer disagrees.
- Partial wave-1 edits are preserved uncommitted plus on `wip/claude-wave1-*`
  branches rather than committed on the integration branches, because none of
  them were verified.
- Desktop paired tests use `SPECRAILS_CORE_SOURCE_DIR`/`SPECRAILS_EFFICIENCY_CORE_ROOT`
  instead of a `/private/tmp/specrails-core` symlink.
- No merge, no release, no telemetry evidence invented; D8 retirement and C10
  remain gated.

## User scope and authority

Implement Core engine v2 with LangGraph, all pieces and lifecycle operations;
Desktop integration and an n8n-style visual editor with drag/drop, connections,
all configuration options, human interaction, recovery and reusable workflows;
optimize agent quality/cost, CI, releases and testing; update Core/Desktop/Web
documentation; solve discovered gaps. Branches and PR creation are authorized.
The user requested autonomy and no postponed implementation. Actual rollout
evidence cannot be invented: the two-release legacy retirement gate still needs
real releases and telemetry. No merge or release has been performed.

The briefing, complete contracts and plan were read in that order. Paired OpenSpec
artifacts were created, validated and committed before code. Original supplied
documents were `/Users/javi/Desktop/core-agent-engine{,-contracts,-implementer-brief,-tasks-core,-tasks-desktop}.md`;
the paired change contains the working contracts, tasks and reference plan.
Read this checkpoint, the Desktop checkpoint documents, and then the remaining
tasks. Preserve already accepted foundation work.

## Branches and durable review artifacts

| Work | Branch / local checkout | PR |
| --- | --- | --- |
| Core C0 | `feat/core-engine-c0`, `/Users/javi/repos/specrails-core` | [385](https://github.com/fjpulidop/specrails-core/pull/385) |
| Core C1 SQLite/public LangGraph probes | `feat/core-engine-c1`, `/private/tmp/specrails-core-engine-c1` | [386](https://github.com/fjpulidop/specrails-core/pull/386) |
| Core C2 open roles | `feat/core-engine-c2`, `/private/tmp/specrails-core-engine-c2` | [387](https://github.com/fjpulidop/specrails-core/pull/387) |
| Desktop D0 | `feat/core-engine-d0`, `/Users/javi/repos/specrails-desktop` | [706](https://github.com/fjpulidop/specrails-desktop/pull/706) |
| Core CI | `codex/ci-engine-optimization`, `/private/tmp/specrails-core-ci-engine` | [388](https://github.com/fjpulidop/specrails-core/pull/388) |
| Desktop CI/release | `codex/ci-engine-optimization`, `/private/tmp/specrails-desktop-ci-engine` | [707](https://github.com/fjpulidop/specrails-desktop/pull/707) |
| Web rollout notes | `docs/core-engine-rollout`, `/private/tmp/specrails-web-engine-docs` | [218](https://github.com/fjpulidop/specrails-web/pull/218) |
| Integrated Core WIP | `feat/core-engine-v2`, `/private/tmp/specrails-core-engine-v2` | [389](https://github.com/fjpulidop/specrails-core/pull/389) |
| Integrated Desktop WIP | `feat/core-engine-desktop-v2`, `/private/tmp/specrails-desktop-engine` | [708](https://github.com/fjpulidop/specrails-desktop/pull/708) |

Foundation and CI PRs are ready for review. Integration PRs remain drafts. Every
created PR is attached to the Codex task. Temporary checkouts may disappear after
OS cleanup; use the pushed branches. Preserve unrelated untracked user work in
the original Web checkout. Do not reset or clean original repositories.

Integration Core started from C0 evidence `11665acb`, merged C1 through
`29ab492e` in `33257b7b`, and applied the C2 production patch without its OpenSpec
ancestry. Reconcile the remaining C1 evidence/ancestry (`d2569939`, `e1e25589`,
`7ef947df`) and C2 (`4ad57b54`, `ac48c1a0`) before final PR stacking. Production
ACL fixes are already present. Desktop started from D0 `70c9e8a4`. The verified
CI/release implementation from PR707 `97cfabbb` was copied into integration;
reconcile its documentation and branch ancestry later, preserving feature edits.

## Accepted evidence

- C0 CI `36227847244`: green; 1,004 tests passed, one existing Windows skip,
  24 script tests, four package assemblies and frozen journals.
- C1 final three-platform CI `36230546712`: green on exact Node **22.22.3**,
  actual Desktop assembly and npm consumer. 200 SIGKILL boundaries per platform.
  Mean SQLite put: macOS 0.282 ms, Linux 0.721 ms, Windows 4.164 ms (<5 ms).
  Accepted binding: `node:sqlite`; minimum Node 22.22.3. Full suite 998 passed,
  one existing skip; scripts 24. This is probe evidence, not production C3 proof.
- C2: 1,030 tests passed, one existing skip, scripts 24, four packages and the
  frozen built-in argv goldens. Legacy identities remain workflow **7** and
  instructions **10**, API **1**, integration schema **5.1**.
- D0 final CI `36228425753` and Windows parity `36228427506`: green.
  Server 8,794 passed/8 existing skips, client 4,647 passed, scripts 86.
- Core CI optimization `36230750772`: all gates green. Removes duplicate
  Ubuntu/Node24 full lane while retaining coverage and tested release tarball.
- Desktop CI optimization `36233342790`: all 18 checks green in **4m05s**,
  versus 15m50s baseline. Server shards 1m43s–2m42s, client 2m18s–3m10s,
  aggregation 35s/43s. Earlier queued run `36230773446` took 22m52s: retain this
  distinction; do not promise hosted runner latency. All 94 script tests passed.
  Exact-SHA trusted frontend reuse includes authenticated missing/expired-asset
  rebuild once, with no fallback for corruption/API/identity failures.
- Integrated Core latest focused composition checks: **48/48** across runs,
  graph description, prompts, role state, open roles and integration contract.
  Additional compiler suites, pieces, native implementation/QuickSDD/Batch,
  SQLite crash/store/inbox/lease/fork suites passed during development; their
  evidence is in agent checkpoint notes and local logs. Not a final full CI run.
- Offline focused correction evaluation: **2/2 independently accepted**, no
  extra invocations, prompt **2,879 → 1,595 bytes (44.60% reduction)**, exceeding
  the 40% target. This does not establish paid monetary savings. Full initial
  definition corpus was 10/10 before subsequent changes; rerun at final source.

## Implemented Core structure

`src/agent-runtime/engine/` contains strict canonical JSON/hash validation, the
published schema and actual 16-piece registry, LangGraph compilation, nested
components/Send maps/deferred joins, isolated state, FIFO effect/AI admission,
intersected budgets, durable SQLite saver/ledger/leases, fork, cancellation,
steering inbox, project memory and optional OTLP HTTP telemetry. Provider turns
reuse the existing invoker with SQLite-scoped session/memo/accounting ports.
Implementation delegates to the native Core nodes/journal instead of copying
their business rules. Role settings and native command policy are open (C2).

The CLI supports definition run/validate/catalog, status, resume, fork, signal,
cancel, invalidate-by-fork and evaluate definitions. Both fatal CLI entry points
emit JSON. SDK and definition-schema exports are added. **Engine v2 capability is
still intentionally unadvertised** in `runtime api`/integration engine metadata;
enable and update parity tests only once integrated/package acceptance is ready.

Important completed decisions:

- Every terminal effect and LangGraph pending write share a SQLite transaction;
  effects/AI permits are released only after commit. An uncertain write needs
  explicit recovery. Durable provider usage is charged once by invocation ID.
- Pending or unreported billing remains unknown; residual reservations retain
  unknown dimensions rather than releasing spent but unreported headroom.
- Parent coordinators do not hold child permits. Sessions are shared across
  developer/fixer within one implementation but isolated across map branches.
- Forks copy public checkpoint history and preserve completed siblings; only
  incomplete implementations restore/rebind their exact journal snapshot.
  Completed implementation evidence stays inherited/read-only. Candidate scope
  snapshots preserve exact metadata exclusions; actual code changes invalidate
  inherited certification. `$vars`/`$outputs` patches clear certification.
- Fork archive only normalizes the exact OpenSpec-generated default Purpose to
  original provenance; authored Purpose or different requirements still conflict.
  Original run databases/journals/spec files must remain unchanged.
- Claimed steering reaches both prompt and role-turn exactly once. Custom role
  prompts are preserved. A transport with `resumeRequiresFullContext` receives
  full instructions even when a session ID is supplied. Custom escalation uses
  the existing single protocol-repair slot, with no added speculative turns.
- Focused correction removes only Node internal dispatch frames, retaining
  assertions, actual/expected values, application frames and complete evidence
  IDs. Legacy prompt/argv defaults remain unchanged.
- `settlePause()` runs after the graph reaches the idle interrupt barrier;
  parallel branches cannot leave a paused run marked running.
- Status is read-only: no filesystem fingerprint, permissions mutation or lease
  acquisition. It includes pending interruptions, reservations, lease, recovery
  attempts, durable efficiency summary and active duration excluding human wait.
  Final create/resume status is projected after releasing the execution lease.

## Required next work (do not silently defer)

1. Read the paired Desktop `CHECKPOINT-D1-D3.md`, `CHECKPOINT-D1B-D5.md` and
   `CHECKPOINT.md` (D4). Finish their precise pending integration/recovery work.
   Do not reimplement the already complete visual authoring or role settings.
2. Add **production** C3 robustness: actual CLI 30-node graph, SIGKILL before,
   during and after writes; real lease expiration/two-process contention;
   explicit `--recover`; graceful cancellation and checkpoint behavior; run on
   Linux/macOS/Windows exact Node22.22.3 with the actual installed npm package.
   Existing six low-level SIGKILL tests and C1 probes do not replace this gate.
3. Finish CLI/package acceptance tests for the latest fork/invalidate, structured
   fatal errors, status/efficiency summary and public engine SDK/schema exports.
   `scripts/verify-package.mjs` still only exercises legacy workflow; extend it
   with actual installed v2 execution/resume/fork. No fake capabilities.
4. Re-run full offline evaluation against final source (including correction
   target and all independent behavioral oracles). Paid cost claims require real
   billing; do not run unbounded paid benchmarks or invent savings.
5. Advertise actual v2 API/integration capability and 16 node kinds, add package
   compatibility/retained-runtime tests, and complete the frozen request contract.
   Currently v2 context/config/definition are authoritative in SQLite, while
   legacy request files remain separate. Verify Desktop's retained host metadata.
6. Desktop D4 has storage migration/APIs but backend recovery, orphan restart,
   isolated delivery reattachment and fork routes are not complete. Preserve
   worktree/settlement ownership and paused runs across restart.
7. Desktop D5 four factories exist; **eight named starter templates remain**.
   D6 telemetry/deprecation, D7 full steering UI, D8 migration/retirement and any
   pending D3 graph/fork visualization require completion/verification.
8. Complete Core/Desktop guides and Web's eight-language user documentation.
   Web PR218 currently contains rollout notes only. Complete C9 docs/evaluation
   and prepare C10/D8 retirement with real rollout gates, not fabricated history.
9. Run required full Core/Desktop coverage, typecheck, architecture, source map,
   build/package/provider and native gates; never lower thresholds. Review
   generated boundary manifests instead of bypassing fixed architecture rules.
10. Reconcile stacked branches/evidence, rewrite draft PRs for final scope,
    publish all required implementation PRs and attach them to the task.

## Local execution and continuation

- Exact Node22: `/private/tmp/specrails-engine-tools/node-v22.22.3-darwin-arm64/bin`.
  Prepend to PATH for Core; its modules are symlinked to the original Core tree.
- Desktop local shared `better-sqlite3` is built for system Node25.9 ABI141.
  Use system Node for local Desktop tests; **do not rebuild shared native deps**.
  CI uses independent exact Node22 trees. Root/client have separate installs.
- OpenSpec global1.2 is stale. Use
  `/Users/javi/repos/specrails-core/node_modules/.bin/openspec` (1.4.1).
- actionlint: `/private/tmp/specrails-engine-tools/actionlint/actionlint -shellcheck=`.
- Useful local logs: `/private/tmp/core-v2-composition-tests.log`,
  `/private/tmp/core-v2-checkpoint-{typecheck,build}.log`,
  `/private/tmp/desktop-engine-checkpoint-typecheck.log`,
  `/private/tmp/core-engine-v2-focused-correction/evaluation.json`.
- Sandbox may block Git metadata/network; authorized branch/PR operations work
  with normal escalation. Sandbox `gh` authentication failure is not reliable.
- No recurring automation was created. Resume when the user has quota, from this
  checkpoint and the pushed integration branches, preserving the complete goal.

## Saved checkpoint references

Core source commit: `9ae02add`; Desktop source commit: `4c84e95c`. Both pushed.
Final checkpoint verification: Core typecheck/build pass and focused tests 48/48;
Desktop full typecheck and architecture pass. The working trees were clean after
source commits. Later documentation-only commits add these cross-references.
Read `CHECKPOINT-C3-C7-C8.md` in Core for detailed persistence/fork notes.

### Cancellation and recovery coverage — 26 September 2026, 22:42 CEST

Inactive cancellation now has a project/run-scoped observer: Core acknowledgement
precedes waiting for the writer lease, terminal replay and original settlement.
Resident tasks retain their callback. Shutdown defers to startup; an unavailable
status or expired observation window records a durable control diagnostic.
Writing runs missing their original settlement snapshot are not misclassified as
standalone work. The saved-run client uses the definition cancellation endpoint.
Focused validation: cancellation/admission/manager controls 48 tests, client
saved-run/header 37, architecture/cancellation 27; typecheck and architecture
passed before the subsequent run-graph client work.

Full server coverage on the stable cancellation tree: 400 suites / 8,942 tests
passed, two Windows-only suites / seven cases skipped, 195.38 seconds with two
workers. Statements 86.99%, branches 80.15%, functions 90.85%, lines 90.03%; original
thresholds unchanged. Two four-worker attempts failed separate HTTP cases: a
socket hang-up in rails-router (188 tests pass separately), then MCP stale-session
404 versus 401 (26 relevant tests pass separately). Added response-body failure
diagnostics to the latter; no production cause or flakiness fix is claimed. One
focused diagnostic command briefly used CLI coverage overrides, was interrupted,
and is discarded; no configuration threshold was changed and it is not acceptance
evidence. The complete successful run above used the original coverage gates.

Web PR #218 is now draft. Commit 5287c7b stages Loop Builder/run-detail additions
in eight languages; docs sync/check, six sync tests and production build passed.
No Web deployment, PR merge or release occurred.

## Fork transport crash boundary — 26 September 2026, 23:04 CEST

Core 01c519ba adds durable idempotent fork receipts. Desktop forwards request IDs,
compares existing frozen files and preserves published children after a lost
acknowledgement/materialization error instead of deleting their databases. Actual
paired CLI coverage reproduces partial host-file materialization, retries it and
verifies source/child bytes unchanged; 34 bridge/recovery tests and full typecheck
passed. The HTTP admission, delivery ownership transfer and client action remain
the next D3 work; the transport fix alone does not close task 5.2.

## Recovered delivery evidence — 26 September 2026, 23:07 CEST

Recovered settlement now rebuilds evidence from all completed sibling runs, using
bounded retained-Core probes, instead of overwriting the delivery packet with only
the last recovered run. Terminal admission uses compact authoritative status;
unavailable full evidence marks the harvest failed without losing valid terminal
completion. Ticketless repository legs retain their branch/worktree record using
the existing ticket-0 sentinel. Regression passed 205 tests across isolated launch,
recovery and evidence; full typecheck passed. Multi-repository real-Git acceptance
and pre-migration snapshot reconstruction remain required.
