# cross-platform-runtime-regression-checks Specification

## Purpose
TBD - created by archiving change fix-cross-platform-pr-ci. Update Purpose after archive.
## Requirements
### Requirement: Verification fixtures preserve complete failure evidence across platforms

Regression checks SHALL emit their complete synthetic output with a failing exit status on supported operating systems and SHALL retain assertions for early failures, totals, application locations, expected values and bounded summaries.

#### Scenario: Large failure logs
- **WHEN** verification diagnostics are tested with output larger than pipe or command-line limits
- **THEN** the fixture emits all output through a portable subprocess without weakening evidence assertions

### Requirement: Desktop tests exercise compatible Core and authoritative launch context

Desktop CI SHALL pair against an immutable Core revision containing the behavior its regression tests require. Launch and delta-scope fixtures SHALL model admitted repository and delivery scope, retaining rejection checks.

#### Scenario: Paired workflow regression
- **WHEN** the paired CI executes configurable Implement, correction and review flows
- **THEN** it exercises the corrected Core revision and verifies failure, repair and no-progress outcomes

#### Scenario: Addenda on undelivered and delivered work
- **WHEN** a launch contains addenda
- **THEN** tests distinguish a full-spec fresh implementation from a delta against delivered work
