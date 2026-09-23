# accounting

This module owns the accounting capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/ai-invocations.ts](runtime/ai-invocations.ts)
- [runtime/codex-otel-bridge.ts](runtime/codex-otel-bridge.ts)
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
