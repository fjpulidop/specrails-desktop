# inbox

Read-model behind the "Needs you" inbox (see the
[frontend feature](../../../client/src/features/inbox/README.md)). It owns no table:
every item is projected from state other capabilities already persist, one project at a time.

## Where to change behavior

| Change | Owner |
| --- | --- |
| Item vocabulary, ordering, id/version rules | [domain.ts](domain.ts) (pure) |
| Per-project source port | [ports.ts](ports.ts) |
| Collect across projects, isolate failures, cap per project | [application.ts](application.ts) |
| SQL/store reads for one project (deliveries, loop runs, Jira outbox, reached spend caps) | [adapters/project-source.ts](adapters/project-source.ts) |
| `GET /api/inbox` | [adapters/http.ts](adapters/http.ts), registered by [desktop-router.ts](../../desktop-router.ts) |

## Invariants

- Project isolation: a source is bound to ONE project's database and the collector drops
  any item whose `projectId` is not its own. Nothing is cached between calls.
- Read-only. Snooze / Done never reach the server; they are per viewer, keyed by item id
  and `version` (see the client README).
- A broken project or a missing table costs that source only; the others still answer.
- A run a delivery already represents (`rail_pr_deliveries.run_ids`) is left to the delivery.
- A failed or blocked run (and a failed delivery, through its last run) carries the [failure diagnosis](../recovery/README.md) read from `loop_runs.failure_diagnosis`; a high-confidence provider limit or environment problem is listed as `blocked`, not `failed`, and the item `version` moves with the cause.
- A reached spend cap (daily, weekly or monthly; project or app-wide) is a `budget` item with action `raise-cap` and a structured `cap`; it leaves on its own once raised or after the reset, and an app-wide cap is listed once (under the first project).
- `version` changes whenever the underlying state changes, which re-arms a dismissed item.

Run `npx vitest run server/modules/inbox`.
