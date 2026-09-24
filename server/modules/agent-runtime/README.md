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
