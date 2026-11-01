## ADDED Requirements

### Requirement: Specs authored from an intent derive from it
When an AI author writes a detailed spec from an intent, the spec SHALL derive from that intent. This applies to the Add Spec Intent mode, the operator agent after an answered `intent-draft`, and the Intent settlement rewrite.

- The `Problem Statement` SHALL restate the intent's problem and outcome.
- `Out of Scope` and `Technical Considerations` SHALL honour every constraint.
- At least one acceptance criterion SHALL check each success signal.
- The spec SHALL NOT contradict the intent.

The shared premium spec contract SHALL carry this rule once, and every author SHALL use it. The deterministic quality floors SHALL apply unchanged.

#### Scenario: Success signals become criteria
- **WHEN** an intent lists the success signal "a new user finishes setup in under 2 minutes"
- **THEN** the derived spec SHALL have an acceptance criterion that verifies it

#### Scenario: Constraints are honoured
- **WHEN** the intent states the constraint "no new runtime dependency"
- **THEN** the spec's Proposed Solution SHALL NOT introduce one, and Technical Considerations SHALL mention the constraint
