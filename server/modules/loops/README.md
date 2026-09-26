# loops

## Legacy retirement observations

`runtime/legacy-launch-telemetry.ts` is a focused public SQLite adapter consumed
by Loop Manager, Queue Manager and isolated delivery. Migration 66 records
admission to legacy graph traversal, slash-command process launch and merge-back.
Run-scoped observations are idempotent; timestamps are normalized to UTC.
`GET /api/projects/:projectId/analytics/legacy-launches?since=<ISO timestamp>`
returns per-kind counts and the latest observation. Invalid windows return 400;
unavailable storage returns 503 rather than a fabricated zero. These are local
observations, not proof that two published releases have zero legacy usage.

This module owns the loops capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/loop-command-catalog.ts](runtime/loop-command-catalog.ts)
- [runtime/loop-constants.ts](runtime/loop-constants.ts)
- [runtime/loop-definition-recovery.ts](runtime/loop-definition-recovery.ts)
- [runtime/loop-effect.ts](runtime/loop-effect.ts)
- [runtime/loop-executors.ts](runtime/loop-executors.ts)
- [runtime/loop-factory.ts](runtime/loop-factory.ts)
- [runtime/loop-graph.ts](runtime/loop-graph.ts)
- [runtime/loop-role-engines.ts](runtime/loop-role-engines.ts)
- [runtime/loop-run-manager.ts](runtime/loop-run-manager.ts)
- [runtime/loop-runs-store.ts](runtime/loop-runs-store.ts)
- [runtime/loops-router.ts](runtime/loops-router.ts)
- [runtime/loops-store.ts](runtime/loops-store.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/loops` and any affected consumers.

Quick SDD owns delivery changes and addenda. It seeds a distinct delta target,
briefs each AI phase, and requires per-addendum coverage before validation/archive.
The retired `factory:revision` id is a compatibility alias, absent from the gallery.

When the selected Core advertises both `engineV2: 1` and `workflowDefinitions: 1`,
the same factory IDs resolve through `loop-core-factory.ts` to editable Core
definitions. Implement uses the native implementation subgraph; Batch maps frozen
tickets to isolated implementations and verifies the whole candidate after join.
Quick SDD uses two native skill prompts plus real validation, archive and host
verification before and after archive. Freestyle alternates verified edits with
an evidence-based decision and preserves the no-progress bound. Every successful
factory exit requires verified delivery. Empty configured checks cannot fabricate
a verification receipt. Older retained Core packages receive the legacy graphs.

Legacy Quick SDD also implements full specs without addenda or a PR. Its normal path is
prepare → strict preflight → apply/tests → strict validation → archive (two AI
phases). `failureRecovery` allows one in-run phase retry or an artifact-only repair
followed by revalidation; it never resets run budgets or changes the frozen target.
See [scope, recovery and metrics](../../../docs/internals/spec-addenda.md#quick-sdd-scope-and-efficiency).

## Core definition authoring

`loop-definition.ts` is a pure adapter from persisted visual graphs to Core JSON.
It resolves host tokens once, preserves component interfaces and derives a bounded
transition budget. `loops-router` obtains the authoritative piece and definition
schemas from the selected Core CLI and performs structural validation before
publication. Launch must bind and validate the actual project configuration again.
`loop-effect` conservatively isolates Core writes before role bindings are known.
The builder never mixes Core pieces with legacy Desktop execution nodes.

The client schema forms, outcome handles and component navigation consume this
catalog. Saved legacy graphs continue to use their existing editor and execution
path. See the [authoring protocol](../../../openspec/changes/core-agent-engine/desktop-authoring-protocol.md)
for publication identity and nested-budget decisions.

## Definition recovery ownership

`loop-definition-recovery.ts` probes the retained Core CLI using frozen host inputs with four subprocesses at most, a 15-second timeout per run and bounded output. Startup waits for these observations before orphan reconciliation and worktree recovery. An unavailable probe is not evidence that implementation failed. Completed Core work remains pending Desktop settlement, and restart-paused v2 deliveries retain their building state and worktrees.

The manager acquires a durable per-project execution claim before asynchronous admission. Claims fence overlapping checkout paths across distinct runs and forks, canonicalize existing symlinks and are released on errors and terminal completion. A human pause releases the claim; continuation reacquires it. Startup clears pre-allocation/terminal dead claims, preserves live or uninspectable Core owners, and keeps the exact recoverable attempt IDs supplied by Core. The per-run Core lease and the host's cross-run worktree claim enforce different ownership boundaries.

Definition resume admission is synchronous through `beginDefinitionResume`;
the returned promise represents execution completion, so HTTP can acknowledge
admission without waiting for a human question. `resumeDefinition` retains the
promise-rejection contract for existing callers. `loop-definition-controls.ts`
validates pending question/approval IDs and exact recoverable attempt IDs from
the retained Core journal. Resuming clears the restart marker so a later
recovery request cannot release an active writer's claim.
