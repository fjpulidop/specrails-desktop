## 1. Server: toggle + kill switch

- [x] 1.1 Add `getExploreContractRefineEnabled(db)` and `setExploreContractRefineEnabled(db, enabled)` helpers in a new `server/explore-contract-refine-settings.ts` (mirror `explore-mcp-enabled` shape, key `config.explore_contract_refine_enabled`, default `false`)
- [x] 1.2 Add unit tests for the helpers (default value, set/get round-trip, non-boolean rejection)
- [x] 1.3 Add `GET /api/projects/:projectId/explore-contract-refine-enabled` and `PATCH ...` routes in `server/project-router.ts`
- [x] 1.4 Add router tests in `server/project-router.test.ts` (GET defaults to false, PATCH persists, 400 on non-boolean, 404 on unknown project)
- [x] 1.5 Add `isExploreContractRefineKillSwitchActive()` helper that parses `SPECRAILS_EXPLORE_CONTRACT_REFINE` (treat `0|false|off` case-insensitive as inactive feature; otherwise active)
- [x] 1.6 Unit tests for kill-switch parser (env unset → inactive switch / feature on, `0` → switch active, `False` → switch active, `1` → inactive switch, etc.)

## 2. Server: refine prompt + parser

- [x] 2.1 Create `server/modules/conversations/runtime/explore-contract-refine.ts` exporting `CONTRACT_PROMPT_VERSION = 1`, `buildContractRefineSystemPrompt(): string` (byte-stable, structural-only, forbids user-content edits, demands `contract-layer` fenced block), and `CONTRACT_MARKER_USER_MESSAGE = '/specrails:contract-refine'`
- [x] 2.2 Include 1–2 few-shot examples in the system prompt body that demonstrate the `contract-layer` JSON shape
- [x] 2.3 Unit test: `buildContractRefineSystemPrompt()` is byte-equal across two consecutive calls
- [x] 2.4 Export `parseContractLayerBlock(rawAssistantText): { ok: true, value: ContractLayer } | { ok: false, reason: 'malformed' | 'missing-version' | 'parser-error' }`
- [x] 2.5 Define the `ContractLayer` TypeScript type (with `contractVersion: 1`, `namingContract`, `dataShapes`, `stateMachine: string | null`, `invariants: string[]`, `fileTouchList`)
- [x] 2.6 Implement strict parsing: drop unknown keys, default missing arrays to `[]`, reject when `contractVersion` is missing/non-int
- [x] 2.7 Unit tests for the parser: happy path, missing optional arrays, unknown keys dropped, missing version, malformed JSON, no block at all
- [x] 2.8 Export `renderContractLayerMarkdown(layer: ContractLayer): string` that returns the deterministic markdown subsection (heading + five labelled subsections, N/A placeholders for empty)
- [x] 2.9 Unit tests for the renderer: all five subsections present, empty subsections render N/A line, order is fixed

## 3. Server: ChatManager refine lifecycle hook

- [x] 3.1 Extend `ChatManager` (or a thin sibling helper in `server/modules/conversations/runtime/explore-contract-refine.ts`) with `runContractRefine(conversationId, ticketId): Promise<void>` that:
   - Checks the per-project toggle + kill switch (early return if either disables it)
   - Schedules a turn through the existing Explore lifecycle (concurrency cap, idle-kill, crash auto-respawn, cwd resolution, `--resume <session_id>`, model = parent conversation model)
   - Sends `/specrails:contract-refine` as the marker user message
   - Swaps the system prompt for the refine system prompt
   - Forces `--disallowedTools Read,Grep,Glob,Bash` regardless of parent `contextScope.full`
   - Sets a 60 s timeout for the spawn
- [x] 3.2 Ensure the marker user message is filtered out of the client-facing conversation history (parallel to the existing `/specrails:explore-spec` bootstrap filter)
- [x] 3.3 Ensure the `contract-layer` fenced block is stripped from chat content broadcast over WS (reuse the `spec-draft` block scrubber)
- [x] 3.4 On successful parse: PATCH the ticket's `description` (description-only payload) and broadcast `ticket_updated` via the normal path
- [x] 3.5 On any failure (model error, crash beyond auto-respawn, malformed block, parser exception, 60 s timeout): broadcast `explore.contract_refine_failed { ticketId, reason }` (one of `model_error | crashed | malformed | timeout | parser_error`), do NOT patch
- [x] 3.6 Record `ai_invocations` row for every refine attempt (success and failure) via the existing `recordInvocation` capture; reuse `surface='explore-spec'`, set `conversation_id` and `ticket_id` correctly
- [x] 3.7 Tests covering: refine fires when toggle ON + kill switch inactive; refine skipped when toggle OFF; refine skipped when kill switch active; refine uses parent's model; refine uses parent's cwd; refine spawn argv excludes Read/Grep/Glob/Bash even when parent had `full=true`
- [x] 3.8 Tests covering refine failure paths emit the right reason code

