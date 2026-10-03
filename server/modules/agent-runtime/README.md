# agent-runtime

This module owns the agent-runtime capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/agent-runtime-accounting.ts](runtime/agent-runtime-accounting.ts)
- [runtime/agent-runtime-bridge.ts](runtime/agent-runtime-bridge.ts)
- [runtime/agent-runtime-controls-router.ts](runtime/agent-runtime-controls-router.ts)
- [runtime/agent-runtime-controls.ts](runtime/agent-runtime-controls.ts)
- [runtime/agent-runtime-events.ts](runtime/agent-runtime-events.ts)
- [runtime/agent-runtime-loader.ts](runtime/agent-runtime-loader.ts)
- [runtime/agent-runtime-package.ts](runtime/agent-runtime-package.ts)
- [runtime/agent-runtime-paths.ts](runtime/agent-runtime-paths.ts)
- [runtime/agent-runtime-recovery.ts](runtime/agent-runtime-recovery.ts)
- [runtime/agent-runtime-retention-records.ts](runtime/agent-runtime-retention-records.ts)
- [runtime/agent-runtime-settings-router.ts](runtime/agent-runtime-settings-router.ts)
- [runtime/agent-runtime-settings.ts](runtime/agent-runtime-settings.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/agent-runtime` and any affected consumers.

Readable verification logs fold long quoted assertion-input blocks, including
blocks spanning runtime events, while preserving the assertion, expected value,
application stack and original raw events. Failed results without an explicit
Core error or completion reason retain the latest unresolved step failure instead
of replacing it with a generic exit message; successful results ignore that
fallback, so a recovered step does not make the whole job fail. Recovery clears
that step's fallback only in its own scope; failed projections preserve the
resolved diagnostic for later history reads.

## Loop admission

For graphs with `config.agents`, the bridge validates explicit loop definitions,
resolves global connections, and reads only verification commands from the
project runtime file. Project agents, global prompt overrides and launch model
choices do not replace the loop assignments. The compiler receives the resolved
loop engines, including connection defaults. Selection provenance uses
`loop-role`. New independent implementation graphs require loop-owned agents.
Resume refuses replacement configuration and uses the retained run snapshot.
See [workflow ownership](../../../docs/internals/desktop-owned-workflows.md).

For new definition runs, repositories without selected configured checks reuse
Desktop's offline verification detector against their admitted worktrees and code
workspaces. Explicit checks take precedence. Detected commands are frozen in the
run configuration, never persisted to project settings or rediscovered on resume.
Configured-only verification gates reject missing repository checks and plans over
100 commands before spawning Core. Gates consuming structured agent proposals
retain their existing admission policy.

## Configured roles

`workflowRoleDefaults` exposes app-owned read-only decision-role defaults.
`bindWorkflowRoleDefaults` applies only descriptors declared by a compiled graph,
preserves explicit project engine selections and rejects incompatible policies.
Admission freezes these defaults after launch overrides; saved runs reuse them.

For converted workflows, the bridge accepts explicit custom-role bindings owned
by the launch. The pure compiler sees those same effective assignments. Only
roles declared by its definition can be selected; built-in roles cannot be
replaced through this path. Core validates provider, model and policy before
admission. Selection provenance records `explicit-workflow-selection`, and the
frozen run configuration keeps the selected decision engine through pause and
resume without changing project role settings. Resume rejects replacement
bindings and uses the retained configuration.

The three built-in assignments remain in `agents`. Additional role descriptors
live in `roles` and declare source access, artifact access, provider/model, optional
OpenSpec skill and instructions. Settings reuse the provider and effort controls;
new custom roles default to read access with no artifact writes. Built-in policy
cannot be overridden. Settings validation, global connection migration and launch
resolution preserve every declared assignment. Saving custom roles requires the
paired Core's `openRoles: 1` capability; unsupported settings fail before writes.

Capability rows must match all submitted role/engine selections, including
escalations, with no fixed row ceiling. Frozen runs keep their original role map.
See [the role and factory decisions](../../../openspec/changes/core-agent-engine/desktop-role-factory-protocol.md).

## Runtime catalog compatibility

The CLI loader accepts optional engine, node kind and builtin descriptors while
retaining API 1 compatibility. `validateWorkflowDefinition` is capability-gated;
Core owns definition validation and hashing, including structured validation
errors returned with exit 1. Catalog metadata alone never enables execution.

Compact v2 status supplies the run's step catalog and `nextNodePath`, normalized
to existing Desktop controls. Resume first validates safe node paths, then exact
membership in the saved run. Metrics use those steps and role IDs from the frozen
runtime configuration. Legacy runs retain their six phases and three-role
summary validation. Historical projections without an authoritative catalog keep
the legacy fallback until D2 supplies the graph projection. SQLite status stays
uncached because a legacy journal cannot represent its WAL revision.

## Recovery diagnosis

`GET /agent-runtime/runs/:runId/diagnosis` is a read-only assessment of the
original run. It reports completed phases, original worktree scope, bounded
Core failure history and verification/acceptance invalidation reasons. Repeated
identical failures recommend repairing the precondition before retrying;
`canResume` remains an admission flag, not a claim that retry fixes the error.
Older retained Core packages without failure history report unknown counts.
No provider, mutation, automatic retry or checkpoint migration is performed.

## Scoped recovery

The recovery adapter owns the strict HTTP request contract and retained-Core
transport. The controller reserves the stopped run/rail and records mutation
outcomes. Core's `scopedRecovery: 1` capability owns filesystem access, the shared
workflow lease, guarded exact patches, registered checks and durable idempotency.
The new adapter dependency and MCP public subpath are reviewed in boundaries.json;
no lifecycle ownership moves into MCP. Older retained runtimes fail explicitly.

## Durable steering

`POST /agent-runtime/runs/:runId/steer` validates text and a stable request id, checks the project and frozen context, then sends stdin to the retained Core signal command. Core owns idempotency and receipt timestamps. Status projects pending versus consumed receipts with bounded previews; missing older-runtime reporting remains unknown. MCP exposes the same operation as `runtime_steer` with write permission. See [live steering](../../../docs/agent-live-steering.md).

## History retention

Saved runtime history is kept indefinitely unless a project sets a retention
policy. Routes (project scoped):

- `GET /agent-runtime/retention` → `{ policy: { days: number | null } }`
- `PUT /agent-runtime/retention` with `{ days }` (null or 1..3650); 400
  `invalid_retention_policy` otherwise.
- `POST /agent-runtime/retention/collect` with optional `{ dryRun: boolean }`
  (default `true`). Returns `{ dryRun, runs: [{ runId, collect, reasons, state }],
  packages, errors }`; 409 `runtime_retention_busy` while another collection runs.

`agent-runtime-retention.ts` is the pure policy and coordinator,
`agent-runtime-retention-host.ts` binds claims, fresh Core status and delivery/
fork evidence, `agent-runtime-retention-quarantine.ts` owns the crash-safe
journal protocol and `agent-runtime-package-gc.ts` collects unreferenced
packages under `agent-runtime-package-lock.ts`. Expired runs keep a
`runtime_retention_records` row and report `status: 'expired'`; resume, fork and
execution claims reject them with 410 `runtime_history_expired`. Jobs, cost
records and repository content are never touched. See
[the retention decision](../../../openspec/changes/core-agent-engine/RUNTIME-RETENTION-DECISION.md).

Readable verification logs suppress passing Node spec (`✔`) and TAP cases and their timing/YAML
blocks while keeping failed cases, diagnostic blocks and totals. Long assertion/source dump lines are shortened in the readable log. Raw runtime
events retain the full output. Failed gate outcomes and role error messages are
reported explicitly in the readable log.
Failed terminal completion reasons are preserved as the job error when Core has no
more specific runtime error, so a scoped correction blocker is not replaced by a
generic unsuccessful-Core-exit message.
