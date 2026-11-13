# Proposal

## Why

After a Project Builder commit the new project has no mission conversation, so the agent panel is empty and the user must find out how to start one. Opening one placeholder mission conversation on the first successful commit gives an obvious starting point at zero cost (no AI turn, no tokens).

## What Changes

- The Builder commit runner creates one empty mission conversation (`agent_conversations` row) pinned to the new project, after the project is registered (the last mutation), best-effort.
- Creation is idempotent per project: it is skipped when any row (including soft-deleted) is already pinned to the project, so later commits and deleted placeholders never produce another one.
- Failure to create the placeholder is non-fatal: the commit still reaches `blueprint.commit_done`, and a `placeholder` progress step with status `warning` is emitted.
- Success emits a `placeholder` progress step `done` and an `agent_conversation_created` event so open clients refresh their mission list.
- `blueprint.commit_done` gains an optional additive `missionConversationId`.
- No schema change, no new route, no client change (the existing mission list already shows conversations pinned to a project).

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `project-bootstrap-commit`: a successful commit also opens one placeholder mission conversation pinned to the new project, once, non-fatally.

## Impact

- `server/modules/builder/runtime/blueprint-commit.ts` (new IO member, new step), new `mission-placeholder.ts` helper, `server/modules/builder/runtime/*.test.ts`.
- `server/modules/boundaries.json` (builder dependency on `../../agents/runtime/agent-store`), source map, API reference docs for the additive event field.
