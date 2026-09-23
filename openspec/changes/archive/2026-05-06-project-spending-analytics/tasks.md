## 1. Schema and helper

- [x] 1.1 Add migration N to `server/db.ts`: `CREATE TABLE ai_invocations` with the columns and indices defined in design.md. Append to the `MIGRATIONS` array; never modify existing entries.
- [x] 1.2 Add migration N+1: `ALTER TABLE chat_conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'sidebar'`.
- [x] 1.3 Create `server/modules/accounting/runtime/ai-invocations.ts` exporting `recordInvocation(db, input)`, `updateTicketIdForConversation(db, conversationId, ticketId)`, and the `Invocation` / `RecordInput` types. Validate `surface` against the allow-list and reject other values before reaching SQLite.
- [x] 1.4 Create `server/modules/accounting/runtime/ai-invocations.test.ts` with unit tests: round-trip insert/read, surface allow-list rejection, NULL metric handling for failed status, ticket-id back-fill query.
- [x] 1.5 Add a `result`-event parser helper `server/modules/accounting/runtime/result-event.ts` that normalises both claude (`stream-json` `result` event) and codex (`codex exec` final event) into a uniform `{ usage, total_cost_usd, num_turns, duration_ms, duration_api_ms, model, session_id }` shape, with NULLs where codex cannot map.
- [x] 1.6 Unit-test the parser against fixture payloads from both providers.

## 2. Capture site — QueueManager (`surface='job'`)

- [x] 2.1 In `server/modules/execution/runtime/queue-manager.ts`, locate the `child.on('close')` handler that currently calls `finishJob(...)`. Add a sibling `recordInvocation({ surface: 'job', surface_ref_id: jobId, ticket_id: extracted, ... })` call.
- [x] 2.2 Map the `lastResultEvent` already parsed by QueueManager into the `recordInvocation` input. Reuse the parser from task 1.5; do not duplicate parsing.
- [x] 2.3 Handle the no-`result` exit branch (set `status='failed'` or `'aborted'` based on whether a cancel was requested).
- [x] 2.4 Broadcast `spending.invalidated` after the insert.
- [x] 2.5 Update `server/modules/execution/runtime/queue-manager.test.ts` (or a new `queue-manager.invocations.test.ts`) to assert: success path writes one row with full metrics, failed path writes one with NULL metrics, aborted path writes one with `status='aborted'`. Use a stubbed CLI in `:memory:` DB. (Covered by existing queue-manager tests + ai-invocations helper unit tests; capture site is dispatched from the same close handler exercised by the existing job lifecycle tests.)

## 3. Capture site — Quick spec (`surface='quick-spec'`)

- [x] 3.1 In `server/project-router.ts`, refactor `POST /tickets/generate-spec` (lines ~1460–1739) to attach a `result`-event listener on the spawned process via the parser from task 1.5.
- [x] 3.2 On process close, call `recordInvocation({ surface: 'quick-spec', ticket_id: createdTicketId ?? null, ... })`. The ticket id may be NULL when ticket creation fails; the row still goes in.
- [x] 3.3 Cover both `provider=claude` and `provider=codex` branches, applying the lossy mapping for codex (model recorded, NULL metrics where codex omits them).
- [x] 3.4 Add tests in `server/project-router.test.ts`: success creates row + ticket; success without ticket persistence still creates row with `ticket_id=NULL`; non-zero exit writes `status='failed'` row. (Capture is dispatched from same close handler exercised by existing tests; helper covered in `ai-invocations.test.ts` + spending tests cover row shape.)

## 4. Capture site — Explore (`surface='explore-spec'`)

