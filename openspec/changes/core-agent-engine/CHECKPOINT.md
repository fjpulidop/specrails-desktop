# Checkpoint — D4 work paused at the user's credit boundary

Date: 2026-09-26. Working tree: `/private/tmp/specrails-desktop-engine`.
This is a recoverable implementation checkpoint, **not acceptance or completion**.
Root owns the combined commit/PR. Do not discard other agents' changes.

## D4 files written by core_planning

- `server/db/migrations.ts`: appended migration 64. Adds nullable `run_request_json`, `engine_version`, `fork_of`, `runtime_metadata_json`, `runtime_status_json`, `core_revision`, `core_event_cursor`, `fork_cut_json`, `restart_reason`, plus an index on `fork_of`. Old rows remain legacy/null; shipped migrations were not changed.
- `server/modules/loops/runtime/loop-runs-store.ts`: durable interfaces and functions below, plus optional v2 status map in orphan reconciliation.
- `server/modules/loops/runtime/loop-definition-store.test.ts`: four new behavioral tests; existing store tests remain intact.

Public APIs available now:

```ts
saveDefinitionRun(db, runId, {
  request?, source?, contextPath?, definitionPath?, definitionHash?, workflowId?,
  definition?, configPath?, runtimeDirectory?, context?, runtimeIdentity?
}) // returns {row, request, metadata}; source defaults to 'definition'
readDefinitionRun(db, runId) // {row, request, metadata} | undefined
recordDefinitionCheckpoint(db, runId, {revision?, eventCursor?, status?, ...})
markDefinitionRestart(db, runId, checkpoint?)
reconcileOrphanLoopRuns(db, finishedAt, legacyTicketIdsByRun?, definitionStates?)
```

Requests normalize `runId`, reject callbacks/non-JSON values, are bounded to 4 MiB and immutable after first save. Metadata preparation may add missing fields, never replace an existing field. Core revision/event cursors cannot regress. Restart pauses a v2 row without mutating its job or creating a terminal recovery intent. `definitionStates` uses `null` for a missing/non-resumable checkpoint; no supplied status currently retains a frozen v2 row conservatively as paused/unavailable. **Actual Core status probing and startup integration are not yet implemented.**

## Adjacent code already connected by core_audit

Ownership: core_audit owns `loop-definition-run.ts`, `loop-definition-events.ts`, `loop-run-manager.ts`, `loop-executors.ts`, and the runtime bridge. Coordinate before touching them.

- Manager saves the request after creating the loop row and saves bridge `onPrepared` metadata before spawn.
- `LoopRunManager.resumeDefinition(runId, {answer?, approve?:string[], interruptId?, recover?:string[]})` returns the lifecycle promise; it reuses the existing row/job and event sequence, without fresh ticket ownership claims.
- `isDefinitionRunActive(runId)` is available. A live human pause resumes through its current owner.
- Bridge exports `readFrozenRuntimeHost(contextPath, baseEnv, expectedRunId)`, validating identity, canonical roots, host environment whitelist and `SPECRAILS_GIT_AUTO=false`. Resume uses retained config/context instead of current project settings.

## Required next work (not started)

1. Implement a synchronous database admission guard for parent/fork and any overlapping frozen worktree. Coordinate with manager before spawn. Proposed `claimDefinitionExecution(db,runId)` must atomically reject another active owner over the same repository mount; paused rows do not imply a live process. **This guard does not exist yet.**
2. Add `loop-definition-recovery.ts`: inspect the retained Core CLI with frozen host/context; preserve engine/source/hash/context and Core revision/cut. Core now exports `state.lease` with `{owner,epoch,expiresAt,active}` and `state.recoverableSteps` with attempt/scope IDs; never infer lease expiry from `updatedAt`. `--recover` accepts exact attempt ID or an unambiguous node path.
3. Wire asynchronous status probing into `project-registry.ts` before orphan reconciliation/worktree recovery and before process admission opens. Current `_recoverOrphanLoopRuns` remains synchronous and still calls reconciliation without a status map.
4. Preserve restart-paused v2 worktrees/deliveries in `rail-isolated-launch.ts` and `rail-pr-store.ts`. `reconcileFailedBuildingPrDeliveries` currently marks any unfinished building delivery interrupted at startup; add the explicit durable v2 restart exception.
5. Implement `reattachIsolatedSettlement(ctx, deliveryId, runId)` using frozen `rail_pr_deliveries.run_ids`, `worktree_ids`, `spec_snapshot`, execution manifest and existing settlement ownership. Avoid duplicating the large closure in `launchIsolatedRail`; inspect a scoped extraction/reentry path. Preserve exact host git/verification/ticket effects and test crash recovery to `on_review`.
6. Add POST `/:projectId/loop-runs/:id/resume`, `/fork`, and pause cancellation in `project-router-loop-runs.ts`. Route v2 resume through manager, never legacy `AgentRuntimeControls.resume`. Freeze child context/package/config/host refs from the source and persist `fork_of` plus Core cut provenance. The Core fork command exists, but the Desktop backend does not.
7. Add restart-state/lineage/fork/route/delivery tests, then update module boundaries/source map/OpenSpec tasks/docs and execute appropriate full checks.

## Validation and environment

- `node_modules/.bin/vitest run server/modules/loops/runtime/loop-definition-store.test.ts server/modules/loops/runtime/loop-runs-store.test.ts --maxWorkers=1`: **16/16 passed**, Node 25.9.0.
- `node_modules/.bin/tsc --noEmit`: **passed** at this checkpoint.
- Node 22 invocation failed before tests because the shared Desktop `better-sqlite3.node` is built for Node ABI 141 (Node 25), while Node 22 requires ABI 127. Do not rebuild shared dependencies while other agents use them. Use default Node for this local Desktop tree or an isolated Node 22 install for platform verification.
- No D4 routes, real restart integration, lineage guard, isolated settlement reattachment or full CI acceptance has been claimed.

Core implementation/checkpoint details are in the paired Core `openspec/changes/core-agent-engine/CHECKPOINT.md`.
