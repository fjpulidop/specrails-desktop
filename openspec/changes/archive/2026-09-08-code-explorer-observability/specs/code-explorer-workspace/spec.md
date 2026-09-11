## ADDED Requirements

### Requirement: Repository-aware exploration workspace
The explorer SHALL provide Files, Search and Activity navigation in full-page and compact mission views, preserving selected repository, file and line identity.

#### Scenario: Search across a project
- **WHEN** a user searches filenames or literal content in all repositories
- **THEN** results MUST show repository identity and open the matching repository/file/line
- **AND** incomplete scans and request failures MUST be visible

#### Scenario: Navigating and returning
- **WHEN** a user opens files and returns using navigation history
- **THEN** the repository and file selection MUST match the displayed source
- **AND** narrow mission panels MUST offer usable navigation and reader space

### Requirement: Recorded activity is distinguishable from source
The explorer SHALL provide bounded recorded activity with repository, run, spec, path and change-kind context, and inspectable stored patches.

#### Scenario: Unintegrated or deleted file
- **WHEN** a recorded change refers to a path absent from the registered checkout
- **THEN** its stored patch MUST remain inspectable if available
- **AND** the UI MUST identify it as recorded evidence rather than current file contents

#### Scenario: Missing or partial patch
- **WHEN** a stored patch is unavailable or truncated
- **THEN** the UI MUST explain the limitation without fabricating missing content
