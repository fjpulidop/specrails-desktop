## ADDED Requirements

### Requirement: Human pause continuation
Definition loops SHALL persist question, approval and gate pauses, resume through Core with a single writer, and allow cancellation without restarting a paused provider.

#### Scenario: Question answer
- **WHEN** the user answers a pending question
- **THEN** Desktop invokes retained Core resume and continues observing the same run

#### Scenario: Cancel pause
- **WHEN** a paused run is cancelled
- **THEN** Desktop settles cancellation without launching Core

### Requirement: Fork preserves original
Repeating from a completed node SHALL create a linked new run and preserve the original checkpoints and accounting.

#### Scenario: Nested fork
- **WHEN** the selected node is inside implementation
- **THEN** Core forks from the internal checkpoint and Desktop links both runs

### Requirement: Restart recovery and settlement
Desktop SHALL append durable request metadata and reconstruct resumable v2 runs after restart without losing jobs, tickets or isolated delivery ownership.

#### Scenario: Interrupted write
- **WHEN** Desktop restarts after a writing attempt was interrupted
- **THEN** the run becomes paused and requires explicit recovery before continuation

#### Scenario: Settlement replay
- **WHEN** a recovered run finishes and its outbox replays
- **THEN** delivery and accounting are applied exactly once
