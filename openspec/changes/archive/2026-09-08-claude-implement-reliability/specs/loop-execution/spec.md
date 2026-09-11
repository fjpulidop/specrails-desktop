## ADDED Requirements

### Requirement: Managed Claude steps retain outstanding delegated work

An automatically settling Claude step SHALL NOT settle successfully while its current background-task state reports unfinished delegated work. The host SHALL retain the same process and session and request bounded continuation that waits for the outstanding work in the foreground, receives its output, and completes the step.

#### Scenario: Architect still running when parent replies
- **WHEN** an auto-settled implementation step receives a successful parent result while its architect remains in the background-task roster
- **THEN** the host SHALL continue the existing session with an explicit foreground-wait instruction
- **AND** the next loop node SHALL NOT start merely because the parent replied that it was waiting
- **AND** the continuation SHALL be visible in the job log

#### Scenario: Delegated work completes before settlement
- **WHEN** task completion events clear the outstanding task state before the auto-settlement decision executes
- **THEN** the host SHALL use the updated task state
- **AND** it SHALL NOT send an unnecessary background-wait continuation

#### Scenario: Background notification is not a requested turn result
- **WHEN** Claude emits a notification-only result for a background task
- **THEN** the host SHALL preserve the active requested turn
- **AND** the notification SHALL NOT cause an early successful step settlement or a duplicate usage settlement

### Requirement: Managed background continuation is bounded and interruptible

Background continuation SHALL retain the session's existing cancellation, timeout, idle, provider-limit, and usage-accounting behavior. The host SHALL enforce a finite continuation ceiling and SHALL report failure if it cannot obtain a completed step within that ceiling. It MUST NOT report success after exhausting recovery with unfinished work.

#### Scenario: Repeated deferral exhausts continuation
- **WHEN** Claude repeatedly returns while delegated work remains pending until the configured recovery ceiling is reached
- **THEN** the session SHALL stop with an explicit failure reason
- **AND** it SHALL NOT advance the loop as a successful implementation step

#### Scenario: Stop or provider failure wins over continuation
- **WHEN** Stop, cancellation, or a terminal provider failure occurs while managed continuation is pending or active
- **THEN** the existing termination path SHALL take precedence
- **AND** the host SHALL NOT send further continuation input
- **AND** recorded usage SHALL retain each accepted result exactly once
