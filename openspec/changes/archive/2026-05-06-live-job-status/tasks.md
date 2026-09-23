## 1. Server: ticket resolution on Job Detail

- [x] 1.1 Extract a shared `extractTicketIdsFromCommand(command: string): number[]` helper (preserve first-occurrence order, dedupe). Place in `server/modules/specs/runtime/ticket-store.ts` or a new `server/ticket-helpers.ts`.
- [x] 1.2 Refactor `QueueManager._extractTicketIds` to call the shared helper (no behavioural change).
- [x] 1.3 In `server/project-router.ts`, extend the `GET /api/projects/:projectId/jobs/:id` handler to resolve `tickets: Array<{ id: number; title: string | null }>` from the job's `command` and the project's ticket store. Use `ProjectContext.path` as `cwd` for `resolveTicketStoragePath`.
- [x] 1.4 Return an empty array when the command has no `#<digits>` token.
- [x] 1.5 Return `title: null` for ids missing from the store; do not throw.
- [x] 1.6 Add server-side tests in `server/project-router.test.ts` (or the closest existing job-route test file) covering: single live ticket → resolved title; deleted ticket → null title; mixed live/deleted; command with no ticket id → empty array; duplicate `#<id>` deduped in first-occurrence order.

## 2. Client types & data wiring

- [x] 2.1 Extend the job-detail type in `client/src/types.ts` with `tickets?: Array<{ id: number; title: string | null }>`. (Decide whether this lives on `JobSummary` or a narrower `JobDetail` — either is acceptable; pick the one that minimises churn at the call sites.)
- [x] 2.2 Update the Job Detail data-fetching hook / loader in `JobDetailPage.tsx` so the new field reaches the page without breaking existing consumers.

## 3. Client: rename and extend the status panel

- [x] 3.1 Rename `client/src/components/JobCompletionSummary.tsx` → `JobStatusPanel.tsx`. Update all imports.
- [x] 3.2 Rename the test file `JobCompletionSummary.test.tsx` → `JobStatusPanel.test.tsx`. Adjust describe titles. Verify all existing assertions pass unchanged.
- [x] 3.3 Refactor `formatWallClock(start, end)` to accept `(start: string, end: string | number)` so a `Date.now()` numeric timestamp works without conversion.
- [x] 3.4 Add a `running` rendering branch:
  - Header label: "Job in progress".
  - Header icon: `Loader2` with `animate-spin` class.
  - Frame colours: `border-info/20 bg-info/5` (semantic tokens only — no `dracula-*`).
- [x] 3.5 Add an internal 1-second ticker (`setInterval`) that re-renders Duration while `job.status === 'running'`. Clear on unmount and on transition to terminal status.
- [x] 3.6 Implement an incremental Turns/Tokens accumulator using `useReducer`, keyed by event index. Reset when `job.id` changes. Iterate only the new tail of `events` on each update.
- [x] 3.7 Tokens aggregator MUST tolerate missing or partial `message.usage` (treat missing fields as 0; never NaN).
- [x] 3.8 Cost cell renders `—` in `text-muted-foreground` while `total_cost_usd` is null/undefined. Switches to `$X.XXXX` in `text-yellow-400` once populated.
- [x] 3.9 Pipeline-totals roll-up keeps current behaviour (only finished phases contribute to `totalCostUsd`). No changes to `pipelineTotals` math.

## 4. Client: ticket identity card on Job Detail

- [x] 4.1 Create `client/src/features/jobs/components/JobTicketHeader.tsx`. Props: `tickets`, `command`, `status`, `startedAt`, `model`, `onTicketClick`. Render contract follows `live-job-status` spec scenarios.
- [x] 4.2 Implement layout modes: hidden when `tickets.length === 0`; list mode for 2–3 tickets; compact mode with `+ N more` and expand chevron for ≥4 tickets.
- [x] 4.3 Single-ticket layout: chip + title as visual hero (text-lg, semibold), command + status badge + started_at + model on a demoted row beneath.
- [x] 4.4 Deleted-ticket handling: tickets whose `title` is `null` render as `#<id> (deleted)` in `text-muted-foreground`, non-clickable, no title row above.
- [x] 4.5 In `JobDetailPage.tsx`, mount `JobTicketHeader` *above* the existing job info row. When the header renders (non-null), demote the legacy info row (smaller status badge, smaller `code` for command).
- [x] 4.6 Remove the `status === 'completed' || status === 'failed'` gate around the panel. The `JobStatusPanel` SHALL also render for `status === 'running'`.

## 5. Client: ticket modal trigger

- [x] 5.1 Identify the existing spec/ticket detail modal/component (likely under `client/src/components/specs/` or `SpecsBoard`'s detail child). Document the chosen entry point in a one-line comment in `JobTicketHeader`.
- [x] 5.2 If no project-wide modal trigger exists, add a thin context provider (`TicketDetailModalProvider`) at the `ProjectLayout` level exposing an `openTicketDetail(id)` method and rendering the existing detail UI inside a Radix `Dialog`. Pattern after `MinimizedChatsProvider` for scoping.
- [x] 5.3 Wire `JobTicketHeader` chip clicks to `openTicketDetail(id)`. Skip for tickets with `title === null` (visually disabled chip).
- [x] 5.4 Confirm focus return to the originating chip on modal dismiss. (Radix Dialog handles focus return automatically when triggered from a focusable element.)

## 6. Tests

- [x] 6.1 In `JobStatusPanel.test.tsx`, add a `describe('running')` block covering: header label "Job in progress", spinner present, Duration text matches mocked elapsed time, Cost cell shows `—`, Turns and Tokens reflect mocked event stream, transition to `completed` swaps header without unmounting.
- [x] 6.2 Add aggregator-level test: thousand `assistant` events with varying `usage` shapes — verify final Tokens equals manual sum and partial/missing usage doesn't NaN the value.
- [x] 6.3 In `JobDetailPage.test.tsx`, cover: panel renders for `running` jobs (gate removed), `JobTicketHeader` shows when `tickets[]` non-empty, falls back when empty, deleted ticket renders muted, multi-ticket compact mode appears at 4+, expand reveals all titles.
- [x] 6.4 Server-side test from task 1.6 must also assert no behavioural regression on existing `GET /jobs/:id` consumers (response remains a superset of the previous shape).

## 7. Coverage & polish

- [x] 7.1 Run `npm run typecheck`, `npm test`, `npm run test:coverage` (server) and `cd client && npm run test:coverage` locally. All thresholds must pass: 70% global lines/functions/statements, 80% server (70% branches), 80% client (lines/statements, 70% functions). If any threshold drops, add tests until it recovers — never lower thresholds.
- [ ] 7.2 Manual UX pass with `npm run dev`: launch a real `/specrails:implement` job with one ticket, confirm Duration ticks, Turns and Tokens advance with each assistant turn, Cost stays at `—`, snaps to value on completion. Confirm ticket card renders, modal opens. _(Pending: requires user to run the dev server and trigger a real job.)_
- [ ] 7.3 Manual UX pass for edge cases: job with no ticket reference (header falls back), job with deleted ticket (chip muted, no modal on click), pipeline with multiple phases (each phase's panel independently transitions). _(Pending: same.)_
- [x] 7.4 Update root `CLAUDE.md` "Client architecture" or relevant section with a one-line description of `JobStatusPanel` (the renamed component) and `JobTicketHeader`.
