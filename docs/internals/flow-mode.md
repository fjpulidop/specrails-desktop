# Flow mode

Flow is a mode complementary to Implement: the user builds working code with
an agent in an isolated worktree, by conversation and without a spec. When
the user decides the result is right, a rail adopts the worktree and derives
the spec (the Flow → Spec loop). Implement is for delegating; Flow is for
discovering.

This guide covers the server side that exists today. The client (Flow bar,
cards, composer, board label), the `factory:flow-spec` loop and settlement
effects (spec rewrite, Jira create and review transition) are later changes.
OpenSpec change: [`flow-mode`](../../openspec/changes/flow-mode/).

## Where each responsibility lives

| Concern | Owner |
| --- | --- |
| Lifecycle, sagas, reconciliation, routes | [Flow module](../../server/modules/flow/README.md) (hexagonal, like project settings) |
| Worktree machinery | delivery: `prepareIsolatedWorktree` (reservation), `launchIsolatedRail` with `requiredFlowWorktree` (adoption) |
| Flow turn (cwd, persona, permissions, interrupt) | missions, through the injected `FlowTurnContext` port |
| Interrupting a running turn | Core sessions (`session.send { delivery: 'interrupt' }`) |
| Placeholder spec | specs ticket store (`source: 'flow'`, schema 1.5) |
| Accounting | `agent_invocations.surface = 'flow'` |

Core is the engine and Desktop the product: Desktop never branches by
provider for Flow. Flow turns run only on Core agent sessions; there is no
legacy transport.

## Capability gating

