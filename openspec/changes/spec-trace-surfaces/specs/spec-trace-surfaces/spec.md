## ADDED Requirements

### Requirement: The packet shows requirements demonstrated

When the active Core announces `specTrace: 1`, the settle harvest SHALL read each unit's `spec-trace.json` and the review packet SHALL show **Requirements demonstrated X/Y**, listing undemonstrated requirements (those the change touches first), demonstrated ones with a tagged test, and tags that match no requirement. Without the capability the settle evidence SHALL be unchanged and the section absent.

#### Scenario: Two of three
- **WHEN** a unit's trace reports two demonstrated requirements out of three
- **THEN** the packet reads "Requirements demonstrated 2/3" and lists the missing requirement

#### Scenario: Older Core
- **WHEN** Core does not announce `specTrace`
- **THEN** the settle evidence has no `specTrace` and the packet has no section

### Requirement: Loop economics aggregates demonstrated requirements

Loop economics SHALL report `requirementsDemonstrated { demonstrated, total, deliveries }` per loop from the spec traces of delivered deliveries, and `null` when none carries a trace.

#### Scenario: Two traced deliveries
- **WHEN** two delivered deliveries of a loop demonstrate 3 of 4 and 0 of 2 requirements
- **THEN** the loop shows 3/6 and the source is `measured`

### Requirement: Teams can gate CI on touched requirements

The OpenSpec workflow guide SHALL document an npm script that runs `specrails-core pipeline trace --check --tests-passed` after the test suite.

#### Scenario: CI snippet
- **WHEN** a developer reads the OpenSpec workflow guide
- **THEN** it shows the `spec:check` script and the CI step order

### Requirement: Drift sweep loop template

With `specTrace: 1` and workflow definitions, the loop library SHALL list a read-only **Drift sweep** template that compares every capability's spec with the code and reports contradictions without changing anything.

#### Scenario: Capability present
- **WHEN** Core announces `specTrace: 1`
- **THEN** the library lists Drift sweep as a read-only template whose single step has read access
