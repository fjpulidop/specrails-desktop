## MODIFIED Requirements

### Requirement: Background process chips SHALL expose elapsed time and immediate kill

Each background process chip MUST show a close control and an elapsed-time tooltip on hover. Closing SHALL request immediate termination without another confirmation and retain a truthful stopping or error state until the owned application has stopped.

#### Scenario: Hovering a running chip
- **WHEN** the user hovers over a background process chip
- **THEN** the close control and an elapsed-time tooltip SHALL be available with localized labels.

#### Scenario: Killing from the chip
- **WHEN** the user clicks the close control
- **THEN** the server SHALL signal the owned process group or tree immediately and escalate after a bounded grace period
- **AND** the chip SHALL remain stopping until termination is confirmed, or show a retryable error if termination fails.

### Requirement: Background process lifecycle SHALL prevent orphaned children

The server MUST terminate its owned background application processes when the user stops them, their shell exits leaving children, their project closes or the app shuts down. Parent shell exit alone MUST NOT cancel descendant cleanup or establish successful termination.

#### Scenario: Process exits by itself
- **WHEN** a background process exits or fails without user action
- **THEN** the server SHALL clean up remaining owned descendants, broadcast the confirmed terminal status and retain logs for inspection.

#### Scenario: Project or app closes
- **WHEN** a project is removed or Specrails Desktop shuts down
- **THEN** all active background applications for that project SHALL be stopped and shutdown SHALL allow a bounded drain for escalation to complete.

#### Scenario: Descendant ignores graceful termination
- **WHEN** the shell exits but an owned child ignores SIGTERM
- **THEN** escalation SHALL still stop that child and SHALL NOT target unrelated processes.

## ADDED Requirements

### Requirement: Execution identity and recovery remain consistent
Each process SHALL have a stable execution identity distinct from PID. HTTP and WebSocket lifecycle updates SHALL reconcile across reconnects without resurrecting completed processes or confusing a reused PID.

#### Scenario: Delayed hydration after stop
- **WHEN** an old running snapshot arrives after a confirmed terminal event
- **THEN** the completed execution SHALL remain terminal.

#### Scenario: Stop request fails
- **WHEN** the stop request is rejected or the connection fails
- **THEN** the client SHALL show the failure and permit a retry without falsely removing the process.
