# Execution core

The [public API](index.ts) owns pending-queue admission, dependency eligibility
and job usage attribution. [Scheduling](domain/scheduling.ts) is deterministic
and does not mutate the live queue. The [accounting use case](application/record-job-invocations.ts)
accepts narrow [write/identity ports](ports.ts), preserving integer token totals,
unknown measurements, ticket references and project ownership.

[QueueManager](../../queue-manager.ts) composes the existing SQLite writer and
UUID generator. It still owns the settlement transaction, synchronous slot
reservation, process handles, durable recovery and notifications. The accounting
use case does not swallow errors, open transactions or retry individual writes.
These responsibilities have not yet been migrated out of QueueManager.

Run `npx vitest run server/modules/execution server/queue-manager.test.ts`.
The queue suite covers settlement failure, crash replay, cancellation and budgets;
[port tests](__tests__/accounting.test.ts) cover attribution and error propagation.
[Architecture guards](../architecture.test.ts) prevent infrastructure imports.