`GET /api/projects/:id/flow/availability` is the client's switch. Flow is
available only when Core sessions are usable and the selected Core runtime
advertises `flowSessions` (interrupt delivery, Core PR #435) and
`deriveChange` (the derive-change node). Starting also requires a session
host whose `initialize.capabilities.flowSessions` is 1 and a Core session
driver for the mission's provider. Otherwise the routes answer
`409 feature_unavailable` with the missing capabilities and nothing changes
for missions. The anti-corruption layer (`agent-sessions/domain/protocol.ts`)
reads the new `deliveries`/`capabilities` contract fields additively;
`checkSessionContract` stays compatible with older Cores.

## Lifecycle

```
          start          pause            hand-off          delivered
(none) ─────────► active ◄─────► paused ───────────► handed_off ─────────► delivered
                    │  resume                         │
                    │ discard                         │ launch failed
                    ▼                                 ▼
                discarded                           paused
```

`needs-review` is set only by startup reconciliation, when the Flow's
worktree disappeared. The state machine (`flow/domain.ts`) is pure; it returns
effects that the use cases execute through ports.

### Start (saga)

1. Insert the `flow_sessions` row (`active`, step `start:ticket`). The partial
   unique index allows one active/paused Flow per conversation.
2. Create the placeholder spec through the non-promoting path:
   `status: in_progress`, `source: 'flow'`, title and description from the
   idea, `metadata.flow = { conversationId, flowId, worktreeId, startedAt,
   state: 'active', chosenMode: 'flow' }`.
3. Reserve the worktree with `prepareIsolatedWorktree` (branch from the
   ticket; mount `~/.specrails/projects/<slug>/worktrees/<flowId>/ticket-<id>`).
   `flow_sessions` owns it; `rail_worktrees` does not see it.
4. Record the Core session id `flow:<flowId>`. The Core session opens lazily
   on the first Flow turn, with the worktree as cwd.

A failure compensates in reverse order (release the worktree, delete the
spec) and marks the Flow `discarded`; when compensation itself fails the row
stays `needs-review`.

### Turns

While the Flow is `active`, `FlowTurnContext.forConversation` returns
`{ cwd, coreSessionId, systemPrompt, policy }` and the mission turn becomes a
Flow turn:

- its own Core session `flow:<flowId>` (cwd is fixed at open, so the
  mission's session stays intact and resumes after the Flow);
- `permissions: 'workspace-write'`, `tools: { mode: 'default' }`, the same
  Specrails MCP the mission presents, sub-agents disabled (the Flow session is
  not projected like the mission's, so their usage could not be accounted);
- the static Flow persona ([agent-flow-prompt.ts](../../server/modules/missions/runtime/agent-flow-prompt.ts))
  as the session `systemPrompt`, never a file in the worktree; per-turn facts
  (worktree path, branch) ride the user turn;
- the conversation history is sent once, on the first turn of the Flow
  session; Core's journal keeps the rest;
- every mid-turn input is delivered as `delivery: 'interrupt'` (the send
  route accepts `deliveryMode: 'interrupt'` only in an active Flow). Desktop
  never calls `session.interrupt` first. The runner follows the correction's
  turn and records ONE invocation with the usage of both turns;
- the provider session reference never overwrites the mission's
  `session_id`; usage is recorded with `surface: 'flow'`.

When the Flow is paused or ended the port returns null and turns are normal
read-only mission turns again.

### Pause, resume, discard

Pause closes the Core session (stopping a running Flow turn) and labels the
spec `paused`. Resume reopens it lazily (Core resumes a closed session from
its journal). Discard closes the session, removes the Flow-owned worktree and
branch and deletes the placeholder spec. Discard after a hand-off is illegal.

### Hand-off

`POST /flow/:flowId/hand-off { railIndex, loopId?… }`:

1. Close the session; step `handoff:freeze`.
2. Commit the worktree (overlay and warm `node_modules` excluded) and record
   the frozen HEAD; step `handoff:launch`.
3. Assign the spec to the free rail and call the rails launch route over
   loopback with `flowId` (the single launch authority keeps every guard).
4. The launch passes `requiredFlowWorktree` to `launchIsolatedRail`, which
   reuses the exact mount (`reuseBranchWorktree: true`, `fresh: false`) and
   verifies path, branch and `HEAD == headSha` (else
   `FlowWorktreeMismatchError`, 409). Ownership becomes `adopted` (released
   like `created` once the rail owns it, never removed by an allocation
   rollback). The `rail_worktrees` row and `flow_sessions.state = handed_off`
   commit in one transaction; a rollback after adoption returns ownership.
5. Any failure before that commit reverts the Flow to `paused`.

`onFlowDelivered` records `delivered` and sets `metadata.flow.state` to
`delivered`; the settlement effects are enqueued by the Flow → Spec change.

### Restart

At project startup, after rail worktree reconciliation and before admission
opens: `active` Flows become `paused` (sessions never survive a restart);
`start:ticket`/`start:worktree` are compensated; `start:session` and
`handoff:*` complete as `paused`; a missing worktree becomes `needs-review`
(nothing is deleted). Handed-off and terminal Flows are untouched.

## Jira

`isFlowHeldTicket` (metadata.flow state `active` or `paused`) blocks every
Jira create: promote returns an error and a durable `create` outbox op is
retried until the Flow settles (dead-lettered after the normal attempt
limit). Unlinked tickets never receive outbound writes otherwise.

## Events and cost

`flow.state { projectId, conversationId, flowId, flow, timestamp }` is
broadcast on every committed change. `GET /flow/:flowId/cost` sums only
provider-billed Flow turns in the Flow's lifetime and reports
`unpricedTurns` separately; project spending exposes `flowCostUsd` and
`flowTurns` inside the agent-mission summary.

## Known limitations

- The Flow → Spec loop is not registered yet. A hand-off without `loopId`
  requests `factory:flow-spec` (never the rail's default loop), which the
  launch route refuses until the flow-spec-loop change registers it; pass an
  explicit `loopId` meanwhile. `factory:flow-spec` without `flowId` is
  already refused.
- A conversation re-pinned to another project while a Flow is open stops
  resolving the Flow (turns become normal mission turns).
- Sub-agents are disabled in Flow sessions.
