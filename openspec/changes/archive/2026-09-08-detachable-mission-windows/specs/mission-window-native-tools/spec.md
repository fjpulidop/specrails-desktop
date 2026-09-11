## ADDED Requirements

### Requirement: Trusted mission windows can use native workspace tools
Registered mission application webviews SHALL have the native permissions needed for their workspace. External browser content and authentication popups SHALL remain unable to invoke privileged app commands. Commands SHALL validate the calling window's ownership.

#### Scenario: A remote browser page attempts host IPC
- **WHEN** a browser child or popup attempts a privileged app command
- **THEN** the host rejects it even when it belongs to a trusted mission window

### Requirement: Native browsers are owned by their application window
Opening a browser in a detached mission SHALL place it in that mission window, route events to that window and preserve the independent browser of another application window. Popups SHALL retain their session and opener relationship and SHALL release their resources on close.

#### Scenario: Two missions browse at the same time
- **WHEN** each detached mission opens its native browser
- **THEN** each browser and its captures belong to the requesting window and conversation
- **AND** closing one mission's browser or popup does not close the other

### Requirement: Window close policies distinguish mission and browser lifecycle
The host SHALL distinguish main-window hide-to-tray, mission reintegration and real popup closure. True application quit SHALL retain the existing global backend shutdown behavior.

#### Scenario: Authentication popup closes
- **WHEN** a popup closes itself or the user closes it
- **THEN** its native window is destroyed and its ownership slot is released
- **AND** its parent mission remains open
