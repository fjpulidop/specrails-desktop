# Spec Delta

## MODIFIED Requirements

### Requirement: Narration is a third altitude behind a toggle

The narrated view SHALL be offered within Log detail on the Job Detail page and modal as a mode toggle alongside raw log content, retaining the shipped Story|Log pattern and per-project persistence. Raw log content rendering SHALL remain unchanged inside its new panel. Glance-level surfaces SHALL be unaffected. Disabling narration SHALL remove only that mode toggle and SHALL NOT remove run-detail navigation.

#### Scenario: Toggle persists

- **WHEN** a user switches Log detail to narrated mode
- **THEN** subsequent job views in that project SHALL default to narrated mode within Log detail until switched back

#### Scenario: Raw logs untouched

- **WHEN** the narrated feature flag is disabled
- **THEN** Log detail SHALL render the existing raw log content without the narration mode toggle
- **AND** Failure reasons / Log navigation and the loop-only Execution graph / Log detail sub-sections SHALL remain available according to their visibility rules

#### Scenario: Graph remains evidence navigation

- **WHEN** a user selects Execution graph or activates a loop failure's open-logs remedy while narrated mode is remembered
- **THEN** the graph SHALL be shown without requiring the user to change the remembered Log detail narration mode
