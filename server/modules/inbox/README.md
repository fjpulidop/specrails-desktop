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
| SQL/store reads for one project (deliveries, loop runs, Jira outbox) | [adapters/project-source.ts](adapters/project-source.ts) |
| `GET /api/inbox` | [adapters/http.ts](adapters/http.ts), registered by [desktop-router.ts](../../desktop-router.ts) |

## Invariants

- Project isolation: a source is bound to ONE project's database and the collector drops
  any item whose `projectId` is not its own. Nothing is cached between calls.
- Read-only. Snooze / Done never reach the server; they are per viewer, keyed by item id
  and `version` (see the client README).
- A broken project or a missing table costs that source only; the others still answer.
- A run a delivery already represents (`rail_pr_deliveries.run_ids`) is left to the delivery.
- `version` changes whenever the underlying state changes, which re-arms a dismissed item.

Run `npx vitest run server/modules/inbox`.
