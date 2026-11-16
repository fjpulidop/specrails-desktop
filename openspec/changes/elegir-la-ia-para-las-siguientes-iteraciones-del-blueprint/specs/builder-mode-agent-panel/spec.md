# Spec Delta

## ADDED Requirements

### Requirement: Mission arrival preserves active Builder
An agent conversation created event SHALL refresh the mission list. While Builder mode is active, openOnArrival SHALL NOT automatically select that mission or exit Builder, preserving the post-create M1 controls. Automatic arrival selection outside Builder SHALL retain its existing window constraints.

#### Scenario: Placeholder mission arrives during Builder
- **WHEN** project creation announces a mission with openOnArrival while Builder is active
- **THEN** the mission appears in the refreshed list, Builder remains active, and the mission is not automatically loaded

#### Scenario: Explicit project exit
- **WHEN** the user activates Open project from the done screen
- **THEN** the existing explicit exit action remains available
