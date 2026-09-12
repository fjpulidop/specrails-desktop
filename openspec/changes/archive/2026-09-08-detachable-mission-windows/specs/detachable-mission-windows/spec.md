## ADDED Requirements

### Requirement: Missions can move to independent application windows
Existing conversations SHALL be integrated by default. Mission and board surfaces SHALL expose an action beside their conversation controls to detach a mission into a native Specrails window. Each conversation SHALL have at most one editable owner.

#### Scenario: A mission is detached while its agent works
- **WHEN** the user detaches an executing mission
- **THEN** an independent Specrails window displays that same conversation and current execution
- **AND** no additional provider invocation or backend is created
- **AND** selecting the detached mission in the main interface focuses its existing window

### Requirement: Reintegration preserves work and execution
The reintegrate action and the native close button SHALL restore the mission in the main application without stopping its agent. The secondary SHALL close only after the destination acknowledges the current transfer revision and restored state.

#### Scenario: User closes a detached mission
- **WHEN** the user clicks its close button
- **THEN** the main application restores the mission, its unsent text, inline references, attachments and view state
- **AND** its running agent continues
- **AND** the secondary closes after restoration acknowledgement

#### Scenario: Destination does not finish loading
- **WHEN** a detach or reattach destination fails or does not acknowledge in time
- **THEN** the source retains recoverable unsent work and remains usable
- **AND** the user sees an actionable failure and can retry
- **AND** stale acknowledgements cannot close or overwrite a newer owner

### Requirement: Mission windows behave as native independent windows
Each mission window SHALL support minimizing, maximizing/restoring, resizing and placement on another monitor on macOS and Windows. Minimizing the main window SHALL NOT minimize independent missions. Multiple different missions SHALL operate concurrently without changing each other's project scope.

#### Scenario: Main application is minimized
- **WHEN** the main application is minimized while a mission is detached
- **THEN** that mission window remains independently available with its original project and repository context

### Requirement: Native capability availability is truthful
The integrated browser-development application SHALL remain functional when native window commands are unavailable and SHALL NOT expose a nonfunctional detach action.

#### Scenario: Specrails is opened in a normal web browser
- **WHEN** the native host is absent
- **THEN** conversations continue working in integrated mission and board views
