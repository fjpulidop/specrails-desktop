## Why

Feedback program 2026-10, Phase 1 task 1.4: we cannot say how long a delivery
waits for a human. Nothing records when a delivery became reviewable, when the
first human decision happened, when its PR was published or when it merged —
`updated_at` moves on every later patch. Without those instants we cannot
measure review latency per loop or per project, nor see whether changes to the
review flow help.

## What Changes

- Append migration 72: nullable ISO `on_review_at`, `decided_at`,
  `published_at`, `merged_at` on `rail_pr_deliveries`. No backfill (not exactly
  derivable): history stays unknown.
- Stamp the instants first-write-wins inside the existing decision CAS UPDATE:
  transitions into `on_review`/`pr_ready`/`merged` stamp the facts they prove;
  the create-pr, discard, acknowledge-no-changes and merge-local adapters pass
  the operation-lease claim instant as `decidedAt`; observation adapters pass
  explicit publish/merge instants; grouped deliveries take the earliest
  repository decision.
- New accounting view `decision-times`: median and p90 of time to decision and
  time to merge per project and per loop, with null-safe counts
  (measured / pending / unknown).
- Expose it at `GET /api/projects/:id/analytics/decision-times`, in a new
  Analytics card (8 locales) and as MCP `specrails_analytics(decision_times)`.

## Capabilities

### New Capabilities
- `delivery-decision-times`: recording delivery review-lifecycle instants and
  reporting time to decision / merge.

### Modified Capabilities
<!-- none: analytics-dashboard gains a card through the new capability -->

## Impact

- `server/db/migrations.ts` (append-only), `server/modules/delivery/runtime/rail-pr-store.ts`,
  decision adapters, `multi-repo-execution.ts`.
- New `server/modules/accounting/runtime/decision-times.ts`, route in
  `server/project-router-spending.ts`, MCP analytics tool/guide.
- Client `DecisionTimesCard` on the Analytics page; locales.
- No change to WebSocket events or existing response shapes.
