## 1. Persistence

- [x] 1.1 Append migration 72 adding nullable `on_review_at`, `decided_at`, `published_at`, `merged_at` (no backfill)
- [x] 1.2 First-write-wins stamping in `transitionDecision` / `transitionClaimedDecision` via pure `lifecycleStamps`

## 2. Decision adapters

- [x] 2.1 `decisionInstant` (lease claim instant) helper
- [x] 2.2 create-pr (success and failure), discard, acknowledge-no-changes, merge-local stamp `decidedAt`
- [x] 2.3 merge-local, observed merge and chain sweep stamp `mergedAt`; observed publish stamps `publishedAt`
- [x] 2.4 Grouped parent takes the earliest repository `decided_at`

## 3. Analytics

- [x] 3.1 `accounting/runtime/decision-times.ts`: null-safe median/p90 per project and loop
- [x] 3.2 `GET /analytics/decision-times` route with period validation
- [x] 3.3 MCP `specrails_analytics(decision_times)` + guide
- [x] 3.4 Client `DecisionTimesCard` on the Analytics page; 8 locales

## 4. Verification and docs

- [x] 4.1 Tests: idempotent stamps (double decision, replay), each adapter, aggregation with nulls, API shape, MCP, client render with/without data, migration
- [x] 4.2 Docs: api-reference, tracking-cost, delivery and accounting READMEs; boundary manifest and source map