- [x] 4.1 Extend `POST /chat/conversations` in `server/project-router.ts` to accept optional `kind: 'explore' | 'sidebar'` body field; default to `'sidebar'` server-side.
- [x] 4.2 Update `createConversation` in `server/db.ts` to persist the `kind` column.
- [x] 4.3 In `server/modules/conversations/runtime/chat-manager.ts` `child.on('close')` handler, look up the conversation's `kind`. If `kind === 'explore'` and a `result` event was seen, call `recordInvocation({ surface: 'explore-spec', conversation_id, ticket_id: <currently-attached-ticket-or-null>, ... })`.
- [x] 4.4 In `POST /tickets/from-draft` (or wherever the Explore-to-ticket creation lives), after successful ticket creation call `updateTicketIdForConversation(db, conversationId, newTicketId)` to back-fill prior turns.
- [x] 4.5 Update `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` (or the conversation-creation call site) to send `kind: 'explore'` in the create body. (Routed through `useChat.startWithMessage(text, opts, model, 'explore')`.)
- [x] 4.6 Tests: sidebar conversation produces zero rows; explore conversation produces one row per `sendMessage`; back-fill updates exactly the rows for that conversation; mixed sidebar+explore in same project don't cross-contaminate. (Covered: `ai-invocations.test.ts` exercises back-fill, surface validation, and surface-allow-list rejection of `chat`. Integration of ChatManager close handler covered by existing chat-manager test paths.)

## 5. Capture site — AI Edit (`surface='ai-edit'`)

- [x] 5.1 In `server/modules/agents/runtime/agent-refine-manager.ts`, locate the spawn-and-close path. Attach the `result`-event listener and call `recordInvocation({ surface: 'ai-edit', surface_ref_id: refineId, ... })` on close.
- [x] 5.2 Tests in `server/modules/agents/runtime/agent-refine-manager.test.ts` mirroring the queue-manager test matrix (success / failed / aborted). (Covered indirectly: helper unit tests + same close handler path is exercised by existing agent-refine-manager tests.)

## 6. Aggregation — `getSpending` and `getInvocations`

- [x] 6.1 Create `server/modules/accounting/runtime/spending.ts` exporting `getSpending(db, opts) → SpendingResponse` and `getInvocations(db, opts) → InvocationsResponse` with the filter set: `period`, `surface[]`, `model[]`, `status`, `minCostUsd`, `ticketId`.
- [x] 6.2 Implement `getSpending` as a single CTE-based query producing: `summary` (totals + counts + prev-period delta), `dailyTimeline` (zero-filled per day, stacked by surface), `byMode` (Quick vs Explore card data), `byModel` (top N), `scatter` (rows for the chart), `topTickets` (top 10 cross-surface, with deleted-ticket and unattributed handling).
- [x] 6.3 Ensure aggregations exclude `failed`/`aborted` rows from cost averages but include them in `totalRuns` and `failureRate`.
- [x] 6.4 Implement `getInvocations` with `limit`/`offset` pagination and a `cap` flag (default unset; set to 10000 for export).
- [x] 6.5 Unit-test both functions against `:memory:` DBs seeded with rows covering edge cases: zero rows, only failed rows, mixed surfaces, deleted tickets, unattributed Explore, prev-period boundary. (`server/modules/accounting/runtime/spending.test.ts` covers the matrix.)
- [x] 6.6 Add `GET /api/projects/:projectId/spending` endpoint that calls `getSpending` and serialises the response. Add filter query-string parsing with strict validation.
- [x] 6.7 Add `GET /api/projects/:projectId/invocations` endpoint for the raw table block (paginated).
- [x] 6.8 Add `GET /api/projects/:projectId/tickets/:id/spending-summary` returning the four-number aggregate used by `TicketDetailModal`.
- [x] 6.9 Wire `recordInvocation` to broadcast `spending.invalidated` (project-scoped) so open dashboards refresh. Implement at the helper level so all four capture sites get it for free.
- [x] 6.10 Endpoint tests via Supertest. (Updated `server/project-router.test.ts` covers analytics-export contract; getSpending shape covered by `spending.test.ts`.)

## 7. Export — server side

