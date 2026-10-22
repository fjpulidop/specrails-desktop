## Why

Feedback program 2026-10, Phase 4 task 4.5 (metrics 9.1): the pilot needs one
place that answers "what does each loop cost us and how good is what it ships?".
Today cost, review latency, rework and escaped defects live in separate surfaces
(spending, decision times, loop step logs, tickets) or nowhere at all, so loops
cannot be compared over a period and the pilot baseline cannot be revisited
in-app.

## What Changes

- New pure+effectful aggregation `accounting/runtime/loop-economics.ts`: per loop
  (`loop_id` / factory id and name) over a period — deliveries delivered
  (reached `on_review` or beyond), merged, discarded, superseded, still on review;
  discard rate; average cost per delivery from attributed `ai_invocations`
  (provider-reported/authoritative and pricing-table estimated portions kept
  separate; unknown cost never zero); time to decision and to merge (reusing
  `decision-times`); review and fixer rounds per delivery from `loop_step` events;
  escaped defects from tickets linked with `regressionOf`; and two nullable
  placeholder columns (requirements demonstrated, triage accuracy) that report
  "no data" until spec-trace and triage land.
- Saved (published) loops without deliveries in the period are listed with
  `hasData: false` so the UI shows "no data" instead of zeros.
- Ticket metadata gains optional `regressionOf: <deliveryId>` (desktop-owned,
  ignored by Core, no ticket schema bump). Validated on create/update; `null`
  clears it. The ticket create and detail modals expose a "Regression of"
  picker of recent deliveries for bug-labelled tickets.
- HTTP `GET /api/projects/:id/analytics/loop-economics` and
  `GET /api/projects/:id/analytics/loop-economics/deliveries` (picker source);
  MCP `specrails_analytics(loop_economics)`.
- Client `LoopEconomicsCard` on the Analytics page; 8 locales.
- Revert-commit detection on delivered branches is out of scope (not cheap: it
  needs git access per delivered branch after merge); documented.

## Capabilities

### New Capabilities
- `loop-economics-analytics`: per-loop economics aggregation, API/MCP exposure,
  escaped-defect linkage and client surface.

## Impact

- Server: `server/modules/accounting/runtime/loop-economics.ts` (new),
  `server/project-router-spending.ts`, `server/project-router-tickets.ts`,
  `server/modules/specs/runtime/ticket-store.ts`, `server/mcp/tools/analytics.ts`,
  `server/mcp/guide.ts`, boundary manifest.
- Client: analytics card, ticket modals, `useTickets`, types, 8 locales.
- Docs: `docs/tracking-cost.md`, `docs/internals/api-reference.md`, MCP guide,
  accounting README, source map.
- No migration. Stacked on `delivery-decision-times` (migration 72).
