## Why

Today the Job Detail page only shows aggregated stats (Duration, Cost, Turns, Tokens) once the job has finished — while a job is running, the user sees nothing about its progress beyond raw streaming logs. Worse, jobs are identified by their command (`/specrails:implement #24 --yes`) rather than by *what they are about*, which makes it hard to recognise a job at a glance.

This change brings the Job Detail header to a premium standard: a live status panel that ticks while the job is running (Duration, Turns, Tokens) and a ticket-aware identity card that shows the title(s) of the ticket(s) attached to the job.

## What Changes

- Render the job-status panel for jobs in `running` state (today it only renders on `completed | failed`). Header label switches to "Job in progress" with a spinner; chevron-stat row stays.
- Tick the Duration cell every 1s while the job is running (started_at → now); freeze it at job exit.
- Compute Turns and Tokens live by aggregating the streamed `assistant` events the client already receives (count + sum `message.usage.{input,output}_tokens`). No DB writes, no new WS message.
- Cost displays `—` while running. It only switches to the real value when the final `result` event arrives at job exit (driven by the existing `total_cost_usd` field on `JobSummary`). Per-phase Cost behaves identically — finished phases show the value, the active phase shows `—`.
- Add a ticket identity card above the status row on the Job Detail page: shows ticket number(s) as eyebrow chip(s) and the ticket title(s) as the visual hero. Command and status badge demote to a secondary line. Card only renders when the job has at least one resolvable ticket.
- Multi-ticket: list-mode for ≤3 tickets, compact-with-expand-toggle for ≥4.
- Clicking a ticket number opens the existing spec/ticket detail in a modal. (No new route.)
- Server-side: extend `GET /api/projects/:projectId/jobs/:id` to include `tickets: Array<{ id: number; title: string | null }>`. Resolution: extract `#(\d+)` from `command` (existing `_extractTicketIds` logic), look up titles in `ticket-store` at request time. Deleted tickets resolve to `{ id, title: null }` and render as `#24 (deleted)` in muted style.

Out of scope (explicit decisions taken in `/opsx:explore`):
- Persisting ticket-title snapshots on the job row (rejected — render live, accept that renames update historical jobs).
- Showing ticket titles in `RecentJobs` / Dashboard cards (deferred — same problem, separate change).
- Estimating cost mid-run from a pricing table (rejected — `—` until the authoritative `result` arrives is honest and simpler).
- Server-side broadcasting of mid-run aggregates (rejected — client already receives the events, derive there).

## Capabilities

### New Capabilities

- `live-job-status`: Real-time presentation of job progress on the Job Detail page, including a ticking duration, live turns and tokens accumulated from streamed events, deferred cost, and a ticket-identity card resolved server-side from the job command.

### Modified Capabilities

(none — no existing capability covers Job Detail today.)

## Impact

- **Server**: `server/project-router.ts` (`GET /jobs/:id` response shape gains `tickets[]`). Reuses `_extractTicketIds` regex semantics and `ticket-store.readStore`. No DB migration. No new endpoint.
- **Client types**: `client/src/types.ts` — `JobSummary` (or a new `JobDetail`) gains `tickets?: Array<{ id; title }>`.
- **Client UI**:
  - `client/src/components/JobCompletionSummary.tsx` extends to a `running` rendering branch (header label, spinner, ticking duration, live aggregator). Likely renamed to `JobStatusPanel` to reflect the broader role.
  - `client/src/features/jobs/pages/JobDetailPage.tsx` removes the `status === 'completed' | 'failed'` gate around the panel; adds the new ticket-identity card above the metadata row; demotes command + status badge.
  - New component: `JobTicketHeader` (or similar) handling single/multi/empty/deleted-ticket states and modal trigger.
  - Reuses an existing spec/ticket detail modal — confirm the right component during implementation.
- **Tests**: extend `JobCompletionSummary.test.tsx` (running branch, ticker, live aggregation, cost dash); extend `JobDetailPage.test.tsx` (gate removal, ticket header rendering, deleted-ticket fallback, multi-ticket expand); add server-side test for `GET /jobs/:id` `tickets[]` resolution incl. deleted-ticket case.
- **No changes** to `specrails-core`, `QueueManager`, `ChatManager`, telemetry, profile snapshots, plugin snapshots, or the WebSocket protocol.
