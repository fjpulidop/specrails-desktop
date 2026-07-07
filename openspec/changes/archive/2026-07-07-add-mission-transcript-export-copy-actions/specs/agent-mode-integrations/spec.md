## ADDED Requirements

### Requirement: Agent Mode SHALL export the active mission transcript as plain text

The active Agent Mode mission title overflow menu MUST provide an action that downloads the currently loaded mission transcript as a `.txt` file.

#### Scenario: Export transcript from active mission menu
- **GIVEN** Agent Mode is showing an active mission with loaded messages
- **WHEN** the user opens the mission title overflow menu and chooses the transcript export action
- **THEN** the browser SHALL download a plain-text `.txt` file
- **AND** the filename SHALL be derived from a safe slug of the mission title or fall back to the mission id

#### Scenario: Exported transcript contains mission metadata and messages
- **GIVEN** the active mission has a title, id, pinned project metadata, and loaded messages
- **WHEN** the transcript text is generated
- **THEN** it SHALL include the mission title, mission id, project name and path when present, and export timestamp
- **AND** it SHALL include every currently loaded message in loaded chronological order
- **AND** each message SHALL include a readable role label, timestamp, and plain-text content while preserving multiline message content

#### Scenario: Export failure is localized and non-destructive
- **GIVEN** Agent Mode is showing an active mission
- **WHEN** the browser download setup fails
- **THEN** the app SHALL show a localized export failure toast
- **AND** the active mission and loaded messages SHALL remain unchanged

### Requirement: Agent Mode SHALL copy the active mission transcript to the clipboard

The active Agent Mode mission title overflow menu MUST provide an action that copies the currently loaded mission transcript to the clipboard.

#### Scenario: Copy transcript from active mission menu
- **GIVEN** Agent Mode is showing an active mission with loaded messages
- **WHEN** the user opens the mission title overflow menu and chooses the copy transcript action
- **THEN** the app SHALL write the full plain-text transcript to `navigator.clipboard`
- **AND** the copied transcript SHALL use the same content format as the exported `.txt` transcript

#### Scenario: Clipboard failure is localized and non-destructive
- **GIVEN** Agent Mode is showing an active mission
- **WHEN** writing the transcript to the clipboard fails
- **THEN** the app SHALL show a localized copy failure toast
- **AND** the active mission and loaded messages SHALL remain unchanged

### Requirement: Mission transcript actions SHALL preserve existing header actions

Adding transcript actions MUST NOT change the behavior of existing Agent Mode mission title menu actions.

#### Scenario: Existing mission menu actions continue to work
- **GIVEN** Agent Mode is showing an active mission
- **WHEN** the user uses rename, favorite, delete, copy mission name, copy mission id, copy project name, or copy project path from the mission title menu
- **THEN** each existing action SHALL keep its previous behavior
