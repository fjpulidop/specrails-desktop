# Tasks

## 1. Triage provider override

- [x] 1.1 In `server/modules/specs/runtime/triage.ts` add an optional `{ provider }` override to `resolveTriageEngine` (wins over primary provider and triage role; role model only if valid for that provider, else cheapest; no fallback when disabled/unregistered/tool-policy-unsupported). Verify with unit tests in `server/modules/specs/runtime/triage.test.ts`: Codex override with Claude project and Claude triage role, each provider, incompatible provider returns a reason, no override unchanged.
- [x] 1.2 Add `SpecTriageService.pinProvider(ticketId, provider)` (per-ticket immutable map, dropped after a terminal record) and use it in `run`, extending the `resolveEngine` seam with the pinned provider. Verify with tests: runner request carries the pinned provider/model, unavailable record with reason and no runner call for an unusable provider, selector change or later settings change leaves the pending job on the pinned provider, two interleaved tickets with different providers keep separate contexts.
- [x] 1.3 Verify accounting and failure handling in the same test file: `recordInvocation` row and `metadata.triage` carry the executed provider and model; a runner failure stores a failed record without touching ticket content or repositories.

## 2. Save path propagation

- [x] 2.1 In `server/project-router-tickets.ts` `from-draft`, validate `agentProvider` (and conversation provider when present) and call `specTriage.pinProvider` right after the write and before the `ticket_created` broadcast; keep the `agentProvider` -> `providerId` translation for contract refine. Verify with Supertest tests in `server/project-router-tickets.test.ts` (or the nearest existing file): Codex mission leads to triage and contract requests with Codex via mock adapters and no Claude adapter call; requests without `agentProvider` (external MCP, no mission) behave as before.
- [x] 2.2 Inventory the other creation paths in the design table (Explore-origin from-draft, `generate-spec`, `/contract-refine` and `/triage` retries, `ai-edit`, `from-prompt`) and fix any that lose or substitute the provider, or report the step and reason. Verify with a test per path asserting the provider each AI step receives.
- [x] 2.3 Post-save failure: ensure an unsupported/unavailable provider or step failure leaves exactly one spec with its content and `repositoryIds`, reports save success separately from the failed step (`metadata.triage` or `explore.contract_refine_failed` with step, provider, reason), and never regenerates or duplicates. Verify with tests counting tickets in the store and asserting broadcasts.
- [x] 2.4 In `server/mcp/tools/specs.ts` confirm `commit_draft` sends the mission provider only for first-party calls with a conversation, capture it at call time, and leave external clients unchanged. Verify in `server/mcp/tools/specs.test.ts`: first-party sends `agentProvider`, external client sends none.

## 3. Docs and integration

- [x] 3.1 Document the mission-provider rule and per-provider step support in `server/modules/specs/README.md` and the `agentProvider` field in `docs/internals/api-reference.md`. Verify the links and file references resolve.
- [x] 3.2 Run `npm run typecheck`, `npx vitest run server/modules/specs server/mcp server/project-router-tickets` and `npx vitest run server/modules`, plus `npm run audit:architecture`; all pass without lowering coverage thresholds.
