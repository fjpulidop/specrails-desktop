# Flow

Owns Flow mode: a user builds working code with an agent inside an isolated
worktree, without a spec, and then hands the worktree to a rail that derives
the spec. Design: [Flow mode](../../../docs/internals/flow-mode.md). The
module follows the [project settings](../project-settings/README.md)
ports-and-adapters slice.

## Where to change behavior

| Change | Owner |
| --- | --- |
| Lifecycle states, legal transitions, invariants, saga steps, effects | [domain.ts](domain.ts) (pure, no clock/IO) |
| Settlement plan (effect keys, order, backoff), conversation summary and spec-rewrite text builders | [domain.ts](domain.ts) (pure) |
| Use cases: start, pause, resume, discard, hand-off, delivered, settlement (run, replay, observe delivery), reconcile, read models | [application.ts](application.ts) |
| Outbound contracts (repository, tickets, worktree, agent session, rail launch, usage, notifier, clock) | [ports.ts](ports.ts) |
| `flow_sessions` SQL (migration 72) and `flow_effects` (migration 73), project database | [adapters/sqlite.ts](adapters/sqlite.ts) |
| `/api/projects/:projectId/flow/*` routes and error mapping | [adapters/http.ts](adapters/http.ts) |
| Port implementations over delivery, specs, missions/Core, accounting, WebSocket; the hand-off authority (with the conversation summary), the settlement publication (derived change, spec rewrite, Jira) and its retry scheduler; the missions `FlowTurnContext` | [adapters/bindings.ts](adapters/bindings.ts) |
| Public imports | [index.ts](index.ts) |
| Production wiring | [project-registry.ts](../../project-registry.ts) (per project), [project-router.ts](../../project-router.ts) (routes), [index.ts](../../index.ts) (missions port) |

## Lifecycle

`start` → `active` ⇄ `paused` → `handed_off` → `delivered`; `discard` from
`active`/`paused` → `discarded`; startup reconciliation may set
`needs-review` when a worktree disappeared. `step` records an unfinished
saga (`start:ticket`, `start:worktree`, `start:session`, `handoff:freeze`,
`handoff:launch`).

## Invariants

- At most one `active` or `paused` Flow per conversation (partial unique index
  plus a serialized use case).
- One owner per worktree: `flow_sessions` until the rail adopts it. The
  adoption inserts the `rail_worktrees` row and sets `handed_off` in ONE
  SQLite transaction owned by delivery (`requiredFlowWorktree.adopt`); a
  launch rolled back after adoption calls `release`, returning ownership.
- `handed_off` only with the HEAD the hand-off froze (`flow_head_mismatch`).
- `discard` is illegal after `handed_off`: the rail's delivery decides.
- Every use case is idempotent by `flowId`; a repeated command whose target
  state already holds is a no-op.
- Release removes only the Flow mount root (`worktrees/<flowId>`); a worktree
  that cannot be proven Flow's is never deleted (`needs-review`).
- Flow is gated on Core capabilities (`flowSessions` and `deriveChange`) and
  on a Core session driver for the mission's provider. Without them every
  route answers `409 feature_unavailable` and missions behave as before.
- The placeholder spec is `source: 'flow'`, `in_progress`, with
  `metadata.flow`; Jira never receives it while `active`/`paused`.
- Cost is the sum of provider-billed Flow turns (`surface = 'flow'`), never
  estimates.

Domain/application must not import Express, SQLite, Git, process APIs, Core
or other capabilities ([architecture tests](../architecture.test.ts)).
Missions never import this module; they receive `FlowTurnContext`.

## Settlement

When the Flow's delivery reaches review (`rail.pr_state` observer, or the
completed run without a PR delivery row), `onFlowDelivered` records
`delivered` and enqueues `flow:<flowId>:rewrite-spec`, `:jira-create`,
`:jira-review` in `flow_effects`. They run in order with attempts and backoff,
resume at startup (`replaySettlement`) and every 30 s, and never block or
revert the delivery. The Flow → Spec loop itself lives in `loops`
(`factory:flow-spec`). Details: [Flow mode](../../../docs/internals/flow-mode.md#settlement).

## Verify a change

```bash
npx vitest run server/modules/flow server/modules/architecture.test.ts
npx vitest run server/modules/delivery/runtime/rail-isolated-launch.flow.test.ts server/modules/delivery/runtime/rails-router.flow.test.ts
npx vitest run server/modules/missions/runtime/mission-flow-turns.test.ts server/modules/missions/runtime/core-session-runner.test.ts
npm run typecheck
```

- [Domain tests](__tests__/domain.test.ts): transition table, invariants, reconciliation.
- [Settlement tests](__tests__/settlement.test.ts): summary bounds, effect order, backoff, rewrite text.
- [Application tests](__tests__/application.test.ts): fakes; compensation at each saga step; idempotency.
- [SQLite tests](__tests__/sqlite.test.ts): isolation, unique index, adoption transaction rollback.
- [HTTP tests](__tests__/http.test.ts): routes and error mapping.
- [Binding tests](__tests__/bindings.test.ts): placeholder spec, real-git worktree, launch authority, usage, turn context.

## Reviewed public entry points

- [adapters/bindings.ts](adapters/bindings.ts)
- [adapters/http.ts](adapters/http.ts)
- [adapters/sqlite.ts](adapters/sqlite.ts)
- [index.ts](index.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability.
