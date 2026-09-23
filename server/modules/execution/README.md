# Execution core

The [public API](index.ts) owns pending-queue admission, dependency eligibility
and job usage attribution. [Scheduling](domain/scheduling.ts) is deterministic
and does not mutate the live queue. The [accounting use case](application/record-job-invocations.ts)
accepts narrow [write/identity ports](ports.ts), preserving integer token totals,
unknown measurements, ticket references and project ownership.

[QueueManager](runtime/queue-manager.ts) composes the existing SQLite writer and
UUID generator. [Durable usage recovery](application/recover-job-usage.ts) also
runs against a narrow event/provider port: the [reader adapter](adapters/usage-reader.ts)
streams ordered SQLite rows and interprets provider frames. The use case owns
message deduplication, cumulative turn accounting, terminal authority and bounded
snapshot retention. Storage errors propagate to the existing recovery transaction.

QueueManager still owns the settlement transaction, synchronous slot
reservation, process handles, durable recovery and notifications. The accounting
use case does not swallow errors, open transactions or retry individual writes.
These responsibilities have not yet been migrated out of QueueManager.

Run `npx vitest run server/modules/execution server/modules/execution/runtime/queue-manager.test.ts`.
The queue suite covers settlement failure, crash replay, cancellation and budgets;
[port tests](__tests__/accounting.test.ts) cover attribution and error propagation.
[Architecture guards](../architecture.test.ts) prevent infrastructure imports.

## Reviewed public entry points

- [runtime/accept-ladder.ts](runtime/accept-ladder.ts)
- [runtime/interactive-job-session.ts](runtime/interactive-job-session.ts)
- [runtime/job-listing.ts](runtime/job-listing.ts)
- [runtime/job-phase-breakdown.ts](runtime/job-phase-breakdown.ts)
- [runtime/job-spawn-idempotency.ts](runtime/job-spawn-idempotency.ts)
- [runtime/queue-manager.ts](runtime/queue-manager.ts)
- [runtime/revision-seed.ts](runtime/revision-seed.ts)
- [runtime/run-duration-stats.ts](runtime/run-duration-stats.ts)
- [runtime/spawn-lifecycle.ts](runtime/spawn-lifecycle.ts)
- [runtime/stuck-run-detector.ts](runtime/stuck-run-detector.ts)
- [runtime/verification-sentinel.ts](runtime/verification-sentinel.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/execution` and any affected consumers.
