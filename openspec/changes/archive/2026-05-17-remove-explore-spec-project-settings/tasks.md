## 1. Server — drop project-level Explore toggles

- [x] 1.1 Remove the four endpoints `GET/PATCH /api/projects/:projectId/explore-mcp-enabled` and `GET/PATCH /api/projects/:projectId/explore-contract-refine-enabled` from `server/project-router.ts` (handlers + route registrations).
- [x] 1.2 Remove the corresponding helper functions in `server/db.ts` (e.g. `getExploreMcpEnabled`, `setExploreMcpEnabled`, `getExploreContractRefineEnabled`, `setExploreContractRefineEnabled`) that are exclusively used by the deleted endpoints. Leave any helper still referenced elsewhere untouched.
- [x] 1.3 In `server/modules/conversations/runtime/chat-manager.ts`, change the Explore spawn cwd selection so it reads only `conversation.context_scope.mcp` (default `false` when missing). Delete any read of `explore_mcp_enabled` or its DB helper.
- [x] 1.4 In `server/modules/specs/runtime/contract-refine-runner.ts` (post-commit lifecycle), remove the fallback to `explore_contract_refine_enabled` when `context_scope.contractRefine` is null. Treat null/false as `scope-disabled` and early-return.
- [x] 1.5 In the retry handler `POST /api/projects/:projectId/tickets/:id/contract-refine` (in `server/project-router.ts` or wherever it currently lives), replace the project-toggle gate with: 404 if ticket unknown; 409 if `origin_conversation_id IS NULL`; 409 if the kill switch is active; 202 otherwise. Preserve the existing kill-switch parser.
- [x] 1.6 In `server/modules/agents/runtime/agent-refine-manager.ts` / Quick `generate-spec` handler, change the Quick refine gate to depend only on the request body's `contractRefine` flag and the hub-wide kill switch — drop any read of the project setting.
- [x] 1.7 Remove the `defaultBootScope` path (or equivalent) that derives the boot scope from project settings; if no longer called, delete the helper.

## 2. Client — drop the Explore Spec card

- [x] 2.1 Delete the entire `Explore Spec` card and its surrounding effects/handlers from `client/src/features/settings/pages/SettingsPage.tsx` (`exploreMcpEnabled`, `contractRefineEnabled` state, loaders, savers, and JSX).
- [x] 2.2 Update any imports in `SettingsPage.tsx` that become unused after removing the card.
- [x] 2.3 Delete `client/src/pages/__tests__/SettingsPageExploreMcp.test.tsx`.
- [x] 2.4 In `client/src/features/settings/pages/__tests__/SettingsPage.test.tsx` and `SettingsPageExtended.test.tsx`, remove any test cases that referenced the Explore Spec card; add a test asserting the card no longer renders (negative assertion).
- [x] 2.5 Confirm `ContextScopeSlider`, `useContextScope`, `useQuickContractRefineLast`, and `ProposeSpecModal` need no changes — they already operate per-spec.

## 3. Tests — server

- [x] 3.1 Delete or rewrite test files in `server/` that exercised the four removed endpoints. Add a single test asserting the routes return 404.
- [x] 3.2 In `server/modules/conversations/runtime/chat-manager.test.ts` (or equivalent), update the Explore spawn-cwd tests so they no longer set/read `explore_mcp_enabled` and instead seed `context_scope.mcp` directly.
- [x] 3.3 In `server/modules/specs/runtime/contract-refine-runner.test.ts`, update the lifecycle tests to drop the project-setting fallback path. Keep tests that cover `scope-disabled` and kill-switch behaviour.
- [x] 3.4 Add a test for the retry endpoint covering: 404 unknown ticket; 409 missing `origin_conversation_id`; 409 kill switch active; 202 success path.
- [x] 3.5 In Quick `generate-spec` tests, remove project-setting permutations; keep `contractRefine: true/false` request-body permutations and the kill-switch permutation.

## 4. Coverage gates

- [x] 4.1 Run `npm run typecheck` at the repo root; fix any type errors introduced by removed exports.
- [x] 4.2 Run `npm test` and `npm run test:coverage` (server) — must clear the 80% lines/functions/statements and 70% branches thresholds.
- [x] 4.3 Run `cd client && npm run test:coverage` — must clear 80% lines/statements and 70% functions.
- [x] 4.4 If coverage drops below threshold after the deletions, add tests rather than lowering the threshold.

## 5. Documentation

- [x] 5.1 In `CLAUDE.md`, update the `Explore Spec acceleration` section: remove the bullet point describing the per-project `config.explore_mcp_enabled` toggle and its endpoints. Replace with a one-line statement that MCP-in-Explore is per-spec via `context_scope.mcp`.
- [x] 5.2 In `CLAUDE.md`, update the `Explore Contract Refine` section: remove the `Toggle/default` paragraph and the references to the project setting in the `Explore lifecycle`, `Quick lifecycle`, and `Retry` paragraphs. State the per-conversation/per-ticket invariant and the kill switch as the only gate.
- [x] 5.3 Verify no other section of `CLAUDE.md` references `explore_mcp_enabled` or `explore_contract_refine_enabled`. Grep before commit.

## 6. Manual verification

- [ ] 6.1 Start `npm run dev`. Open Settings — verify the Explore Spec card no longer renders.
- [ ] 6.2 Open Add Spec → Explore mode in a fresh project. Verify the MCP toggle defaults OFF (no server fetch for project-level setting in the network panel).
- [ ] 6.3 Submit an Explore spec with `Max` preset (Contract Refine ON). Verify the refine fires and the ticket description gains a Contract Layer section.
- [ ] 6.4 Submit an Explore spec with `Standard` preset (Contract Refine OFF). Verify no refine spawn.
- [ ] 6.5 Click `Reintentar` on a failed-refine toast and verify it succeeds without any Settings configuration.
- [ ] 6.6 Start the server with `SPECRAILS_EXPLORE_CONTRACT_REFINE=0`. Verify both auto-fire and retry are suppressed.
