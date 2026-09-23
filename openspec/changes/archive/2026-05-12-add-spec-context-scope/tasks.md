## 1. Server — context-budget endpoint

- [x] 1.1 Add `server/modules/conversations/runtime/context-budget.ts` computing `{ specrailsSpecsTokens, openspecSpecsTokens, codebaseFileCount, codebaseEstimatedTokens, mcpServers }` via a recursive walk with 60s in-memory per-project cache (token estimate = bytes/4 heuristic, codebase walk respects `.gitignore`).
- [x] 1.2 Register `GET /api/projects/:projectId/context-budget` in `server/project-router.ts` that returns the JSON shape above.
- [x] 1.3 Unit-test `context-budget.ts` for: empty project, project with only specrails specs, project with only openspec specs, cache hit within TTL, cache miss past TTL.

## 2. Server — persistence and types

- [x] 2.1 Add a shared `ContextScope` type `{ specrails: boolean, openspec: boolean, full: boolean, mcp: boolean }` in `server/types/context-scope.ts` exported for both server and client (or duplicate the literal type in `client/src/types/`).
- [x] 2.2 Add `getLastContextScope(db, projectId)` and `setLastContextScope(db, projectId, scope)` helpers that read/write `queue_state` key `add_spec_context_scope_last` as JSON. Shape-validate on read, ignore unknown keys, fall back to default boot.
- [x] 2.3 Add `GET /api/projects/:projectId/context-scope-last` and `PATCH /api/projects/:projectId/context-scope-last` endpoints; PATCH validates body as `Partial<ContextScope>` (booleans only) and returns the merged stored value.

## 3. Server — chat_conversations schema

- [x] 3.1 Add migration adding a nullable `context_scope TEXT` column to `chat_conversations` (JSON). Backfill: NULL means "use legacy behavior" so existing rows behave unchanged.
- [x] 3.2 Update `POST /chat/conversations` body to accept `contextScope?: ContextScope` and persist on the row when `kind='explore'`. Reject if `kind !== 'explore'` and `contextScope` is provided.
- [x] 3.3 Update `chat-manager.ts` `_buildLightweightSystemPrompt` (or the spawn site) to read `context_scope` from the conversation row each turn and apply spec-concat + tool-allow/disallow flags. Cap spec concat at 30k tokens with `(truncated)` marker.

## 4. Server — Quick mode context scope

- [x] 4.1 Extend `POST /tickets/generate-spec` request schema to accept `contextScope: { specrails: boolean, openspec: boolean, full: boolean }`. Default when missing = `{ specrails: false, openspec: false, full: false }`.
- [x] 4.2 In the same handler, concat specrails/openspec specs into the system prompt when respective toggles are true (reuse helpers from task 3.3).
- [x] 4.3 Pass `--allowedTools Read,Grep,Glob` when `full=true`, otherwise `--disallowedTools Read,Grep,Glob,Bash`. Never include Bash in allowed list.
- [x] 4.4 On every `generate-spec` success, upsert `add_spec_context_scope_last` with the submitted scope plus the existing persisted `mcp` value (Quick does not control MCP).

## 5. Server — Explore launch hand-off

- [x] 5.1 Update `ExploreSpecShell` launch contract — `POST /chat/conversations` for `kind='explore'` carries `contextScope`. Persist on the row.
- [x] 5.2 On Explore launch via the modal, upsert `add_spec_context_scope_last` with the submitted scope.
- [x] 5.3 Confirm `--resume` path re-reads `context_scope` from the stored conversation row (no in-memory caching).

## 6. Server — spawn argv tests

- [x] 6.1 Unit-test ChatManager spawn argv for every combination of `contextScope.full` ∈ {true,false} and `contextScope.mcp` ∈ {true,false}.
- [x] 6.2 Unit-test `generate-spec` argv for `full` ∈ {true,false}.
- [x] 6.3 Unit-test system-prompt concat: produces `## Specrails Specs` / `## OpenSpec Specs` sections, respects 30k cap with `(truncated)` marker, omits sections when corresponding toggle is false.

## 7. Client — types and hook

