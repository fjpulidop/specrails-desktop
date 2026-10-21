## Context

The authoritative design is `docs/plans/flow-arquitectura.md` (version 1, 2026-10-21): section 1 (principles), 2 (overview), 4 (Desktop `flow` module), 7 (patterns) and 9 (verification). This change implements its PR 6 ("flow-mode servidor") on top of the refactors of PR 3 (`prepareIsolatedWorktree`, `generateSpecFromText`, durable Jira create, desktop PR #792) and PR 4 (read-only missions, desktop PR #793). Core provides interrupt delivery and `flowSessions` (Core PR #435) and the derive-change node with `deriveChange` (in progress). The user-facing behaviour follows phase 2 of the feedback implementation guide (tasks 2.2 and 2.3, annex D.7). The internals guide is `docs/internals/flow-mode.md`.

## Goals / Non-Goals

**Goals:** the server side of Flow: lifecycle, persistence, placeholder spec, worktree ownership and atomic hand-off, Flow turns in missions with real interruption, capability gating, reconciliation, routes, events and accounting.

**Non-Goals:** the client feature; the `factory:flow-spec` loop; settlement effects (spec rewrite, Jira create and review). Provider-specific interruption logic in Desktop (it is Core's).

## Decisions

1. **Hexagonal module (`project-settings` pattern).** `domain.ts` is a pure `transition(session, command) → { session, effects }`; `application.ts` executes effects through `ports.ts`; SQLite, HTTP and bindings are adapters. Architecture tests fix the domain/application/ports/index import allowlists and forbid missions → flow/delivery dependencies.
2. **Sagas anchored in `flow_sessions.step`.** Start: insert row → placeholder spec → reserve worktree → session id. Hand-off: close session → freeze (commit) → launch. Each step is persisted before the next external effect; failures compensate in reverse. Startup reconciliation completes or compensates (section 4.7).
3. **One owner per worktree.** Flow owns its worktree via `flow_sessions`; `rail_worktrees` never sees it until the hand-off. `requiredFlowWorktree` on `IsolatedLaunchInput` reuses the exact mount like `requiredPrContinuation` and verifies path, branch and HEAD. The ownership transfer is a callback delivery invokes inside its own SQLite transaction (no cross-module SQL). Ownership `adopted` is released like `created` and never removed by allocation rollback; a rollback after adoption returns ownership to the Flow.
4. **Missions learn nothing about worktrees.** `FlowTurnContext.forConversation(id) → null | { cwd, coreSessionId, systemPrompt, policy }` is injected at composition. A distinct Core session per Flow because cwd is fixed at open. Policy: `workspace-write`, default tools, the mission's MCP. Mid-turn input uses `delivery: 'interrupt'`; Desktop never calls `session.interrupt` first.
5. **Capability gating.** Flow is offered only when Core sessions are usable and Core advertises `flowSessions` and `deriveChange`, and starting requires a host with `initialize.capabilities.flowSessions` and a driver for the mission's provider. No legacy path.
6. **Hand-off through the single launch authority.** The Flow use case calls the rails launch route over loopback with `flowId` (the milestone chain's pattern), so every launch guard applies. Without a choice the hand-off requests `factory:flow-spec`, never the rail's default loop.
7. **Placeholder spec through the non-promoting path** (direct ticket store write, schema 1.5). `isFlowHeldTicket` blocks Jira create (promote errors; the outbox create op retries).
8. **Accounting.** Flow turns are recorded once, in `agent_invocations` with `surface = 'flow'`; `flow` joins the shared surface vocabulary. The cost route sums billed cost only and counts unpriced turns.

## Deviations from the architecture document

- `flow_sessions.ticket_id` is nullable (section 4.3 says `NOT NULL`): the row is inserted before the ticket so the saga has a durable anchor and the unique index arbitrates concurrent starts. It is NULL only during `start:ticket`.
- `FlowAgentSession.open` does not call Core: it validates support and returns `flow:<flowId>`; the Core session opens lazily on the first Flow turn with the worktree as cwd (the runner already opens or resumes). Pause closes it; Core resumes closed sessions from the journal.
- Additional ports beyond section 4 (`FlowRailLauncher`, `FlowUsage`, `FlowNotifier`, availability, ids): each has a real substitution (fakes in tests).
- Sub-agents are disabled in Flow sessions: the mission projection cursor is keyed by conversation, so a second session's background usage could not be accounted honestly yet.
- `onFlowDelivered` records the transition only; `FlowPublication` is declared for the settlement change.

## Risks / Trade-offs

- The Core capabilities are unreleased: until Core ships `flowSessions` and `deriveChange`, Flow stays unavailable (by design).
- A re-pinned conversation stops resolving its Flow; turns become normal missions.
- The hand-off depends on a free rail; a busy rail returns `409 rail_not_empty` and the Flow stays paused.
