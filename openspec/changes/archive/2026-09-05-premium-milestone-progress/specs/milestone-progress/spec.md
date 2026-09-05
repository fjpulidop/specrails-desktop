## ADDED Requirements

### Requirement: Server-derived milestone progress
The server SHALL derive, per blueprint milestone, a progress model from durable rows only: ticket counts by state (`total`, `done`, `onReview`, `inProgress`, `todo`, `failed`), the milestone's rails (those carrying milestone tickets with an active run or a non-terminal delivery, each with rail index/name, run id, start time, delivery snapshot and chunk index), the active launch chain snapshot when one exists, the stored blueprint status and a derived `state`. Tickets SHALL map to milestones by their `M<n>` label. `failed` SHALL count milestone tickets currently `todo` whose newest delivery unit failed — never an inferred value. The derived `state` SHALL be `done` when every ticket is `done`; `delivered` when no ticket is `todo` or `in_progress` and at least one is `on_review`; `running` when any ticket is `in_progress` or a chain is running/waiting; `committed` when tickets exist; otherwise the stored status. `GET /:projectId/blueprint` SHALL return `{ blueprint, progress }` where `progress` is that array.

#### Scenario: Delivered milestone is not reported as done
- **WHEN** all 8 `M1` tickets sit at `on_review` after their runs settled
- **THEN** the M1 progress reports `onReview: 8`, `done: 0` and `state: 'delivered'`

#### Scenario: Partial launch is visible
- **WHEN** 3 of 8 `M1` tickets are `in_progress` on rail `M1 · 1` and the other 5 are `todo`
- **THEN** the M1 progress reports `inProgress: 3`, `todo: 5`, `state: 'running'` and lists rail `M1 · 1` with its run id and start time

#### Scenario: Failed attempt is counted honestly
- **WHEN** a chunk run fails and its 3 tickets revert to `todo`
- **THEN** the M1 progress reports those tickets in both `todo` and `failed`, and no other ticket is counted as failed

### Requirement: Progress is broadcast on every relevant mutation
The server SHALL broadcast a project-scoped `blueprint.milestone_progress { projectId, progress }` WS message — debounced per project — after: a run/job outcome is applied to tickets, a manual ticket status change, every `rail.pr_state` transition, and every chain transition. Projects without a blueprint SHALL broadcast nothing. The message SHALL NOT be translated onto the mobile wire.

#### Scenario: Run settle updates every open surface
- **WHEN** a milestone chunk run settles and its tickets move to `on_review`
- **THEN** one `blueprint.milestone_progress` message with the updated counts reaches the project's clients without any client polling

#### Scenario: Non-blueprint project stays silent
- **WHEN** a ticket changes status on a project with no `blueprint.json`
- **THEN** no `blueprint.milestone_progress` message is broadcast

### Requirement: Milestone completion is persisted
When a milestone's derived state becomes `done` and its stored status is not `done`, the server SHALL write `status: 'done'` for that milestone through the blueprint pair writer (idempotent, never reverted automatically) and broadcast `blueprint.milestone_completed { projectId, milestoneId, n }`. Surfaces SHALL always render the DERIVED state, so a later manual `done → todo` move is reflected honestly while the blueprint record stays a record.

#### Scenario: Last merge completes the milestone
- **WHEN** the final `M1` delivery is merged and its tickets become `done`
- **THEN** `blueprint.json` records `m1.status = 'done'`, `blueprint.md` is re-rendered, and `blueprint.milestone_completed` is broadcast once

#### Scenario: Manual regression stays honest
- **WHEN** a user moves one `M1` ticket from `done` back to `todo` after completion
- **THEN** the progress reports `state: 'committed'` with `done: 7` while the stored status remains `done`

### Requirement: Premium milestone surfaces
The Blueprint sidebar flyout (board and mission sidebars) and the Builder done screen after a launch SHALL render each milestone from the live progress model: a segmented bar (done / in review / in progress / failed / pending, semantic tokens only), the counts as "{{delivered}} of {{total}} delivered · {{done}} done" style copy that never labels an undelivered or unmerged milestone "complete", one row per milestone rail with its state pill, elapsed time for a running rail, and a Review action opening the delivery's review packet (or the rail on the dashboard when the packet feature is off), plus the chain row when a chain exists. The flyout SHALL subscribe to the progress broadcast instead of fetching the board on open. All copy SHALL exist in the eight locales.

#### Scenario: Flyout reflects a settle while open
- **WHEN** the flyout is open and a chunk run settles
- **THEN** the M1 bar's in-progress segment becomes in-review and the rail row's state pill changes without reopening the flyout

#### Scenario: Review from the flyout
- **WHEN** the user activates Review on an `on_review` rail row
- **THEN** the review packet page for that delivery opens

#### Scenario: Copy never overstates
- **WHEN** all M1 tickets are `on_review`
- **THEN** the flyout reads the milestone as delivered / awaiting review, not complete or done
