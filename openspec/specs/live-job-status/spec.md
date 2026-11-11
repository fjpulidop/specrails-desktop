# live-job-status Specification

## Purpose
TBD - created by archiving change live-job-status. Update Purpose after archive.

## Requirements

### Requirement: Job status panel renders for running jobs

The Job Detail page SHALL render compact shared run chrome for running, completed, and failed jobs, showing status, elapsed time, activity/phase, supported actions, and pipeline chips. Status presentation SHALL update on terminal transitions. The metric grid and runtime Details SHALL live in bounded detail content rather than expanding the header inline; diagnosed failures SHALL place this content in Failure reasons.

#### Scenario: Running job shows status panel

- **WHEN** the user opens a job whose `status === 'running'` and that has no answerable pending question
- **THEN** the compact header renders running status, ticking elapsed time, current activity/phase and supported actions, with one pipeline chip row when phases exist
- **AND** live metrics remain accessible through bounded Details in the Log view without a Failure reasons tab

#### Scenario: Status transition refreshes the panel

- **WHEN** a running job receives a terminal status update over the WebSocket (`completed`, `failed`, `canceled`, `zombie_terminated`)
- **THEN** the header status presentation updates without remounting and the user's Details expand/collapse preference is preserved
- **AND** a failed/canceled run with a diagnosis exposes Failure reasons according to the run-detail navigation selection rules, including the answerable-pending-question visibility exception

### Requirement: Live duration ticks while running

While a job is running the Duration metric SHALL update at least once per second using the elapsed time between `started_at` and the current wall clock. When the job reaches a terminal status, the ticker SHALL stop and the Duration SHALL freeze at the value derived from `started_at` → `finished_at`.

#### Scenario: Duration advances every second

- **WHEN** the job has been running for N seconds
- **THEN** the Duration cell shows a value within ±1 second of the elapsed wall-clock time and is re-rendered at least every 1000 ms.

#### Scenario: Duration freezes at job exit

- **WHEN** the job transitions to `completed | failed | canceled | zombie_terminated`
- **THEN** the ticker is cleared and the Duration cell shows `formatWallClock(started_at, finished_at)` and stops advancing.

### Requirement: Turns and Tokens aggregate live from streamed events

While a job is running, the panel SHALL derive the Turns and Tokens metrics from the streamed `assistant` events the client already receives over the existing WebSocket / event feed. Turns SHALL equal the count of `assistant` events. Tokens SHALL equal the sum of `message.usage.input_tokens + message.usage.output_tokens` across all `assistant` events received so far. Aggregation SHALL be incremental (events that have already been counted MUST NOT be re-summed on re-render).

#### Scenario: Counters update as events arrive

- **WHEN** a new `assistant` event is appended to the job's event stream
- **THEN** Turns increments by 1 and Tokens increases by `usage.input_tokens + usage.output_tokens` from that event's payload.

#### Scenario: Missing usage fields do not break aggregation

- **WHEN** an `assistant` event arrives with no `message.usage` block, or with partial fields
- **THEN** Turns still increments by 1, and Tokens treats the missing fields as 0 (no NaN, no crash).

### Requirement: Cost shows em-dash until the result event arrives

While a running job has not yet emitted its final `result` JSON event, the Cost metric SHALL display `—` (em-dash) in the muted-foreground colour. When the job exits, Cost SHALL switch to the authoritative `total_cost_usd` value persisted on the `JobSummary`. Mid-run estimation from token counts is explicitly NOT performed.

#### Scenario: Running job shows dash for cost

- **WHEN** the job's `total_cost_usd` is `null | undefined` (i.e. no `result` event received yet)
- **THEN** the Cost cell renders `—` in the muted-foreground colour and is not styled as a numeric value.

#### Scenario: Cost populates at job exit

- **WHEN** the job transitions to a terminal status and `total_cost_usd` is set
- **THEN** the Cost cell renders the value as `$X.XXXX` in the existing yellow accent colour.

### Requirement: Job detail response includes resolved tickets

The endpoint `GET /api/projects/:projectId/jobs/:id` SHALL include a `tickets` field in its response. The field SHALL be an array of `{ id: number; title: string | null }`, one entry per unique `#<digits>` reference found in the job's `command`, in the order they first appear. The server SHALL resolve titles by reading the project's local ticket store at request time. If a ticket id is not found in the store, the corresponding entry SHALL set `title: null`. If the command contains no `#<digits>` reference, `tickets` SHALL be an empty array.

