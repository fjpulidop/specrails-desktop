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
| Settlement plan (effect keys, order, backoff), conversation summary (message window, reply first lines), Back to Flow briefing and spec-rewrite text builders | [domain.ts](domain.ts) (pure) |
| Use cases: start, pause, resume, discard, hand-off, Back to Flow / Relaunch (by delivery), return-briefing delivery, delivered, settlement (run, replay, observe delivery), reconcile, read models | [application.ts](application.ts) |
| Outbound contracts (repository, tickets, worktree, agent session, background processes, rail launch, usage, notifier, clock) | [ports.ts](ports.ts) |
| `flow_sessions` SQL (migration 74; `return_briefing` migration 78) and `flow_effects` (migration 75), project database | [adapters/sqlite.ts](adapters/sqlite.ts) |
| `/api/projects/:projectId/flow/*` routes and error mapping | [adapters/http.ts](adapters/http.ts) |
| Port implementations over delivery, specs, missions/Core, accounting, WebSocket (the background-process stop is injected by the registry); the hand-off authority (with the conversation summary), the settlement publication (derived change, spec rewrite, Jira) and its retry scheduler; the missions `FlowTurnContext` | [adapters/bindings.ts](adapters/bindings.ts) |
| Public imports | [index.ts](index.ts) |
| Production wiring | [project-registry.ts](../../project-registry.ts) (per project), [project-router.ts](../../project-router.ts) (routes), [index.ts](../../index.ts) (missions port) |

## Lifecycle

`start` → `active` ⇄ `paused` → `handed_off` → `delivered`; `discard` from
`active`/`paused` → `discarded`; `returned` (Back to Flow) from `handed_off`
→ `paused` when the Flow → Spec run stopped with requested changes (by hand)
or failed outright (automatically: `observeDelivery`/`replaySettlement` see
`deliveryState().crashed` and run the same idempotent `returnToFlow`; the
briefing carries the `FlowRunFailure` — step, runtime error, codes); startup
reconciliation may set `needs-review` when a worktree disappeared. `step` records an unfinished
saga (`start:ticket`, `start:worktree`, `start:session`, `handoff:freeze`,
`handoff:launch`).

Pause, discard and hand-off first run the `stopProcesses` effect: the dev
servers the Flow agent started in the worktree (`specrails_jobs
background_start`, tagged `flowId`) stop before the worktree is frozen,
removed or handed to a rail. Best effort, like closing the session.

## Invariants

- At most one `active` or `paused` Flow per conversation (partial unique index
  plus a serialized use case).
- One owner per worktree: `flow_sessions` until the rail adopts it. The
  adoption inserts the `rail_worktrees` row and sets `handed_off` in ONE
  SQLite transaction owned by delivery (`requiredFlowWorktree.adopt`); a
  launch rolled back after adoption calls `release`, returning ownership.
- `handed_off` only with the HEAD the hand-off froze (`flow_head_mismatch`).
- `discard` is illegal after `handed_off`: the rail's delivery decides.
- Back to Flow is the inverse of the adoption: delivery's ONE transaction
  (`returnFlowWorktree`) deletes the `rail_worktrees` row, closes the delivery
  (`returned_to_flow`) and runs the Flow's `returned` save; the worktree is
  never touched. The review rides the next Flow turn once
  (`returnBriefing`), then `briefingDelivered` clears it.
- The stopped run's derived OpenSpec change (`derivation.change` in the
  delivery evidence) is recorded on the Flow (`derivedChanges`, migration 79;
  read lazily from the returned delivery for Flows returned before it). The
  next freeze allows exactly those active changes (any other new active change
  still blocks) and the next Flow → Spec run re-derives the latest one in place
  (`flowDerivationChangeId`); only the first derivation is named after the spec.
- Flow → Spec runs on the engine the person uses in the Flow: the hand-off
  card preselects the conversation's current provider/model/effort (rail
  default plus a note when that provider is not usable here) and Relaunch uses
  `agent.launchEngine` the same way (the stopped run's engine otherwise).
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
- A Flow runs in ONE Git repository. `resolveFlowRepository` (domain) picks it
  before any effect from the `repositories` port: never triaged for a
  single-repository project; otherwise the explicit Git member, else the Git
  primary, else the only Git member (`flow_repository_required` /
  `flow_repository_not_git` / `flow_repository_unknown`). A non-primary choice
  is `repositoryId` on the session (migration 80) and is passed to every
  worktree, launch and settlement port call; the primary is NULL, so those
  calls stay byte-identical to the single-repository behaviour. The hand-off
  launches exactly that repository and the Flow adopts the group's parent
  delivery ([flow mode](../../../docs/internals/flow-mode.md#workspaces-and-multi-repository-projects)).

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
npx vitest run server/modules/delivery/runtime/rail-isolated-launch.flow.test.ts server/modules/delivery/runtime/rails-router.flow.test.ts server/modules/delivery/runtime/flow-worktree-return.test.ts
npx vitest run server/modules/missions/runtime/mission-flow-turns.test.ts server/modules/missions/runtime/core-session-runner.test.ts
npm run typecheck
```

- [Domain tests](__tests__/domain.test.ts): transition table, invariants, reconciliation.
- [Settlement tests](__tests__/settlement.test.ts): summary bounds, message window (SQLite vs ISO times), reply first lines, effect order, backoff, rewrite text.
- [Application tests](__tests__/application.test.ts): fakes; compensation at each saga step; idempotency; Back to Flow and Relaunch; automatic return of a failed run (idempotent, never for requested changes or a relaunched Flow).
- [SQLite tests](__tests__/sqlite.test.ts): isolation, unique index, adoption transaction rollback.
- [HTTP tests](__tests__/http.test.ts): routes and error mapping.
- [Binding tests](__tests__/bindings.test.ts): placeholder spec, real-git worktree, launch authority, usage, turn context, real-shaped conversation summary, Back to Flow and the automatic return of a failed run over real SQLite.

## Reviewed public entry points

- [adapters/bindings.ts](adapters/bindings.ts)
- [adapters/http.ts](adapters/http.ts)
- [adapters/sqlite.ts](adapters/sqlite.ts)
- [index.ts](index.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability.
