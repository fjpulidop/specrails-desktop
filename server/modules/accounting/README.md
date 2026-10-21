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
