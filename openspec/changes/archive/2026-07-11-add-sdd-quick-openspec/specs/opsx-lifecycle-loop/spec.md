## ADDED Requirements

### Requirement: SDD Quick Built-In Lifecycle
The OpenSpec lifecycle graph SHALL be usable as the backing graph for the built-in `SDD Quick (OpenSpec)` strategy. The graph SHALL fast-forward or amend OpenSpec artifacts, apply implementation tasks, verify against OpenSpec, and archive only after verification passes.

#### Scenario: SDD Quick runs lifecycle steps
- **WHEN** `SDD Quick (OpenSpec)` launches for a ticket
- **THEN** the loop SHALL execute OpenSpec fast-forward or continuation, apply, and verify steps in lifecycle order
- **AND** it SHALL use the local ticket as the user intent wrapper

#### Scenario: Archive follows verification pass
- **WHEN** the verify step reports PASS and a change id has been captured
- **THEN** the loop SHALL archive the captured OpenSpec change
- **AND** it SHALL NOT archive an unknown or missing change id

### Requirement: Existing Change Targeting
The lifecycle graph used by `SDD Quick (OpenSpec)` SHALL support targeting an existing OpenSpec change from structured local ticket data. When no existing change target is present, the graph MAY create a new OpenSpec change from the ticket.

#### Scenario: Existing change is continued
- **WHEN** the local ticket contains a structured OpenSpec change name
- **THEN** the first OpenSpec step SHALL instruct the agent to continue that change
- **AND** it SHALL NOT create a duplicate change for the same follow-up

#### Scenario: New change is created when target absent
- **WHEN** the local ticket does not contain a structured OpenSpec change name
- **THEN** the first OpenSpec step MAY create a new OpenSpec change from the ticket's title and description

### Requirement: Contract Drift Prevention
The lifecycle graph used by `SDD Quick (OpenSpec)` SHALL instruct the agent that OpenSpec artifacts are authoritative and that implementation must not silently diverge from them.

#### Scenario: Artifact amendment precedes contract-changing code
- **WHEN** implementation requires a contract change
- **THEN** the OpenSpec fast-forward or continuation step SHALL amend the relevant artifacts before code is changed

#### Scenario: Verification catches drift
- **WHEN** implementation diverges from the active OpenSpec artifacts
- **THEN** the verify step SHALL report FAIL
- **AND** the loop SHALL continue instead of archiving the change