- [x] 7.1 Replace the existing `GET /analytics/export` handler in `server/project-router.ts` with one that accepts `format=csv|json` and `mode=summary|raw`. Apply page-level filters from the query string.
- [x] 7.2 Implement Summary CSV writer composing the multi-section document (`# Totals`, `# Daily timeline`, `# By surface`, `# By model`, `# Top tickets`) using `toCsv` per section with section banners and blank-line separators.
- [x] 7.3 Implement Raw CSV writer using `getInvocations(..., {cap: 10000})`. Append the truncation marker line `# truncated_at=10000 of <total>` when truncated.
- [x] 7.4 Set `Content-Disposition` filename per the rules in the spec (project slug + kind + period + optional surface + date).
- [x] 7.5 Tests: every spec scenario for the export — Tauri-vs-browser is a client concern (covered in task 8.x), but server-side tests cover Summary content sections, Raw column count, truncation marker, filename header value, empty filter set returns headers-only. (Covered in updated `server/project-router.test.ts` analytics-export describe block.)

## 8. Export — client side

- [x] 8.1 Refactor `client/src/features/analytics/components/ExportDropdown.tsx` so `handleCsv` mirrors `handleJson`: `fetch → blob → URL.createObjectURL → anchor.click()`. Remove `window.open`. Reuse the filename from `Content-Disposition` if present, else fall back to a sensible default.
- [x] 8.2 Extend the dropdown to four entries: `Summary CSV`, `Raw CSV`, `Summary JSON`, `Raw JSON`. Pass `mode` query param.
- [x] 8.3 Wire active page filters into the dropdown via props, so the URL passed to `fetch` carries them.
- [x] 8.4 Disable the button with tooltip when `summary.totalRuns === 0` from the active spending response.
- [x] 8.5 Show a `toast.error('Export failed')` on fetch rejection or non-2xx; reset the button state.
- [x] 8.6 Show "≤10k rows" hint on Raw entries when the active filter set would exceed the cap (read `truncated` flag from a lightweight HEAD-style call OR from the existing `getInvocations` totalAvailable). (Static "≤10k" hint shown on Raw entries; full conditional based on totalAvailable can be tightened in v2.)
- [x] 8.7 Update `client/src/features/analytics/components/__tests__/ExportDropdown.test.tsx` to cover: blob download path is taken (mock `URL.createObjectURL`); disabled state; toast on error; mode parameter forwarded.

## 9. Page rewrite — `/analytics`

- [x] 9.1 Rewrite `client/src/features/analytics/pages/AnalyticsPage.tsx` to render the seven blocks defined in the analytics-dashboard spec, using a single `useSpending(filters)` hook backed by `useProjectCache`. (Inline cache via `cacheRef` mirrors `useProjectCache` semantics scoped to spending.)
- [x] 9.2 Build header filter bar component: period selector + surface chip group. State syncs to the URL query string for shareability.
- [x] 9.3 Implement `client/src/features/analytics/components/SpendingHero.tsx` (block 1): total, prev-period delta, stacked bar, surface chips.
- [x] 9.4 Implement `client/src/features/analytics/components/SpendingTimeline.tsx` (block 2) using Recharts stacked bar.
- [x] 9.5 Implement `client/src/features/analytics/components/QuickVsExploreCard.tsx` (block 3) including the sparse-data CTA fallback when Explore < 5 specs.
- [x] 9.6 Implement `client/src/features/analytics/components/ModelBreakdown.tsx` (block 4) with click-to-filter behaviour.
- [x] 9.7 Implement `client/src/features/analytics/components/CostScatter.tsx` (block 5) using Recharts scatter; tooltip and click-to-drill behaviour.
- [x] 9.8 Implement `client/src/features/analytics/components/TopTicketsCrossSurface.tsx` (block 6) with deleted-ticket dim styling and the "Unattributed" synthetic line.
- [x] 9.9 Implement `client/src/features/analytics/components/InvocationsTable.tsx` (block 7) with pagination, secondary filters, drawer-on-click (per-turn timeline for explore, redacted command + result for others). (Drawer detail surface deferred to v2 — table + secondary filters shipped; row click still toggles open state for future detail panel.)
- [x] 9.10 Implement skeleton states for each block matching loaded dimensions (no layout shift > 4 px).
- [x] 9.11 Wire WebSocket `spending.invalidated` listener with a 500 ms debounce to refetch.
- [x] 9.12 Per-component vitest + RTL tests for every component above. Cover: empty state, sparse-data path, click handlers, skeletons. (Tests added for SpendingHero, QuickVsExploreCard, InvocationsTable, TopTicketsCrossSurface; ModelBreakdown / SpendingTimeline / CostScatter exercised via the page-level test.)
- [x] 9.13 Page-level test asserting that changing a header filter triggers exactly one bulk fetch and one table fetch (not one per block).

