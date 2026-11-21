# events-journal

A durable, append-only journal of the app's **state transitions**, so an agent can block on
`specrails_wait` instead of polling ([MCP v2 contracts](../../../docs/internals/mcp-v2.md)). It is
fed by the in-process bus that mirrors every WebSocket broadcast (`getMobileEventBus()`), started
at boot by [server/index.ts](../../index.ts), and read by [v2/tools/wait.ts](../../mcp/v2/tools/wait.ts).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Which broadcasts become rows, their status word, hold, attention and `settled` flag | [domain.ts](domain.ts) `classifyMessage` (pure, total) |
| Retention and compaction limits | [domain.ts](domain.ts) `JOURNAL_RETENTION` |
| Filters (refs, project, settled, attention) | [ports.ts](ports.ts) `JournalFilter`; SQL in [adapters/sqlite.ts](adapters/sqlite.ts) `filterSql`, in-memory twin `matchesFilter` in [application.ts](application.ts) (a test keeps them identical) |
| De-duplication, batching, waiters, compaction triggers | [application.ts](application.ts) |
| Table, indexes, cursors' epoch | [adapters/sqlite.ts](adapters/sqlite.ts) |
| One journal per app database, boot wiring | [runtime.ts](runtime.ts) |

## Rows

`events_journal` in `desktop.sqlite` (schema owned here, created idempotently):
`seq` (AUTOINCREMENT, never reused), `at`, `project_id`, `ref_kind` + `ref_id` (run, delivery,
chain, intent, spec, mission, project, blueprint, milestone), `kind` (`run.status`, `run.hold`,
`delivery.decision`, …), the domain `status` word, `prev_status`, `hold`, `attention` (question,
approval, review, failed, blocked, budget — null when nobody has to act), `settled`, short
untrusted `title`/`detail`, and small `data` (the compact question card, rail index, PR link,
resume time, spend cap). `events_journal_meta` holds the `epoch` (cursors from another database
are recognized) and the compaction high-water mark.

## Invariants

- Transitions only: logs, stream deltas, tool output and full message bodies never become rows.
  A repeat of the last state of a ref (same status, hold, attention, detail, question id) is dropped,
  also across restarts (the last row is re-read for a ref not in memory).
- The `queue` snapshot only fills gaps: it never overrides a hold or a finished run.
- Ingest never throws into the broadcast loop; a closed or busy database costs the journal, not the app.
  Rows are appended in one transaction on the next tick; waiters are matched in memory against the
  appended rows (no query per waiter) and wake within one tick plus a 100 ms settle window.
- Retention: 7 days, 200k rows. Compaction removes intermediate rows (superseded, no attention) older
  than 24 h; the latest row of every ref and every row that needed the person stay until retention.
- Mapping domain words to the MCP status vocabulary is the reader's job (`core/status-map.ts`).

Run `npx vitest run server/modules/events-journal server/mcp/v2/tools/wait.test.ts`.
