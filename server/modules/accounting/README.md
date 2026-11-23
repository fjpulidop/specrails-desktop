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
- [runtime/spend-categories.ts](runtime/spend-categories.ts)
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

## One spend picture per project

[spending.ts](runtime/spending.ts) `getSpending` / `getInvocations` read the
project `ai_invocations` ledger and, when the composition root passes the
desktop DB, the app-level `agent_invocations` rows pinned to the project as the
read-only virtual surfaces `mission` (Agent Chat / Mission turns) and `intent`
(Intent-mode turns, ledger surface `flow`). Both ledgers are disjoint, so the
merge never double counts; the ticket filter excludes agent rows. An unreadable
agent ledger degrades to the project ledger alone. `recordInvocation` keeps
rejecting the virtual surfaces.

[spend-categories.ts](runtime/spend-categories.ts) is the pure surface →
category mapping (implementation, missions, specs, code, support) behind
`byCategory` and the `category` filter. The client mirrors it in
`client/src/features/analytics/types/spending.ts`; keep both in sync (each side
has a test that every surface maps to exactly one category).

## App-wide analytics

[desktop-analytics.ts](runtime/desktop-analytics.ts) (`GET /api/analytics`, the
All-projects analytics page, and the status-bar today figures) counts the app
ledger (`agent_invocations`) exactly like the project ledgers: cost, estimated
part, priced/unpriced counts, the per-day timeline and the five-category
`byCategory` split (same mapping as the project page; ledger surface `flow` is
`intent`, anything else `mission`). A turn pinned to a loaded project lands on
that project's row (`agentTurns`); Home missions, Blueprint / Builder chats
(`project_id` NULL) and turns pinned to a project that is not loaded form one
explicit `kind: 'app'` row (`APP_LEDGER_ROW_ID`, shown as "Home & Blueprint").
The window clause applies to agent turns too. Job counts and success rate stay
job-only.

## Core v1 programmatic runs

A Core v1 invocation reports one inclusive total (`agent-runtime` / `per-role`).
`insertLoopInvocation` (loops) splits it with
[attributeProgrammaticUsage](../agent-runtime/runtime/agent-runtime-accounting.ts):
the step's Core events give each settled attempt's usage and the provider/model
of its calls (`runtime-efficiency-event` kind `role-context`, which now keeps
the call's own usage). One row per phase × provider × model is written (id
`core-v1:<invocation>:<n>[:t<ticket>]`, `surface_ref_id` `<node>:<phase>`). The
shares must reconcile with the invocation total per metric — a positive
remainder (e.g. an in-flight attempt) stays an `agent-runtime` row, anything
that exceeds the total or is unknown against a known total keeps the single
aggregate row. A cost Core did not report stays unknown (not rate-carded here),
so totals never change. Core's deterministic completion check
(`deterministic-verification`) calls no provider and writes no row. Migration 95
re-attributes history only where it is provable (one v1 invocation in the run,
one provider per attempt, figures that reconcile) and drops the old $0
verification rows; everything else stays as recorded.
