## ADDED Requirements

### Requirement: Implementation verification distinguishes baseline from delivery

The shared implementation verification command SHALL require evidence that the requested feature and its acceptance criteria are implemented, in addition to applicable project checks passing. It SHALL inspect the actual source and active spec or OpenSpec artifacts across every selected repository, detect the repository's tooling, and run required verification commands in the foreground before producing its final verdict.

#### Scenario: Clean baseline without requested implementation
- **WHEN** all baseline tests, lint, type-check, or build commands pass but the requested feature is absent
- **THEN** verification SHALL report `VERIFICATION: FAIL` with the missing implementation reason
- **AND** the loop goal SHALL remain unsatisfied

#### Scenario: One repository still lacks required behavior
- **WHEN** a shared spec requires Front and Back changes and either repository or their shared contract remains incomplete
- **THEN** verification SHALL report FAIL even if the other repository's checks pass

#### Scenario: Requested feature already exists
- **WHEN** the requested feature is already fully implemented and its acceptance criteria and required checks are verified
- **THEN** verification SHALL be permitted to report PASS on that evidence
- **AND** it SHALL NOT require an artificial code diff solely to prove work occurred

### Requirement: Refinement repairs the gap identified by verification

The shared refinement command SHALL distinguish missing or incomplete implementation from failing checks, regardless of the previous verdict's label. It SHALL authorize completing the missing parts of the same requested spec, including required pipeline or OpenSpec phases, preserve valid existing work, and require a subsequent verification pass. It SHALL reserve `LOOP_BLOCKED` for a specific unresolved decision requiring human input.

#### Scenario: FAIL reports no implementation despite green checks
- **WHEN** verification reports FAIL because no requested implementation exists although all baseline checks pass
- **THEN** refinement SHALL continue implementing the missing requested feature
- **AND** it SHALL NOT restrict its work to already-failing test or build commands

#### Scenario: Existing implementation fails a project gate
- **WHEN** verification identifies a concrete failed check in an otherwise existing implementation
- **THEN** refinement SHALL repair that failure with changes scoped to the spec
- **AND** verification SHALL run again on the repaired candidate

#### Scenario: Decider evaluates evidence rather than assuming PASS
- **WHEN** a factory or OpenSpec lifecycle decider evaluates a candidate
- **THEN** its goal SHALL require the latest applicable verification to report PASS and required implementation scope to be complete
- **AND** its goal text SHALL NOT assert that verification already passed