## 4. Server: commit-side trigger + retry endpoint

- [x] 4.1 Hook `POST /tickets/from-draft` to schedule `runContractRefine` after the response is sent (microtask / `process.nextTick`) for both the legacy insert path and the flip-in-place draft path
- [x] 4.2 Add tests in `server/project-router.test.ts` confirming the refine is scheduled after commit when toggle ON, and NOT scheduled when toggle OFF or kill switch active
- [x] 4.3 Add `POST /api/projects/:projectId/tickets/:id/contract-refine` retry endpoint: 202 on success, 409 when toggle OFF, 404 when ticket missing, 403/409 when kill switch active
- [x] 4.4 Retry endpoint tests: success path, toggle-off rejection, kill-switch rejection, missing-ticket rejection

## 5. Server: WS event surface

- [x] 5.1 Define the `explore.contract_refine_failed` WS message shape and its emission point (project-scoped, includes `ticketId` and `reason`)
- [x] 5.2 Confirm `ticket_updated` already covers the success path (no new event needed); add an assertion in tests
- [x] 5.3 Tests covering both events fire with correct `projectId` scoping

## 6. Client: SettingsPage toggle

- [x] 6.1 Add a `useExploreContractRefineEnabled(projectId)` hook in `client/src/hooks/` (mirror `useExploreMcpEnabled` if present, otherwise stale-while-revalidate pattern)
- [x] 6.2 Extend the `Explore Spec` card in `client/src/features/settings/pages/SettingsPage.tsx` with the new toggle + helper line copy
- [x] 6.3 Toggle PATCHes the new endpoint on change and reflects server state on mount
- [x] 6.4 Component test for the toggle (renders, persists, helper copy present)

## 7. Client: SpecsBoard pending + failure toast

- [x] 7.1 Subscribe to the new WS events (`explore.contract_refine_failed`) in `SpecsBoard` (or a shared hook)
- [x] 7.2 Show a sonner toast with id `contract-refine:<ticketId>` and text `Afinando contrato…` immediately on commit when the toggle is ON (provider can read the toggle from cached hook)
- [x] 7.3 Dismiss the toast on the matching `ticket_updated` event when the patched description contains the `\n\n---\n\n## Contract Layer\n\n` separator
- [x] 7.4 Swap the toast to error variant on `explore.contract_refine_failed`; render `Reintentar` action that POSTs `tickets/:id/contract-refine` and resets the toast back to the pending variant
- [x] 7.5 Component test for the toast lifecycle (pending → success dismisses, pending → failure swaps to error, retry resets to pending)

## 8. Client: TicketDetailModal Contract Layer disclosure

- [x] 8.1 In `TicketDetailModal`, detect the `\n\n---\n\n## Contract Layer\n\n` separator and split the body into `userAuthored` + `contractLayer` regions
- [x] 8.2 Render the user-authored region with the existing markdown renderer; render the Contract Layer region inside a collapsible disclosure (collapsed by default)
- [x] 8.3 Show a count badge of non-N/A subsections on the disclosure header (parses the rendered Contract Layer text)
- [x] 8.4 Component tests: ticket without Contract Layer renders unchanged; ticket with Contract Layer renders the disclosure collapsed; clicking the disclosure header expands it; SpecsBoard preview (and any other card-style preview) ignores content after `\n\n---\n\n`

## 9. Polish, gates, docs

- [x] 9.1 Update `openspec/specs/explore-spec/spec.md` indirectly by archiving the change (no manual edits; archive does this)
- [x] 9.2 Update `CLAUDE.md` `### Explore Spec acceleration` (or add a new `### Explore Contract Refine` subsection in the architecture overview) describing the toggle, the kill switch, the lifecycle, and the failure surface
- [x] 9.3 Sanity-pass: run `npm run typecheck`, `npm test`, `npm run test:coverage` (server) and `cd client && npm run test:coverage` (client) until thresholds pass
- [x] 9.4 Manual smoke test in `npm run dev`: commit an Explore spec with the toggle ON, see the pending toast, see the Contract Layer appear in the ticket modal once the refine completes, force a failure (e.g. kill the spawned `claude` mid-refine) and verify the error toast + retry path
