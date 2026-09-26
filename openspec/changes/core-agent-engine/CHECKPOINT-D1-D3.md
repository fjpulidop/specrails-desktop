# D1–D3 checkpoint — 2026-09-26

User requested a checkpoint because remaining credits are limited. Work is paused
by the root agent; this document records implementation state, not completion.
Do not check the remaining OpenSpec tasks or advertise the whole v2 migration as
complete. Paired Core/Desktop OpenSpec artifacts were strictly validated before
source changes. Root owns commits, pushes, PRs and CI.

## Workspaces and ownership

- Desktop: `/private/tmp/specrails-desktop-engine`, `feat/core-engine-desktop-v2`.
- Core: `/private/tmp/specrails-core-engine-v2`, `feat/core-engine-v2`.
- Desktop tests use system Node 25 (SQLite dependency ABI 141). Core uses Node
  22.22.3 from `/private/tmp/specrails-engine-tools/node-v22.22.3-darwin-arm64/bin`.
- Core audit agent owns authoring, `loop-definition*.ts`, manager, executors,
  runtime bridge, job composer and attempt-aware loop logs.
- Core planning agent owns migration 64, definition fields in loop-runs-store,
  upcoming recovery/fork/lineage coordinator. Its separate checkpoint has details.
- Desktop audit agent owns custom roles/settings and Core factory graphs.
- Root owns Core CLI/lifecycle/composition and CI/release scripts.

## Implemented authoring

`loop-definition.ts` compiles explicit Core graphs to an unhashed draft. Core's
validator supplies canonical RFC8785 hash/definition. Compilation expands only
Desktop tokens, preserves run variables and component interfaces, includes
implementation role dependencies, budgets expanded visits, keeps node engine
selection, and includes frozen follow-up/addenda briefing. Native commands use
only nativeCommand, respecting the text/native XOR.

The Core-owned catalog and definition schema feed schema-driven forms for all
piece parameters, retry/global policies, provider/model/role selectors, typed
outcome handles, unique connections, drag/drop, components/subcanvas/breadcrumbs
and inline publication errors. Existing React Flow and theme/i18n conventions
remain. Eight guide/locales were updated. Core and legacy graphs are explicit;
unsupported engines preserve legacy factory behavior. Factory list/fork and rail
launch resolve current advertised capabilities.

Main UI files: CoreParameterForm.tsx, CoreWorkflowInspector.tsx,
LoopBuilderPage.tsx, core-authoring.ts, loops-api.ts, loop-graph-rf.ts.
Server catalog/publication: agent-runtime-loader.ts, loops-router.ts.

## Implemented execution adapter

- `loop-definition-run.ts`: one retained Core process, addressable pauses,
  explicit approvals, selected question answers, cancellation while paused.
- `agent-runtime-bridge.ts`: effective project config and validated definition
  frozen before spawn; resume uses retained runtime; accepts code 2 only for a
  real pause; separates runtimeStatus and completion; rejects conflicting run
  identity, malformed success or durable observer failure. onPrepared exposes
  immutable metadata before spawn. readFrozenRuntimeHost validates host scope.
- `loop-executors.ts`: runDefinition and support gate; no legacy traversal for
  Core graphs; forces host Git ownership; resume reads frozen host inputs.
- `loop-definition-events.ts`: durable event + physical invocation accounting
  share one SQLite transaction, via existing completeLoopStepRecovery helper.
  Uses physical invocationId, actual provider/start/finish, honest NULL values,
  cache fields and shared integer allocation. Core aggregate runtime-result is
  never inserted as another invocation. Replay is idempotent; divergent event
  content is rejected. Branch step/end correlation is by attemptId.
- `loop-run-manager.ts`: keeps ticket/job/worktree/outbox lifecycle ownership.
  saveDefinitionRun happens with initial launch. onPrepared stores canonical
  metadata. resumeDefinition reuses job/run and sequence MAX+1. Completion.ok
  false blocks delivery even when runtime execution succeeded. Human wait is
  excluded from the host timeout using Core's active duration.
- Job messages/GET expose selected interrupts. Composer requires explicit
  approval button; typed text cannot approve. Loop logs associate interleaved
  output with attemptId, show paused/concurrent branches and consume Core's
  actual runtime-graph snapshot. Completion summary shows business acceptance.

## Exact stable APIs for the next agent

`LoopRunManager.isDefinitionRunActive(runId): boolean`

`LoopRunManager.resumeDefinition(runId, { answer?, approve?: string[],
interruptId?, recover?: string[] }): Promise<LoopRunResult>`

