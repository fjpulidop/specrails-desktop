## Why

Implement requires a spec before anything is built, and the external feedback of 2026-10 showed that this fixed cost is wrong for exploratory work: users want to discover what to build by building it, the way an interactive Claude Code or Codex session works, and still get the Specrails extras (spec, OpenSpec change, verification, review, delivery). Flow is that mode. The architecture is recorded in `docs/plans/flow-arquitectura.md` (sections 1, 2, 4, 7 and 9) and the product decisions in phase 2 of the feedback implementation guide.

## What Changes

- New server capability module `server/modules/flow` (hexagonal, like project settings): a pure state machine (`active`, `paused`, `handed_off`, `delivered`, `discarded`, `needs-review`) with saga steps, use cases (start, pause, resume, discard, hand-off, delivered, reconcile) and ports for the repository, placeholder spec, worktree reservation, Core agent session, rail launch, usage, notifier and clock.
- Migration 72: `flow_sessions` in the project database, with a partial unique index (one active or paused Flow per conversation).
- Placeholder spec: ticket `source: 'flow'`, `status: in_progress`, `metadata.flow`; ticket store schema 1.4 → 1.5. Jira never creates an issue for a spec whose Flow is active or paused.
- Worktrees: Flow reserves one with delivery's `prepareIsolatedWorktree` and owns it in `flow_sessions`. The rail launch gains `requiredFlowWorktree`: it adopts the exact worktree (path, branch, frozen HEAD, else `FlowWorktreeMismatchError` 409), with ownership `adopted`, and the `rail_worktrees` row plus the Flow's `handed_off` state commit in one transaction. The rails launch route accepts `flowId`.
- Missions: an injected `FlowTurnContext` port turns a mission turn into a Flow turn: its own Core session `flow:<flowId>`, worktree cwd, `workspace-write`, default tools, the mission MCP, a static Flow persona, mid-turn input delivered as `interrupt`. No legacy transport for Flow. The send route accepts `deliveryMode: 'interrupt'` in an active Flow.
- Agent sessions ACL: additive `interrupt` delivery, `capabilities.interrupt`, `flowSessions`; `checkSessionContract` stays tolerant; Flow availability requires `flowSessions` and `deriveChange`.
- Routes under `/api/projects/:projectId/flow`, a `flow.state` WebSocket event, startup reconciliation, and Flow turns recorded with surface `flow` (cost reports billed usage only).

## Capabilities

### New Capabilities
- `flow-mode`: Flow sessions in missions with an isolated worktree, a placeholder spec, interrupt delivery, an atomic hand-off to a rail, capability gating and restart reconciliation.

### Modified Capabilities
- None (the rails launch, mission send and ticket store gain additive inputs covered by the new capability).

## Impact

- New: `server/modules/flow/**`, `server/modules/missions/runtime/{agent-flow-prompt,flow-turn-context}.ts`, `server/modules/delivery/runtime/flow-worktree-handoff.ts`, `docs/internals/flow-mode.md`.
- Changed: `server/db/migrations.ts`, `server/modules/delivery/runtime/{rail-isolated-launch,rails-router,isolated-worktree,rail-pr-store}.ts`, `server/modules/delivery/adapters/decisions/ownership.ts`, `server/modules/missions/runtime/{agent-chat-manager,agent-chat-router,core-session-runner,mission-core-sessions}.ts`, `server/modules/agent-sessions/**`, `server/modules/specs/runtime/ticket-store.ts`, `server/jira/jira-sync-manager.ts`, `server/desktop-db.ts`, accounting surfaces, composition roots, boundary manifest, docs.
- Out of scope (later changes): the client feature, the `factory:flow-spec` loop and settlement effects (spec rewrite, Jira create and review transition).
