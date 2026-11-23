# live-board

Read-model behind the live board (see the
[frontend feature](../../../client/src/features/live-board/README.md)): every run of every
project in one view. It owns no table: cards are projected from state other capabilities
already persist, one project at a time, plus the [inbox](../inbox/README.md) items as they are.

## Where to change behavior

| Change | Owner |
| --- | --- |
| Card shape, column assignment, order inside a column, lanes by mission, done-today window | [domain.ts](domain.ts) (pure) |
| Per-project source, mission directory and today's spend ports | [ports.ts](ports.ts) |
| Collect across projects, isolate failures, cap per project, name Intent cards, totals | [application.ts](application.ts) |
| SQL reads for one project (deliveries, loop runs, Intent sessions, queue jobs, today's run costs) | [adapters/project-source.ts](adapters/project-source.ts) |
| Mission titles, providers and their own turns today (`agent_conversations`, `agent_invocations`) | [adapters/missions.ts](adapters/missions.ts) |
| `GET /api/live-board` | [adapters/http.ts](adapters/http.ts), registered by [desktop-router.ts](../../desktop-router.ts) |
| Reuse of a settled project's read | [adapters/settled-project-cache.ts](adapters/settled-project-cache.ts) |

## How a card is placed

- **One card per attempt chain.** A loop run that a later attempt continued (an adopted fork) is
  history, never a card: the chain shows its latest attempt, which carries `attempt: { number, of }`.
  Same rule as the inbox and the jobs list (`supersededAttemptSql`, `loops/runtime/run-attempts.ts`).
  The card's `costUsd` and `costTodayUsd` are the chain's (every attempt added up once, as analytics
  counts it); `costEstimatedUsd` is the rate-card part of `costUsd`, so billed and estimated stay
  apart; the latest attempt's own cost is on `attempt.costUsd`.
- **Needs you = the inbox.** The route projects the inbox with the same sources as
  `GET /api/inbox` (`createInboxSources`) and lands each item on the run it speaks for (delivery id or
  loop-run id). Every item, a review included, is in Needs you, so the column count is the inbox count. An item
  with no run on the board (a Jira update, a reached cap, a failure from an earlier day) is its own card.
  So a run is never in two columns and every inbox item is on the board exactly once.
- **In progress:** a building delivery, a running or paused loop run, an open Intent session
  (active, paused, needs-review), a running or queued queue job (queued after running).
- **Needs you** also takes a delivery on review / PR draft / PR ready that the inbox did not list (it still
  waits on the person; the inbox lists every one, so in practice the counts agree).
- **Done today:** anything settled inside the local day (`util/local-day`, the same day as spend caps and
  Analytics): merged / completed / no changes, stopped (cancelled, discarded, closed) and the settled runs
  the inbox does not list (a queue job that failed, a run superseded by a later one). Older history is not
  on the board.
- **One card per run.** A delivery is the card of its runs (`run_ids`); an Intent session that was handed off
  continues as its delivery's card; a loop run's backing `jobs` row (`owner = 'loop'`) is the loop run.

## Missions (layout B)

A card's `conversationId` is the mission that launched it: `rail_pr_deliveries.origin_conversation_id`
for isolated rail runs, `flow_sessions.conversation_id` for Intent, `pr_ci_admissions.origin_conversation_id`
for a CI-fix run, and the live `ProjectContext.railLoopRuns` entry for a shared-checkout run (that link is
in memory only, so a settled shared-checkout run falls into "Not from a mission"). Queue jobs carry no
mission. Lanes order by their most urgent card (needs you, in progress, done today), then by most
recent activity; the lane without a mission is last. A lane's spend today is the mission's own turns
today (its ledger) plus what its runs recorded today (`ai_invocations`).

## Invariants

- Project isolation: a source is bound to ONE project's database, filters `loop_runs` by its project id,
  and the collector drops any inbox item of another project. The only reuse between calls is a project
  with nothing live (no loop run running or paused, no rail or restart-pending state in memory): its
  read is kept per connection and reused while `total_changes()`, `PRAGMA data_version` and the local
  day are unchanged, so any write by this or another connection invalidates it
  ([settled-project-cache.ts](adapters/settled-project-cache.ts)).
- Responsiveness: the HTTP adapter reads projects (and their inbox sources) one at a time in short
  event-loop slices, and computes the app-wide spend once per request, so a board of many projects never
  blocks health checks or WebSocket traffic.
- Merge preview: the HTTP adapter attaches each delivery card's last merge preview
  (`peekMergePreview`, owned by [delivery](../delivery/README.md#merge-preview)) and asks for a
  throttled background refresh per project; it never computes one on the request. A changed
  preview is broadcast as `rail.merge_preview`, which the board treats as a nudge.
- Read-only. Every statement is parameterized and runs once per refresh (no per-card query); each read is
  guarded, so a missing table costs that read only, and a broken project costs that project only.
- Totals are the column counts (`needsYou`, `inProgress` with paused runs included, `doneToday`).
- Caps: 200 rows per table read, 120 cards per project (settled history dropped first).
- The state's LOOK is not decided here: a card carries its domain status (`status`), and the client maps it
  through its run-state vocabulary.
- Today's total is `getDesktopTodayStats` (the status bar / Analytics figure), not a new calculation.

Run `npx vitest run server/modules/live-board`.
