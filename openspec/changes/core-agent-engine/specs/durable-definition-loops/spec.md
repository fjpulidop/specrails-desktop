## ADDED Requirements

### Requirement: Human pause continuation
Definition loops SHALL persist question, approval and gate pauses, resume through Core with a single writer, and allow cancellation without restarting a paused provider.

#### Scenario: Question answer
- **WHEN** the user answers a pending question
- **THEN** Desktop invokes retained Core resume and continues observing the same run

#### Scenario: Cancel pause
- **WHEN** a paused run is cancelled
- **THEN** Desktop acknowledges cancellation through retained Core control without resuming the paused provider

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

#### Scenario: Historical isolated allocation
- **WHEN** a v2 run lacks a complete settlement snapshot but its frozen context, manifest, delivery branch records and worktree ledger prove the original allocation
- **THEN** explicit recovery restores every repository leg atomically without granting new cleanup authority or changing frozen execution inputs

#### Scenario: Missing historical ownership proof
- **WHEN** the original initial SHA, never-commit exclusions, repository identity or continuation contract cannot be proven from durable records
- **THEN** recovery reports the missing proof and preserves the job, worktree and delivery instead of inferring ownership from the current checkout
