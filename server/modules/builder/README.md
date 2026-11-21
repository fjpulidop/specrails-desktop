# builder

This module owns the builder capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/blueprint-chat-manager.ts](runtime/blueprint-chat-manager.ts)
- [runtime/blueprint-commit.ts](runtime/blueprint-commit.ts)
- [runtime/blueprint-draft-parser.ts](runtime/blueprint-draft-parser.ts)
- [runtime/blueprint-render.ts](runtime/blueprint-render.ts)
- [runtime/blueprint-router.ts](runtime/blueprint-router.ts)
- [runtime/blueprint-spec-quality.ts](runtime/blueprint-spec-quality.ts)
- [runtime/blueprint-types.ts](runtime/blueprint-types.ts)
- [runtime/milestone-chain-store.ts](runtime/milestone-chain-store.ts)
- [runtime/milestone-chain.ts](runtime/milestone-chain.ts)
- [runtime/milestone-chain-reconcile.ts](runtime/milestone-chain-reconcile.ts)
- [runtime/milestone-engine-preference.ts](runtime/milestone-engine-preference.ts)
- [runtime/milestone-generation-settings.ts](runtime/milestone-generation-settings.ts)
- [runtime/milestone-progress.ts](runtime/milestone-progress.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/builder` and any affected consumers.

Production milestone chains integrate each delivery through the guarded local
merge decision before allocating the next spec worktree. Integration failures
retain the delivery for retry; restart replays pending integration. See
[project builder](../../../docs/internals/project-builder.md#incremental-spec-integration).

Chain snapshots expose `createdAt` from the existing `milestone_launch_chains.created_at`
column alongside `updatedAt`, including progress and WebSocket projections. This
additive field requires no migration.

Milestone generation preferences (provider, model and optional reasoning effort)
live in the project's `queue_state` under `blueprint.milestone_generation`
(stamped `savedAt`), and a milestone generated with another engine records it as
that milestone's own under `blueprint.milestone_engine:<id>`
(`milestone-engine-preference.ts`).
`GET/PUT /api/projects/:id/blueprint/generation-settings` expose the preference
and installed providers supporting the native read-only policy, with model-specific
effort catalogs. Validation precedes a single atomic preference write. These
settings drive future milestone conversations and the next rails of a live
chain (see below); explicit launch choices never overwrite them. No migration is needed for this existing key/value store.

M1 execution has a separate per-launch selection. `GET /blueprint/launch-settings`
returns the compatible catalog and project-primary default. The milestone launch
body may include `engine: { provider, model, reasoningEffort }`, validated before
creating a chain. Migration 92 adds nullable `engine_config` to the chain row.
The first rail runs on it; every later new rail resolves its engine at launch
(`readNextRailEngine`): the milestone's own configuration, else the current usual
configuration (whenever saved), else `engine_config`; resuming a run in place
keeps that run's engine. Launched entries record `engine` and the snapshot exposes
`nextEngine`. Legacy NULL rows keep their original behavior unless a milestone or
usual configuration applies. Rails reject a recipe-owned conflicting
engine when `requireEngineSelection` is set, preserving recipe ownership without
silently changing the user's choice.

Chain reconciliation (`milestone-chain-reconcile.ts`, pure) re-derives every
spec's state from tickets, deliveries and runs — manual ones included — before
each launch, advance and Resume, and the chain snapshot carries the resulting
`plan` (next action + offers) to every surface. See
[chain reconciliation](../../../docs/internals/project-builder.md#chain-reconciliation).
