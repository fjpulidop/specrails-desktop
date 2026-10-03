## ADDED Requirements

### Requirement: Visible live repository assignments
An undecided mission launch card SHALL display its launch repositories and each selected spec's saved repository scope from the pinned project. Historical specs without explicit scope SHALL show primary-only assignment. A stale proposal SHALL include current required targets before Play.

#### Scenario: Stale proposal excludes a required target
- **WHEN** a proposal names one repository but a live spec requires another
- **THEN** the card SHALL visibly include both in launch scope and submit that resolved selection

#### Scenario: Single repository project
- **WHEN** the project has one registered repository
- **THEN** the card SHALL still display that repository and saved spec assignments

### Requirement: Persisted spec scope editing
The card SHALL allow adding and removing valid project repositories from a spec with explicit Save and Cancel. It SHALL require at least one target, preserve context-folder restrictions, and block Play while a scope edit is open or saving.

#### Scenario: Save removes a no-longer-required repository
- **WHEN** a user saves a spec scope replacing an assigned repository
- **THEN** the card SHALL persist it through the pinned project's ticket route, show the stored result and update launch requirements while preserving additional launch targets

#### Scenario: Save fails or edit is cancelled
- **WHEN** a scope save fails or an edit is cancelled
- **THEN** the saved scope SHALL remain unchanged and no launch SHALL occur

### Requirement: Launch repository editing and validation
The card SHALL allow adding and removing launch targets, remove workspace entries for removed targets, and prevent launch when a required target is omitted or a selected repository is unavailable. Server admission SHALL retain authority.

#### Scenario: Required target manually removed
- **WHEN** the user removes a target still required by a selected spec
- **THEN** Play SHALL be blocked and the card SHALL name the missing target and offer in-card spec editing

#### Scenario: Optional target removed
- **WHEN** the user removes an extra launch repository
- **THEN** Play SHALL remain available and its workspace selections SHALL no longer be sent or frozen

#### Scenario: Repository context cannot load
- **WHEN** repository loading for the pinned project fails
- **THEN** the card SHALL block Play rather than launch with hidden or another project's scope
