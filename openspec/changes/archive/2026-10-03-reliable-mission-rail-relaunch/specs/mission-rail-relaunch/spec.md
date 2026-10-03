## ADDED Requirements

### Requirement: Relaunch identifies the original attempt
The system SHALL resolve Relaunch from the card's source delivery or shared run in its project, preserving recorded workflow and launch options and the original spec set.

#### Scenario: Assignments released after failure
- **WHEN** a failed attempt's rail has no remaining assignments and Relaunch is selected
- **THEN** the system restores and launches its original specs with its recorded workflow

#### Scenario: Rail reused for other specs
- **WHEN** the source rail now holds a different spec set
- **THEN** relaunch is rejected without changing the rail or starting work

#### Scenario: Historical workflow unavailable
- **WHEN** an old attempt has no recorded workflow identity
- **THEN** the system returns an actionable error instead of silently choosing Implement

#### Scenario: Independent per-ticket siblings
- **WHEN** a shared rail produced independent runs for different specs and their assignments have been released
- **THEN** a later sibling does not invalidate Relaunch of the earlier spec, while a newer run covering that same spec does invalidate it

### Requirement: Retry preserves generation and recovery ownership
The system SHALL replace only an identified active undelivered failed generation through atomic supersession, retaining the failed checkout and restoring the predecessor when allocation fails.

#### Scenario: Failed delivery blocks ordinary launches
- **WHEN** Relaunch targets the active undelivered failed delivery
- **THEN** the failed row does not block its own retry with pr_decision_pending and the new attempt uses a fresh isolated checkout

#### Scenario: Stale card or delivered work
- **WHEN** the source has been superseded, is active, has a pending operation, or has delivered work requiring recovery
- **THEN** relaunch is rejected without superseding or discarding the work

#### Scenario: Failed batch with an unchanged sibling
- **WHEN** a failed batch includes a successful unit explicitly reporting no changes
- **THEN** that unchanged unit does not count as delivered work blocking a fresh retry

### Requirement: Relaunch reports admission state
The card SHALL prevent duplicate submissions while pending and after acceptance, and SHALL retain actionable rejection text inline while permitting a corrected retry.

#### Scenario: Double click
- **WHEN** Relaunch is clicked repeatedly before its request settles
- **THEN** only one request is submitted

#### Scenario: Admission rejected
- **WHEN** the server rejects Relaunch
- **THEN** its detail and corrective action remain visible on the card and the button becomes available again
