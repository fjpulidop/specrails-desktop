## ADDED Requirements

### Requirement: Evidence-gated stages
Each block SHALL retain its tests and required checks. Core/desktop release pairing, C1 platform evidence and later telemetry gates MUST be recorded separately from local implementation.

#### Scenario: Local spike success
- **WHEN** macOS tests pass but Windows/Linux evidence is absent
- **THEN** C1 remains pending and C3 cannot be certified ready

#### Scenario: Paired PR
- **WHEN** D0 is implemented against the C0 branch before Core publication
- **THEN** the release compatibility gate remains pending

### Requirement: Legacy retirement gate
The legacy runner SHALL remain until all stored/factory graphs pass migration parity and two releases record zero legacy launches; legacy runs SHALL retain their original runtime packages.

#### Scenario: Insufficient telemetry
- **WHEN** only one release reports zero legacy launches
- **THEN** D8 and C10 remain deferred

### Requirement: Accurate shared documentation
Core, Desktop and Web documentation SHALL be updated to match validated implementation. Every source-plan discrepancy and design decision SHALL be recorded in the tracked plan.

#### Scenario: Version drift
- **WHEN** current workflow identity differs from the supplied plan
- **THEN** the contract and plan are corrected while the current identity remains intact
