## ADDED Requirements

### Requirement: System tray presence on macOS and Windows
The Tauri shell SHALL display a system-tray (Windows) / menu-bar (macOS) item while the app process is running, using the app icon, with a menu that opens/focuses the main window and exits the app.

#### Scenario: Tray item appears on launch
- **WHEN** the Specrails app starts on macOS or Windows
- **THEN** a tray/menu-bar item with the Specrails icon is shown
- **AND** its menu contains an "Open" item and an "Exit" item

#### Scenario: Open focuses the existing window
- **WHEN** the user activates the tray "Open" item
- **THEN** the main window is shown and focused
- **AND** no second window or second sidecar is created

### Requirement: Closing the window minimizes to tray and keeps the server alive
The Tauri shell SHALL intercept the window close request, hide the window instead of quitting, and leave the `specrails-server` sidecar running.

#### Scenario: User clicks the window close control
- **WHEN** the user clicks the window close (✕) control
- **THEN** the close is prevented and the main window is hidden
- **AND** the `specrails-server` sidecar process keeps running
- **AND** the tray item remains available to reopen the window

### Requirement: Quitting only from the tray Exit item
The Tauri shell SHALL terminate the sidecar and exit the app only when the user chooses Exit from the tray (or the OS truly quits the app).

#### Scenario: User chooses Exit from the tray
- **WHEN** the user activates the tray "Exit" item
- **THEN** the Tauri shell terminates the sidecar process (identity-gated SIGTERM→SIGKILL on Unix, taskkill on Windows)
- **AND** the app process exits

### Requirement: Single-instance enforcement
The Tauri shell SHALL run as a single instance; launching the app while an instance is already running SHALL focus the existing window rather than start a second process.

#### Scenario: Relaunch while running in the tray
- **WHEN** the app is running (window hidden in the tray) and the user launches it again
- **THEN** the existing instance's window is shown and focused
- **AND** no second instance or second sidecar is started, and port 4200 is not contended

### Requirement: macOS keeps the Dock presence
On macOS the app SHALL use the regular activation policy (Dock icon retained), not an accessory/menu-bar-only mode.

#### Scenario: App visible in the Dock
- **WHEN** the app is running on macOS, including when the window is hidden to the menu bar
- **THEN** the app icon remains in the Dock and clicking it shows the window

### Requirement: Tray menu labels are localized in all supported languages
The tray menu labels SHALL be rendered in the app's active UI language across all 8 supported languages (en, es, fr, de, pt, it, zh, ja), updated when the user changes the language.

#### Scenario: Active language drives the labels
- **WHEN** the app's active UI language is one of the 8 supported languages
- **THEN** every tray menu label (including "Open" and "Exit") is shown in that language

#### Scenario: Language change relabels the tray
- **WHEN** the user changes the UI language while the app is running
- **THEN** the tray menu labels are rebuilt in the newly selected language without restarting the app

#### Scenario: Labels before the client is ready
- **WHEN** the tray is built before the client has reported its active language
- **THEN** the menu shows English defaults and is relabeled once the client reports its language