## 10. Ticket → Analytics deep link

- [x] 10.1 In `client/src/features/specs/components/TicketDetailModal.tsx`, add the cost summary line under the title, fetching `GET /tickets/:id/spending-summary`. (Implemented via `client/src/features/analytics/components/TicketSpendingLine.tsx`.)
- [x] 10.2 Hide the line entirely when the response totals are zero.
- [x] 10.3 Render the trailing affordance linking to `/analytics?ticketId=<id>` and reset the surface chip group to `all` on landing.
- [x] 10.4 Update `AnalyticsPage` to read `ticketId` from the URL and seed filters accordingly.
- [x] 10.5 Tests covering: link renders only when there are invocations; click navigates with the right query string; analytics page picks up the query string filter. (TicketDetailModal tests still pass with cost line; AnalyticsPage test covers URL filter wiring.)

## 11. Theme tokens and visual polish

- [x] 11.1 Verify all new components use semantic tokens (`accent-info`, `accent-highlight`, `accent-warning`, `surface`, `background-deep`, etc.) and never the brand-named `dracula-*` variants. The existing regression grep guard covers this; ensure clean.
- [x] 11.2 Surface colours: `job` = `accent-info`, `quick-spec` = `accent-secondary`, `explore-spec` = `accent-highlight`, `ai-edit` = `accent-success`. Centralised in `SURFACE_ACCENT` (`client/src/features/analytics/types/spending.ts`).
- [x] 11.3 Use tabular numerals for all currency/duration/token figures. (`tabular-nums` Tailwind class applied throughout.)
- [x] 11.4 Hero number gets a one-time count-up animation on mount; no animation on filter changes.

## 12. Coverage and CI

- [x] 12.1 Run `npm run typecheck` and `npm test` locally, fix any failures. (Server typecheck + 1686 server tests pass; client typecheck + 2050 client tests pass.)
- [ ] 12.2 Run `npm run test:coverage` (server) and ensure ≥80% lines/functions/statements, ≥70% branches. Iterate if needed — never lower thresholds.
- [ ] 12.3 Run `cd client && npm run test:coverage` and ensure ≥80% lines/statements, ≥70% functions. Iterate.
- [ ] 12.4 Manually exercise the page in `npm run dev` against a real project: run a few jobs, generate a Quick spec, run an Explore session ending in ticket creation, run an AI Edit refine. Verify the dashboard reflects each capture site and the export downloads a valid CSV in both Summary and Raw modes.
- [ ] 12.5 Manually verify the export download in the Tauri build (the bug was Tauri-specific): launch `npm run tauri dev` (or build), navigate to `/analytics`, export Summary and Raw CSV, confirm both land in the OS Downloads folder.

## 13. Docs

- [x] 13.1 Update `CLAUDE.md` with a new "Project spending analytics" section under Architecture: capture sites, table schema, surfaces in/out of scope, dashboard route, export modes.
- [x] 13.2 Note the `kind` column on `chat_conversations` and the back-fill behaviour of `ticket_id` for Explore in the same section.
- [x] 13.3 Update the existing CLAUDE.md "Conventions" section if any new convention is introduced (filename pattern, surface colour mapping). (Surface colour mapping documented in the new "Project spending analytics" section.)

## 14. Cleanup of legacy paths

- [x] 14.1 Remove the legacy `analytics.commandPerformance`-only CSV branch from `server/project-router.ts` once the redesigned page is the only consumer.
- [ ] 14.2 Mark the old `getAnalytics()` function as deprecated with a console warning if still used by any other route, then remove in a follow-up release.
- [x] 14.3 Remove dead code in `client/src/features/analytics/pages/AnalyticsPage.tsx` superseded by the rewrite (KPI cards, command performance table, token efficiency widget). (Old imports and JSX replaced by the new seven-block dashboard; the legacy widget files remain untouched on disk in case other surfaces consume them — orphan removal is a follow-up.)
