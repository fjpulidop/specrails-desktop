## ADDED Requirements

### Requirement: `@` references rails
The `@` trigger SHALL offer the pinned project's rails as structured chips carrying the rail index, name, specs and availability, serialized into the agent context block.

#### Scenario: Select a rail
- **WHEN** the user picks a rail from the `@` palette
- **THEN** a rail chip is inserted and the submitted turn includes the rail reference with its current specs and state
