## ADDED Requirements

### Requirement: SDD Quick OpenSpec Strategy
The system SHALL provide a quick implementation strategy named `SDD Quick (OpenSpec)` for small changes where OpenSpec artifacts are the authoritative contract. The strategy SHALL run through Specrails rails and loop execution, not through direct code editing.

#### Scenario: Strategy is available for OpenSpec-governed work
- **WHEN** the operator identifies a small requested change that depends on or amends OpenSpec artifacts
- **THEN** the operator SHALL be able to recommend `SDD Quick (OpenSpec)` as the launch strategy
- **AND** the recommendation SHALL NOT require the full `implement` pipeline when the change is small and OpenSpec-scoped

#### Scenario: Active PR OpenSpec context is considered
- **WHEN** the user asks for a follow-up on an `on_review` ticket or active PR
- **THEN** the operator SHALL inspect the PR branch, changed files, or diff before classifying the relaunch strategy
- **AND** OpenSpec artifacts introduced or modified by that PR SHALL count as relevant governing context for deciding whether `SDD Quick (OpenSpec)` applies
- **AND** the operator SHALL NOT decide solely from the `main` branch when the follow-up targets an active PR

#### Scenario: Strategy uses rail execution
- **WHEN** `SDD Quick (OpenSpec)` is launched
- **THEN** the work SHALL execute through the existing rail loop launch machinery
- **AND** it SHALL be tracked as a rail job or loop run with normal worktree, status, logging, and PR-decision behavior

#### Scenario: Tiny changes still use Specrails execution
- **WHEN** the user asks for a small code change that appears to be one or two direct edits
- **THEN** the operator SHALL NOT offer direct code editing as the implementation path
- **AND** the operator SHALL update or create a local ticket, classify the work, and propose the lightest valid rail strategy

### Requirement: Local Ticket Wrapper
Before launching `SDD Quick (OpenSpec)`, the system SHALL require a local Specrails ticket that captures the requested change and links it to the relevant OpenSpec change when one is known.

#### Scenario: Existing ticket is updated
- **WHEN** the user requests a follow-up for an existing ticket
- **THEN** the operator SHALL update the local ticket with the follow-up before launch
- **AND** the updated ticket SHALL describe the implementation intent that the rail will execute

#### Scenario: Existing OpenSpec change is linked
- **WHEN** the requested work targets an existing OpenSpec change
- **THEN** the local ticket SHALL carry a structured reference to that change
- **AND** the launch prompt SHALL be able to resolve that reference without relying only on free-form ticket prose

### Requirement: OpenSpec Contract Authority
`SDD Quick (OpenSpec)` SHALL treat OpenSpec artifacts as stronger contracts than the local ticket. Code changes that alter OpenSpec requirements, acceptance criteria, design decisions, APIs, states, data models, or invariants MUST first amend the relevant OpenSpec artifacts.

#### Scenario: Contract change is required
- **WHEN** the requested implementation requires changing an OpenSpec requirement, design decision, acceptance criterion, API, state, data model, or invariant
- **THEN** `SDD Quick (OpenSpec)` SHALL amend or create the relevant OpenSpec artifacts before applying code changes
- **AND** verification SHALL evaluate the implementation against the amended artifacts

#### Scenario: Implementation-only change is allowed
- **WHEN** the requested work only implements behavior already described by OpenSpec artifacts
- **THEN** `SDD Quick (OpenSpec)` MAY apply the implementation without changing those artifacts
- **AND** verification SHALL still check the implementation against the existing OpenSpec artifacts

### Requirement: Freestyle Guardrail
The operator SHALL NOT recommend Freestyle for work that may modify OpenSpec contracts unless it explicitly classifies the work as implementation-only within existing OpenSpec artifacts.

#### Scenario: OpenSpec contract risk blocks Freestyle
- **WHEN** a requested small change touches behavior governed by OpenSpec and may require contract changes
- **THEN** the operator SHALL recommend `SDD Quick (OpenSpec)` instead of Freestyle

#### Scenario: Implementation-only work may use Freestyle
- **WHEN** a requested small change is local to implementation and does not alter OpenSpec contracts
- **THEN** the operator MAY recommend Freestyle
- **AND** the recommendation SHALL state that the change is implementation-only

### Requirement: User Confirmation
The operator SHALL present the selected ticket, OpenSpec target, launch strategy, provider, and cost/time framing before launching `SDD Quick (OpenSpec)`.

#### Scenario: Launch is proposed before execution
- **WHEN** the operator is ready to run `SDD Quick (OpenSpec)`
- **THEN** it SHALL ask for explicit confirmation before calling an ai-spawn action
- **AND** it SHALL include the local ticket and OpenSpec target in the proposal

#### Scenario: Launch proceeds after confirmation
- **WHEN** the user confirms the proposed `SDD Quick (OpenSpec)` launch
- **THEN** the operator SHALL assign the ticket to a rail and launch the SDD Quick built-in loop
