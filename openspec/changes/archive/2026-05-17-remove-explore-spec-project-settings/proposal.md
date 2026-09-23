## Why

Today, Explore Spec options (MCP servers, Contract Refine) live in two places: project Settings ("Explore Spec" card) and Add Spec modal (ContextScopeSlider per-spec). These two sources of truth are not synchronized — changing the slider does not update Settings and vice versa. The project-level toggles also create a hidden retroactive default that operates outside the per-spec decision the user made when creating the ticket. Decisions about which MCP servers load and whether Contract Refine runs should be exclusively per-ticket, captured at creation time, and live with the ticket forever.

## What Changes

- **BREAKING**: Remove the "Explore Spec" card from `SettingsPage` (MCP toggle and Contract Refine default).
- **BREAKING**: Remove REST endpoints `GET/PATCH /api/projects/:projectId/explore-mcp-enabled` and `GET/PATCH /api/projects/:projectId/explore-contract-refine-enabled`.
- **BREAKING**: Stop reading `queue_state` keys `config.explore_mcp_enabled` and `config.explore_contract_refine_enabled`. Existing rows are left untouched (orphan keys, harmless) — no migration.
- `ChatManager` Explore spawn cwd is decided exclusively by `chat_conversations.context_scope.mcp` (the per-conversation flag). No project fallback.
- `contract-refine-runner.ts` lifecycle fires exclusively when `context_scope.contractRefine === true`. Legacy null scope → treated as `false` (no project fallback).
- `POST /api/projects/:projectId/tickets/:id/contract-refine` retry: removes the project-toggle gate. Allowed when the ticket has `origin_conversation_id` and the hub-wide kill switch `SPECRAILS_EXPLORE_CONTRACT_REFINE` is not set to a disabling value. The user clicking Retry is the per-ticket consent.
- Update CLAUDE.md "Explore Spec acceleration" and "Explore Contract Refine" sections to document the per-ticket-only model.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `explore-spec`: remove project-level `explore_mcp_enabled` toggle requirement; MCP scope decision is exclusively per-conversation via `context_scope.mcp`.
- `add-spec-context-scope`: clarify that `context_scope` (mcp, contractRefine) is the single source of truth — no project-level default and no project-level override. Remove any requirement that ties the slider's defaults or the retry gate to a project setting.

## Impact

- **Affected code**:
  - `client/src/features/settings/pages/SettingsPage.tsx` (remove card + handlers)
  - `client/src/pages/__tests__/SettingsPageExploreMcp.test.tsx` (delete)
  - `server/project-router.ts` (remove 4 endpoints + retry-gate logic)
  - `server/modules/conversations/runtime/chat-manager.ts` (drop project-toggle read for spawn cwd)
  - `server/modules/specs/runtime/contract-refine-runner.ts` (drop project-toggle fallback)
  - `server/db.ts` (drop helper functions if exclusively used by removed endpoints)
  - Tests for the above modules
  - `CLAUDE.md` (doc update)
- **Unaffected**:
  - `ContextScopeSlider`, `useContextScope`, `useQuickContractRefineLast` (per-spec primitives unchanged)
  - Kill switch env var `SPECRAILS_EXPLORE_CONTRACT_REFINE` (retained as ops escape hatch)
  - Quick mode's `add_spec_quick_contract_refine_last` sticky-toggle (modal-local memory, not a project setting)
- **External**: no specrails-core changes. No DB migration (orphan keys remain in `queue_state`).
