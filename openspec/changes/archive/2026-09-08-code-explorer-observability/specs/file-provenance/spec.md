## ADDED Requirements

### Requirement: Bounded repository-aware activity
The server SHALL expose bounded recorded activity with stable repository/run/spec/path identity and SHALL apply the same path exclusions to aggregate activity and provenance as to file reads.

#### Scenario: Spec touches two repositories
- **WHEN** a spec has recorded changes in two project memberships
- **THEN** its files listing MUST include both repositories without conflating identical relative paths

#### Scenario: Excluded path in stored provenance
- **WHEN** aggregate activity or provenance includes a path excluded by explorer policy
- **THEN** that path MUST NOT be exposed by the listing

#### Scenario: Large activity history
- **WHEN** recorded history exceeds a page limit
- **THEN** the endpoint MUST return bounded results and explicit continuation or truncation metadata
