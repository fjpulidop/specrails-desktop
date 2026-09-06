## ADDED Requirements

### Requirement: Mission execution logs survive disconnection and restart
The server SHALL persist owned execution metadata and bounded sequence-tagged stdout/stderr, including partial lines, and SHALL make retained logs available by execution identity after client reconnection or server restart.

#### Scenario: Inspect a failed execution after restart
- **WHEN** an application fails, its final output is flushed and Specrails restarts
- **THEN** the mission history SHALL retain its command, repository, final outcome and logs
- **AND** the user and mission MCP SHALL be able to inspect that execution without its original chip.

#### Scenario: Recover interrupted supervision
- **WHEN** startup finds persisted nonterminal executions from a previous server lifetime
- **THEN** those executions SHALL become disconnected historical records with an explicit unknown OS state
- **AND** they SHALL NOT be adopted or signalled using their old PIDs.

### Requirement: Durable output is bounded and failures are observable
Output SHALL be persisted in bounded batches with finite line, execution, age and total-text limits. Finalization and graceful shutdown SHALL flush pending output. Storage failures and truncation SHALL be observable without disabling process termination.

#### Scenario: Noisy output and partial lines
- **WHEN** output exceeds retention limits or updates a partial line
- **THEN** the store SHALL trim according to documented bounds and update the existing line sequence
- **AND** reads SHALL indicate missing retained output.

#### Scenario: Storage fails while running
- **WHEN** a disk write fails during execution
- **THEN** the application SHALL expose the persistence failure separately from process exit
- **AND** the user SHALL still be able to stop the owned process.

### Requirement: History remains discoverable in the mission
The mission composer SHALL provide access to scoped process history after completed chips expire. The history SHALL support finding an execution and opening its logs with localized status and recovery information.

#### Scenario: Return to an earlier failure
- **WHEN** the user reloads the mission after its failed-process chip expires
- **THEN** the history SHALL still list the retained execution
- **AND** selecting it SHALL open its inspector without affecting another process.
