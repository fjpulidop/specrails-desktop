## MODIFIED Requirements

### Requirement: App shutdown stops the server
The Tauri shell SHALL keep the `specrails-server` sidecar running when the main window is closed (the window is hidden to the tray) and SHALL terminate the sidecar only when the user chooses Exit from the tray or the OS truly quits the app.

#### Scenario: User closes the window
- **WHEN** the user closes the app window (✕)
- **THEN** the Tauri shell prevents the close and hides the window to the tray
- **AND** the `specrails-server` sidecar process keeps running and remains reachable on port 4200

#### Scenario: User exits from the tray
- **WHEN** the user chooses Exit from the tray menu (or the OS truly quits the app)
- **THEN** the Tauri shell sends SIGTERM to the sidecar process (Unix) or POST `/shutdown` (Windows)
- **AND** waits up to 5 seconds for graceful exit
- **AND** sends SIGKILL / terminates forcefully if the process has not exited