#### Scenario: Single ticket resolves to title

- **WHEN** a job's command is `/specrails:implement #24 --yes` and ticket `#24` exists in the store with title "Add live job status"
- **THEN** the response includes `tickets: [{ id: 24, title: "Add live job status" }]`.

#### Scenario: Deleted ticket resolves to null title

- **WHEN** a job's command references a ticket id that no longer exists in the store
- **THEN** the response includes that id with `title: null`, and other resolvable tickets in the same command are returned with their titles intact.

#### Scenario: Command without ticket references

- **WHEN** a job's command is `/setup` (no `#<digits>` token)
- **THEN** the response includes `tickets: []`.

#### Scenario: Duplicate ticket references are deduplicated

- **WHEN** a job's command contains the same `#<id>` more than once
- **THEN** the response includes that id exactly once in `tickets[]`, in the position of its first occurrence.

### Requirement: Ticket identity card on Job Detail page

When a job has at least one entry in `tickets[]`, the Job Detail page SHALL render a ticket-identity card above the existing job metadata row. The card SHALL display:

- The ticket number(s) as eyebrow chip(s) at the top.
- The ticket title(s) as the visual hero (large, semibold, foreground colour).
- The job's command, status badge, started_at relative time, and model in a demoted secondary row beneath the title(s).

When `tickets[]` is empty, the card SHALL NOT render and the page SHALL fall back to today's layout.

#### Scenario: Ticket card replaces command as visual hero

- **WHEN** the page renders for a job with at least one resolved ticket
- **THEN** the ticket title is the largest text element in the header area (greater than or equal to the existing `text-sm` command size, with semibold weight) and the command is rendered in a smaller, secondary style on a row beneath the title.

#### Scenario: Job without tickets falls back to legacy header

- **WHEN** the page renders for a job whose `tickets[]` is empty
- **THEN** no ticket card is rendered and the existing header layout (status badge + command + started_at) is shown unchanged.

### Requirement: Ticket card handles deleted tickets gracefully

For each entry in `tickets[]` whose `title` is `null`, the card SHALL render the chip as `#<id> (deleted)` in the muted-foreground colour, MUST NOT make it clickable, and MUST NOT raise any error. Resolvable tickets in the same job SHALL continue to render normally.

#### Scenario: Single deleted ticket

- **WHEN** the only ticket attached to a job has been deleted
- **THEN** the card renders the chip `#24 (deleted)` in the muted-foreground colour, no title text is shown above it, and clicking the chip does nothing.

#### Scenario: Mix of live and deleted tickets

- **WHEN** a job references `#24` (live) and `#25` (deleted)
- **THEN** `#24` renders normally with its title and is clickable; `#25` renders as `#25 (deleted)` muted and not clickable.

### Requirement: Multi-ticket layout

When `tickets[]` contains 2 or 3 entries, the card SHALL render every title in a vertical list, each prefixed by its number. When `tickets[]` contains 4 or more entries, the card SHALL render in a compact mode that shows only the first ticket's title and chip plus a "+ N more" indicator and an expand control; expanding SHALL reveal the full list.

#### Scenario: Two or three tickets list inline

- **WHEN** `tickets.length` is 2 or 3
- **THEN** every ticket id and title is shown directly in the card, with no expand control.

#### Scenario: Four or more tickets compact by default

- **WHEN** `tickets.length` is greater than or equal to 4
- **THEN** the card initially shows only the first ticket's title plus `+ N more` and an expand chevron, where N equals `tickets.length - 1`. Activating the chevron expands the card to list all tickets.

### Requirement: Ticket chip opens spec/ticket detail modal

Clicking on a ticket-number chip whose `title` is non-null SHALL open the existing project ticket / spec detail in a modal overlay on top of the Job Detail page. The Job Detail page SHALL remain visible behind the modal and SHALL NOT be unmounted. No new route is introduced.

#### Scenario: Click on resolvable ticket chip

- **WHEN** the user clicks the chip for ticket `#24` (with non-null title)
- **THEN** a modal opens showing the existing ticket / spec detail UI for `#24`, the URL does not change to a separate ticket route, and dismissing the modal returns focus to the chip.
