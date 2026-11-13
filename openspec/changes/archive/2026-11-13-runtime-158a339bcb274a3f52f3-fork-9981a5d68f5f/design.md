# Design

## Context

`createBlueprintCommitRunner` (`server/modules/builder/runtime/blueprint-commit.ts`) runs steps in order and registers the project last (`step = 'register'`, then `io.markCommitted`, then optional GitHub, then `blueprint.commit_done`). All IO is injected through `BlueprintCommitIO` and tests fail individual steps. `agent_conversations` lives in the desktop DB (`deps.registry.desktopDb`); `createAgentConversation` / `listAgentConversations` are in `server/modules/agents/runtime/agent-store.ts`. `listAgentConversations` filters `deleted_at IS NULL` and archived rows by default, so it cannot answer "was one ever created". Conversation creation elsewhere (`POST /conversations` in `server/modules/missions/runtime/agent-chat-router.ts`) broadcasts `agent_conversation_created`, which the client uses to refresh the mission list.

## Goals / Non-Goals

**Goals:**
- One empty pinned mission conversation after a first successful commit, idempotent, non-fatal.

**Non-Goals:**
- No welcome message, blueprint summary or AI turn.
- No schema change, new route or client change.
- No placeholder for existing projects or the Add Project flow.
- No change to `blueprint_conversations` (Builder chat).
- No auto-launch of rails.

## Assumptions

- Placeholder content (empty, welcome or summary)? Assumed empty with no AI turn.
- Selected on entry or only listed? Assumed listed through the existing project-scoped mission list; no new auto-select logic. This is the one non-obvious assumption (confidence medium).
- Server at commit or client on open? Assumed server at commit (persisted, visible everywhere).

## Decisions

- **Placement:** a step `placeholder` after `register` / `markCommitted` and before the GitHub step, inside its own try/catch. Rejected: before register (would leave an orphan if registration fails; the project id does not yet exist for users).
- **Rollback:** because creation happens only after register, which is the last mutation, no earlier failure can leave a conversation. A throw inside the step is caught and becomes a warning. Rejected: a transaction spanning registry and conversation (different stores, not needed).
- **Idempotency:** new `mission-placeholder.ts` exports `ensureMissionPlaceholderConversation(db, input)`. It uses a direct parameterized `SELECT 1 FROM agent_conversations WHERE pinned_project_id = ? LIMIT 1` (includes soft-deleted and archived rows) and otherwise calls `createAgentConversation`. Rejected: `listAgentConversations` (hides deleted/archived rows, capped at 100); a new column (no schema change allowed).
- **Inputs:** `provider = providers[0]`, `model = null` (adapter default, same as the router when no model is requested), `tierLevel = 0` (default), `reasoningEffort = null`. A fresh project id cannot already have rows, so skip mainly protects retried or re-entered runs.
- **IO seam:** add `ensurePlaceholder: (projectId, provider) => { status, conversationId }` to `BlueprintCommitIO`, defaulting to the helper on `deps.registry.desktopDb`, so tests can inject a throwing implementation like the other steps.
- **Events:** emit `placeholder` progress `done` (detail `created` or `skipped`) or `warning` with the error message; on creation broadcast `{ type: 'agent_conversation_created', conversationId, timestamp }` through `deps.broadcast`; add optional `missionConversationId` to `blueprint.commit_done`. Existing clients ignore the unknown step (it only appends to the displayed step list) and the extra field. A `console.info` / `console.warn` line records created, skipped or failed.
- **Boundaries:** builder gains a dependency on `../../agents/runtime/agent-store` (already a public entry used by other modules), recorded in `server/modules/boundaries.json` for `runtime/blueprint-commit.ts` and the new file; `mission-placeholder.ts` is internal, not a public entry.

## Local reference patterns

- Best-effort post-register step: `io.markCommitted` try/catch in `blueprint-commit.ts`; warning steps: the `github` step.
- Conversation creation and broadcast: `agent-chat-router.ts` `router.post('/conversations')` and `AgentChatManager.notifyConversationCreated`.
- Tests: `blueprint-commit.test.ts` harness (injected `BlueprintCommitIO`, `h.messages`, in-memory desktop DB, `waitSettled`); store tests use `:memory:` DBs per `.claude/rules/server.md`. No router-level commit test needs the real runner (the router takes an injected `runCommit`), so the integration coverage is at the runner level.

## Risks / Trade-offs

- [Client does not auto-select the placeholder] → the conversation appears in the project's mission list via the existing event/list; auto-select is deferred (assumption above).
- [Commit crash between register and placeholder] → project exists without placeholder; acceptable, it is a convenience.
- [Skip check also matches rows the user pinned manually] → intended: placeholder is only for projects with no mission history.

## Blast radius

- `server/modules/builder/runtime/mission-placeholder.ts` (create): helper.
- `server/modules/builder/runtime/mission-placeholder.test.ts` (create): helper tests.
- `server/modules/builder/runtime/blueprint-commit.ts` (modify): IO member, step, events, `commit_done` field.
- `server/modules/builder/runtime/blueprint-commit.test.ts` (modify): runner coverage.
- `server/modules/boundaries.json` (modify): new builder dependency on `agents/runtime/agent-store` and the new file.
- `docs/internals/source-map.md` (modify, regenerated by `npm run docs:source-map`): new files.
- `docs/internals/api-reference.md` (modify, only if it documents `blueprint.commit_done`/progress steps): additive step and field.
- `blueprint-router.ts` is unchanged: it only delegates and broadcasts via the runner.

## Out-of-scope findings

- The ticket's Contract Layer names `blueprint-router.test.ts` for the integration test; the router receives an injected `runCommit`, so the behaviour is tested in `blueprint-commit.test.ts` instead.
