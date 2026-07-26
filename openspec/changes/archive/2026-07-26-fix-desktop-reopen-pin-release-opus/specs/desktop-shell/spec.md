## ADDED Requirements

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
