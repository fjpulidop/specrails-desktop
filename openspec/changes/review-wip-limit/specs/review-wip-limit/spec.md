## ADDED Requirements

### Requirement: Project review WIP limit setting

Each project SHALL have a `reviewWipLimit` setting that is either an integer from 1 to 100 or `null`. `null` means no limit and SHALL be the default. Invalid values SHALL be rejected with HTTP 400 and SHALL NOT change the stored setting. The settings UI SHALL suggest 5 and explain what counts toward the limit.

#### Scenario: Default
- **WHEN** a project has never set the limit
- **THEN** `GET /settings` returns `reviewWipLimit: null` and no launch is limited

#### Scenario: Invalid value
- **WHEN** `PATCH /settings` sends `reviewWipLimit` as 0, a fraction, a value above 100 or a non-number
- **THEN** the response is 400 and the previous value is kept

### Requirement: Pending review count

The system SHALL count, per project, the top-level deliveries whose decision is `building`, `on_review`, `pr_draft` or `pr_ready`. Per-repository child rows, `no_changes`, `implementation_failed`, `pr_failed`, `pr_closed` and terminal decisions SHALL NOT count.

#### Scenario: Mixed decisions
- **WHEN** a project has deliveries in every decision state
- **THEN** only the top-level `building`, `on_review`, `pr_draft` and `pr_ready` rows count, oldest first

### Requirement: Launch doors honor the review WIP limit

When a limit is set and the pending count plus in-flight admitted launches is at or above it, every rail launch that would open a new delivery SHALL be refused before anything is spawned. The refusal SHALL be HTTP 409 with body `{ error: 'review_wip_limit_reached', limit, pending: [{ deliveryId, railIndex, ticketIds, since }], detail, action }`. This covers dashboard Play, Launch all, mission cards, Relaunch, MCP `launch`/`launch_all`, mobile and milestone chains. Continuations of an existing delivery SHALL be admitted: a revision, a Relaunch of a recorded delivery, an explicit target PR or PR follow-up, or any launch on a rail that still owns an active delivery.

#### Scenario: Limit reached
- **WHEN** the limit is 2 and two deliveries are undecided
- **THEN** Play, Launch all, MCP and mobile launches of new work are refused with `review_wip_limit_reached` and nothing is spawned

#### Scenario: A decision frees a slot
- **WHEN** one of those deliveries is decided (discarded, merged or closed)
- **THEN** the next launch is admitted

#### Scenario: Continuation at the limit
- **WHEN** the limit is reached and the user requests a change to an undecided delivery, or relaunches a recorded delivery
- **THEN** the launch is admitted

#### Scenario: Parallel launches
- **WHEN** several launches are admitted concurrently with one slot left
- **THEN** exactly one is admitted and the others are refused, because an admitted launch holds its slot until it has answered

### Requirement: Review WIP surfaces

The board header SHALL show an "In review N/L" badge when a limit is set, and the badge SHALL list the pending deliveries when clicked. At the limit, the Play button of each rail that would open a new delivery SHALL be disabled, with a tooltip that explains why. Launch all SHALL start at most the remaining capacity in board order and SHALL say in its dialog how many rails are held back; at zero capacity it SHALL launch nothing. MCP `launch_all` SHALL report held rails as `review-wip-limit` skips. The mission operator SHALL explain the refusal to the user. All copy SHALL exist in every supported locale.

#### Scenario: Launch all at zero capacity
- **WHEN** the limit is reached and the user opens Launch all
- **THEN** the dialog explains the limit, its Launch button is disabled and no launch request is sent

#### Scenario: Launch all with partial capacity
- **WHEN** two slots remain and three rails are ready
- **THEN** the first two rails in board order launch and the dialog and summary report one rail held by the review limit