- [x] 7.1 Add `client/src/features/chat/types/context-scope.ts` mirroring server type.
- [x] 7.2 Add `client/src/features/chat/hooks/useContextBudget.ts` that fetches `GET /context-budget` for the active project with 60s stale window and surfaces `{ data, isError }`.
- [x] 7.3 Add `client/src/features/chat/hooks/useContextScope.ts` that loads `GET /context-scope-last`, falls back to default boot (incl. reading global `explore_mcp_enabled` via existing API), and exposes `{ scope, setScope, resetToDefault }`. Persists on submit (called by the modal).

## 8. Client — ContextScopeChecks component

- [x] 8.1 Create `client/src/features/chat/components/ContextScopeChecks.tsx` rendering the four toggles with the required labels and order. MCPs toggle disabled with tooltip "Explore mode only" when `mode='quick'`.
- [x] 8.2 Unit tests covering: render in Quick (MCPs disabled), render in Explore (all enabled), toggles operate independently, callback fires with correct partial.

## 9. Client — CostAwarenessMeter component

- [x] 9.1 Create `client/src/components/CostAwarenessMeter.tsx` with two layers: 4-segment tier bar + numeric line. Tier weights as in spec. Theme tokens only (no brand colors).
- [x] 9.2 Implement tier mapping helper `tierFromScope(scope) => 'Light'|'Medium'|'Heavy'|'Deep'`. Unit test all relevant combinations from spec scenarios.
- [x] 9.3 Numeric line: compute `tokens × pricePerToken` using selected model. If budget hook errors, show `tier-only — estimate unavailable`.
- [x] 9.4 Submit-button color helper `submitAccentForTier(tier)` returning Tailwind classes mapping to `accent-success | accent-info | accent-warning | accent-secondary`.

## 10. Client — ProposeSpecModal wiring

- [x] 10.1 Mount `ContextScopeChecks` + `CostAwarenessMeter` inside `ProposeSpecModal.tsx`, between the mode chips and the textarea.
- [x] 10.2 Wire submit button background to `submitAccentForTier(tier)`.
- [x] 10.3 Update Quick chip hint to `~15s` / `~45s` based on `scope.full`; reactive within 100ms.
- [x] 10.4 Forward `contextScope` to `POST /tickets/generate-spec` (Quick) and to `onExploreLaunch` (Explore). Persist via `useContextScope.setScope` on submit.

## 11. Client — Explore overlay surfaces

- [x] 11.1 In `ExploreSpecShell.tsx`, accept `contextScope` as part of the launch props and pass through to `POST /chat/conversations`.
- [x] 11.2 Render a persistent header pill `Context: <scopes> · ~$Y/turn` reflecting the active scope.
- [x] 11.3 After the first assistant turn settles, fetch the just-recorded `ai_invocations` row for that conversation and emit a sonner toast `Used Nk tok (est. Mk) · $Z`. Guard with a ref so it never fires twice for the same conversation.

## 12. Client — tests

- [x] 12.1 `ContextScopeChecks` and `CostAwarenessMeter` component tests (RTL).
- [x] 12.2 `ProposeSpecModal` test: toggles render, MCPs disabled in Quick, hint flips with `full`, submit forwards `contextScope` to API.
- [x] 12.3 `ExploreSpecShell` test: header pill text reflects launch scope; first-turn delta toast fires once.

## 13. Documentation

- [x] 13.1 Update `CLAUDE.md` with a new subsection under "Explore Spec acceleration" describing Context Scope + Cost Awareness, persistence key, and how the global `explore_mcp_enabled` setting now feeds the modal's default boot.

## 14. Verification

- [x] 14.1 Run `npm run typecheck` (server + client).
- [x] 14.2 Run `npm run test:coverage` (server, must pass 80% lines/functions/statements).
- [x] 14.3 Run `cd client && npm run test:coverage` (must pass 80% lines/statements).
- [x] 14.4 Manual smoke: fresh project; verify default boot; toggle each check and watch meter + submit color; submit Quick with Full ON → spawn arg includes `--allowedTools Read,Grep,Glob`; submit Explore with all four ON → conversation row has `context_scope`, header pill renders, first-turn delta toast fires.
- [x] 14.5 Run `openspec validate add-spec-context-scope --strict` and resolve any issues.
