# desktop-shell Specification

## Purpose
Define the Tauri shell startup, shutdown, sidecar lifecycle, and development-mode behavior.
## Requirements
### Requirement: App launches and displays the dashboard
The Tauri shell SHALL start the server sidecar, wait for readiness, then load the WebView at `http://localhost:4200`. The window SHALL be frameless, sized 1280×820 (min 900×600), centered on first launch.

#### Scenario: Successful startup
- **WHEN** the user opens the Specrails app
- **THEN** the Tauri shell spawns the `specrails-server` sidecar process
- **AND** polls `GET http://localhost:4200/api/state` every 500ms
- **AND** navigates the WebView to `http://localhost:4200` once a 200 response is received

#### Scenario: Server does not become ready within timeout
- **WHEN** `GET http://localhost:4200/api/state` does not return 200 within 30 seconds
- **THEN** the Tauri shell shows a native error dialog: Specrails failed to start. Check that port 4200 is not in use."
- **AND** the app exits

### Requirement: Port conflict detected at startup
The Tauri shell SHALL check whether port 4200 is already bound before spawning the sidecar.

#### Scenario: Port 4200 is already in use
- **WHEN** the app starts and port 4200 is already bound by another process
- **THEN** the Tauri shell shows a native error dialog: "Port 4200 is already in use. Close the conflicting process and try again."
- **AND** the app exits without spawning the sidecar

### Requirement: App shutdown stops the server
The Tauri shell SHALL terminate the sidecar process when the app window is closed.

#### Scenario: User closes the window
- **WHEN** the user closes the app window
- **THEN** the Tauri shell sends SIGTERM to the sidecar process (Unix) or POST `/shutdown` (Windows)
- **AND** waits up to 5 seconds for graceful exit
- **AND** sends SIGKILL / terminates forcefully if the process has not exited

### Requirement: Sidecar watchdog terminates server on app crash
The server sidecar SHALL monitor the parent Tauri process PID and self-terminate if the parent is no longer running.

#### Scenario: Tauri shell process crashes
- **WHEN** the Tauri shell process terminates unexpectedly (crash, kill -9)
- **THEN** the sidecar detects the parent PID is gone within 5 seconds
- **AND** the sidecar terminates itself to avoid orphaned processes

### Requirement: Dev mode uses Vite dev server
In development, the Tauri shell SHALL load `http://localhost:4201` (Vite HMR) instead of `http://localhost:4200`.

#### Scenario: Running tauri dev
- **WHEN** `npm run dev:desktop` is executed
- **THEN** Tauri starts in dev mode loading `http://localhost:4201`
- **AND** the server sidecar is still spawned on port 4200 (or the developer may run it manually)
- **AND** hot module replacement works for React code changes

### Requirement: Hidden app is reopenable from the OS shell

Closing the main window hides the app to the system tray / menu bar instead of quitting it. The desktop shell SHALL therefore keep an OS-level reopen path on every platform, so a hidden instance is never unreachable without the tray menu.

On macOS the shell SHALL handle the application-reopen event (raised when the user clicks the Dock icon of the already-running app) by showing, unminimizing, and focusing the main window. On Windows a hidden window has no taskbar button, so the shell SHALL rely on its single-instance guard: launching the app again from the taskbar or Start menu SHALL focus the existing instance rather than spawn a second one, using the same show/unminimize/focus routine.

The reopen path SHALL NOT spawn a second sidecar, SHALL NOT contend for the server port, and SHALL leave sidecar termination exclusively to the tray "Exit" item and the true-quit hook.

#### Scenario: Dock click reopens the hidden window on macOS

- **WHEN** the user closes the window (the app hides to the menu bar) and then clicks the Dock icon
- **THEN** the shell SHALL show, unminimize, and focus the main window
- **AND** the running sidecar SHALL NOT be terminated or respawned

#### Scenario: Dock click with a visible window is a no-op

- **WHEN** the application-reopen event reports that visible windows already exist
- **THEN** the shell SHALL NOT alter window visibility or focus state

#### Scenario: Relaunching from the Windows taskbar focuses the hidden instance

- **WHEN** the app is hidden to the tray and the user launches it again from the taskbar or Start menu
- **THEN** the single-instance guard SHALL show, unminimize, and focus the existing window
- **AND** no second instance SHALL start a sidecar or bind the server port

