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
- [runtime/agent-runtime-paths.ts](runtime/agent-runtime-paths.ts)
- [runtime/agent-runtime-recovery.ts](runtime/agent-runtime-recovery.ts)
- [runtime/agent-runtime-settings-router.ts](runtime/agent-runtime-settings-router.ts)
- [runtime/agent-runtime-settings.ts](runtime/agent-runtime-settings.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/agent-runtime` and any affected consumers.

## Configured roles

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
