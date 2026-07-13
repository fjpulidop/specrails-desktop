# implementation-delivery-lifecycle (delta)

## ADDED Requirements

### Requirement: Explicit designation is an authoritative continuation source

Explicit user designation of a target PR SHALL be a sanctioned continuation source ranked above ledger history and gated inference: it is the user's answer, not a discovery guess, so the prohibition on fuzzy external-PR inference SHALL continue to govern only the automatic discovery path. A delivery generation created from an explicit designation SHALL be born attached — `pr_url`/`pr_number` recorded at insert, `isContinuation` set, and every unit's branch ownership recorded as `borrowed-pr` — so all existing borrowed-PR lifecycle, snapshot-convergence, and cleanup rules apply unchanged.

#### Scenario: Explicitly targeted delivery renders as attached from birth

- **WHEN** a launch with a valid explicit target inserts its delivery generation
- **THEN** both decision surfaces SHALL render the attached-PR presentation (existing PR identity, push-oriented actions) from the `building` state onward
- **AND** settle SHALL push to the designated PR's head branch rather than creating a new PR

#### Scenario: Discard preserves the explicitly designated PR

- **WHEN** the user discards a delivery whose target was explicitly designated
- **THEN** the designated PR and its head branch SHALL remain intact under the existing borrowed-PR ownership rules
- **AND** only Specrails-owned resources of that generation MAY be removed

#### Scenario: Explicit designation does not relax automatic inference

- **WHEN** a launch carries no explicit target
- **THEN** automatic continuation discovery SHALL keep its existing status gates and exact-match rules, unchanged by this capability
