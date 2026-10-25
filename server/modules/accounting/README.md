# accounting

This module owns the accounting capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/ai-invocations.ts](runtime/ai-invocations.ts)
- [runtime/codex-otel-bridge.ts](runtime/codex-otel-bridge.ts)
- [runtime/decision-times.ts](runtime/decision-times.ts)
- [runtime/desktop-analytics.ts](runtime/desktop-analytics.ts)
- [runtime/metrics.ts](runtime/metrics.ts)
- [runtime/pricing.ts](runtime/pricing.ts)
- [runtime/result-event.ts](runtime/result-event.ts)
- [runtime/spending.ts](runtime/spending.ts)
- [runtime/telemetry-compactor.ts](runtime/telemetry-compactor.ts)
- [runtime/telemetry-export.ts](runtime/telemetry-export.ts)
- [runtime/telemetry-receiver.ts](runtime/telemetry-receiver.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/accounting` and any affected consumers.

## Decision times

[decision-times.ts](runtime/decision-times.ts) aggregates the first-write-wins
delivery lifecycle instants (migration 72: `on_review_at`, `decided_at`,
`published_at`, `merged_at`) into median/p90 time to decision and time to merge,
per project and per loop (`GET /api/projects/:id/analytics/decision-times`,
MCP `specrails_analytics(decision_times)`). Missing instants are counted as
`unknown` (or `pending` while still awaited) and never become zero durations.
Repository children of grouped deliveries count once through their parent.

## Loop economics

[loop-economics.ts](runtime/loop-economics.ts) compares loops over a period
(`GET /api/projects/:id/analytics/loop-economics`, MCP
`specrails_analytics(loop_economics)`): delivered (reached review or beyond),
merged, discarded, cost per delivery (attributed like
`sumInvocationCostForRuns`, authoritative and estimated portions separate,
unpriced deliveries excluded from the average), decision times (reusing
`aggregateDecisionTimes`), reviewer/fixer rounds from `loop_step` events and
escaped defects from tickets' `metadata.regressionOf` (passed in by the router,
so this module does not import the ticket store). Requirements demonstrated and
triage accuracy are nullable placeholders. The pure helpers
(`isDelivered`, `summarizeInvocationCost`, `countLoopRounds`,
`aggregateLoopEconomics`) are the shared join rules the offline
`scripts/metrics-baseline.mjs` export can import.

## What-if pricing

[what-if.ts](runtime/what-if.ts) backs `GET /api/projects/:id/budget/what-if`: it re-prices the *recorded* token usage
of one `provider:model` bucket on another model with the local rate card ([pricing.ts](runtime/pricing.ts)). Both sides
are estimates (the current model is re-priced the same way, so the delta compares like with like); the recorded cost
is reported apart and never enters the delta. A model the rate card cannot price is reported as `noPricing` with null
estimates, never guessed; a long-context tier is applied per invocation, not to the sum. Usage is recorded per model,
not per profile role, so the source is a model bucket. The spend-vs-caps read model and the month-end projection live
in the [execution module](../execution/README.md#spend-caps).
