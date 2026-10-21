## ADDED Requirements

### Requirement: Flow sessions have a pure, persisted lifecycle

The system SHALL model each Flow as a session in the project database with the states `active`, `paused`, `handed_off`, `delivered`, `discarded` and `needs-review`, and SHALL decide every transition with a pure state machine. A conversation SHALL have at most one `active` or `paused` Flow. Every Flow operation SHALL be idempotent by flow id.

#### Scenario: Starting a Flow

- **WHEN** a pinned mission starts a Flow with an idea on a Core that advertises `flowSessions` and `deriveChange`
- **THEN** the system SHALL create a placeholder spec, reserve an isolated worktree owned by the Flow and return the Flow in state `active`

#### Scenario: A second Flow in the same conversation

- **WHEN** a conversation that already has an active or paused Flow starts another one
- **THEN** the system SHALL reject it with `409 flow_already_open` and the existing flow id

#### Scenario: A failed start is compensated

- **WHEN** reserving the worktree or opening the session fails during a start
- **THEN** the system SHALL release what the Flow created, delete the placeholder spec and mark the Flow `discarded`

#### Scenario: Discard after a hand-off

- **WHEN** a handed-off Flow is discarded
- **THEN** the system SHALL refuse the transition

### Requirement: Flow is gated on Core capabilities

The system SHALL offer Flow only when Core agent sessions are usable and the selected Core advertises `flowSessions` and `deriveChange`, and SHALL start a Flow only when the session host supports `flowSessions` and has a driver for the mission's provider. Without them the system SHALL behave exactly as before.

#### Scenario: Core without flowSessions

- **WHEN** a Flow is started and the selected Core does not advertise `flowSessions`
- **THEN** the system SHALL answer `409 feature_unavailable` with the missing capabilities and SHALL NOT create a spec or worktree

### Requirement: Flow turns run in their own write-capable Core session

While a Flow is active, mission turns SHALL run in a Core session distinct from the mission's (`flow:<flowId>`), with the Flow worktree as working directory, `workspace-write` permissions, default tools, the mission's Specrails MCP and the Flow persona as system prompt. Flow turns SHALL NOT use a legacy transport and SHALL be recorded with surface `flow`.

#### Scenario: A turn in an active Flow

- **WHEN** the user sends a message in a conversation whose Flow is active
- **THEN** the turn SHALL open or resume `flow:<flowId>` with the worktree cwd and `workspace-write`, and the invocation SHALL be recorded with surface `flow`

#### Scenario: No Flow

- **WHEN** the conversation has no active Flow
- **THEN** the turn SHALL run exactly as a normal read-only mission turn

#### Scenario: Mid-turn input interrupts

- **WHEN** the user sends a message while a Flow turn is running
- **THEN** the system SHALL deliver it with `delivery: 'interrupt'` without calling `session.interrupt` first, continue with the correction's turn and record the usage of both turns once

### Requirement: The placeholder spec stays out of Jira

The placeholder spec SHALL have `source: 'flow'`, status `in_progress` and `metadata.flow` with conversation, flow, worktree, start time and state. No Jira issue SHALL be created for it while its Flow is `active` or `paused`.

#### Scenario: Promoting a spec in Flow

- **WHEN** a spec whose Flow is active is promoted or a create outbox operation runs for it
- **THEN** no Jira issue SHALL be created and the outbox operation SHALL be retried until the Flow settles

### Requirement: The hand-off transfers worktree ownership atomically

Handing off a Flow SHALL freeze the worktree HEAD, close the Flow session and launch the rail on the same worktree. The rail SHALL adopt the worktree only when its path, branch and HEAD equal the frozen Flow values; the rail worktree ledger row and the Flow's `handed_off` state SHALL commit in one transaction.

#### Scenario: HEAD mismatch

- **WHEN** the worktree HEAD differs from the frozen HEAD at launch
- **THEN** the launch SHALL fail with `409 flow_worktree_mismatch`, no ledger row SHALL exist and the Flow SHALL return to `paused`

#### Scenario: Launch rolled back after adoption

- **WHEN** the launch fails after the worktree was adopted
- **THEN** the ledger row SHALL be removed, the worktree SHALL NOT be deleted and the Flow SHALL return to `paused`

### Requirement: Restart reconciliation

At project startup the system SHALL pause active Flows, compensate starts interrupted before the worktree was recorded, roll back interrupted hand-offs to `paused`, and mark a Flow whose worktree disappeared `needs-review` without deleting anything.

#### Scenario: App restart during a Flow

- **WHEN** the app restarts while a Flow is active
- **THEN** the Flow SHALL be `paused` with its worktree and spec intact