A live paused resume resolves the existing lifecycle promise. A restart resume
uses the durable request and existing job; completed rows require a fork.

`DefinitionLoopInvocation`: request, runId, contextPath?, resume?, answer?,
approve?, interruptId?, recover?, onPrepared?, onRuntimeEvent, onLine, onSpawn,
timeoutMs. `onPrepared` includes contextPath, runtimeDirectory, definitionPath,
configPath, definitionHash, definition, context and optional runtimeIdentity.

Store APIs are saveDefinitionRun/readDefinitionRun/recordDefinitionCheckpoint/
markDefinitionRestart in loop-runs-store.ts (migration 64). Manager already uses
save/read/record. Do not create competing runtime owners in AgentRuntimeControls.

Core CLI: run --context --config --definition --change; resume --context,
--answer plus --interrupt-id, or --approve nodePath/interruptId, --recover paths.
Fork: --context --from nodePath --run-id child [--scope-id] [--visit] [--state].
Core graph envelope has contractual nodes/edges/mermaid and additive graph summary.

## Verification at checkpoint

- Authoring server: 9 files / 143 tests passed before the later launch work.
- Authoring client: 22 files / 307 tests passed before later execution UI work.
- Latest server: 4 files / **178 tests passed** (manager legacy+Core, compiler,
  real child-process bridge); `/private/tmp/desktop-engine-checkpoint-server.log`.
- Bridge/executor focused earlier: 3 files / 71 tests passed.
- Latest focused client: 3 files / **54 tests passed** (branch log projection,
  composer explicit approvals, builder interactions), before final nullable
  totals/paused overview adjustments. `/private/tmp/desktop-engine-execution-client.log`.
- Typecheck checkpoint: **passed (exit 0)**; `/private/tmp/desktop-engine-checkpoint-typecheck.log`.
- `npm run audit:architecture`: **passed (exit 0)**; server and client boundary
  audits. `/private/tmp/desktop-engine-checkpoint-architecture.log`. The earlier
  manually named frontend script was unavailable; the repository command was
  then used successfully.
- Reviewed module manifest regeneration and source-map generation performed at
  checkpoint; their logs are `/private/tmp/desktop-engine-checkpoint-*.log`.
- No full coverage/build/package/CI result for the combined implementation yet.
  Do not reuse C0/C1/D0 green CI as evidence for this unfinished integrated work.

## Remaining gaps — start here

1. D4 lineage/execution claim is NOT implemented. Before allowing resume/fork,
   exclude parent/child simultaneous writes on their shared worktree. Startup
   recovery, reattach, dedicated HTTP fork/history endpoints and ticket/outbox
   settlement across restart are pending. The new resumeDefinition method has
   typechecked but needs restart, owner conflict and concurrent claim tests.
2. Core cancellation currently uses existing Desktop process termination;
   wire Core cancel --context --request-id first, with bounded kill fallback.
   Running steering via Core signal/inbox is not wired. Paused answers work.
3. Confirm all legacy delivery verification readers recognize engineVersion 2;
   manager acceptance gate is implemented, but downstream delivery/recovery
   coordinators still need full integration tests with actual Core.
4. Optimize projection: current version rescans run invocation aggregates for
   every observed event. Cache until physical invocation changes. Also enforce
   same physical invocation payload if a different eventId repeats invocationId.
   Persist Core event cursor in the event/accounting transaction. Present
   recordDefinitionCheckpoint captures runtime-result status/pending interrupts
   outside that transaction; monotonic cursor/revision integration is pending.
5. Add actual Core/Desktop execution smoke (multiple branches + pause/resume,
   killed process, fork, null usage), not only protocol fixture subprocesses.
6. Review agent-event transient correlation end to end and structured graph
   expansion. Plain fallback human-readable log lines have no attemptId and
   remain arrival ordered. Structured Core events are correctly correlated.
7. Finish error localization, component diagnostic focus, keyboard/accessibility
   and visual QA. The authoring forms support all schema parameters, but no
   final screenshot-driven UX audit has run.
8. Run all affected HTTP routes, architecture tests, source audit, typecheck,
   root/client coverage, build/package and cross-platform compatibility gates.
   Check thresholds without lowering them. Then update task checkboxes and
   narrow docs across Desktop/Core/Web only for work actually completed.
9. Latest git diff --check reported three trailing spaces in root-owned
   `.github/workflows/desktop-release.yml` (lines 129, 503, 801); root notified.

No new features should be started until the user resumes the work.
