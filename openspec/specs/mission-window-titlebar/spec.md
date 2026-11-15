# mission-window-titlebar Specification

## Purpose
Defines which controls the title bar of the native mission window shows, so it exposes only controls that apply to a window without sidebars while every other window keeps its current title bar.

## Requirements

### Requirement: Mission window hides sidebar toggles
The title bar of a native mission window SHALL NOT render the left or the right sidebar toggle button, on macOS and on Windows/Linux. The buttons SHALL be absent, not disabled.

#### Scenario: macOS mission window
- **WHEN** the title bar renders in a mission window on macOS
- **THEN** neither the left nor the right sidebar toggle button is present

#### Scenario: Windows or Linux mission window
- **WHEN** the title bar renders in a mission window on Windows or Linux
- **THEN** no sidebar toggle button is present
- **AND** the minimize, maximize/restore and close controls are present and act on the window

### Requirement: Mission window keeps the rest of the title bar
The mission window title bar SHALL keep the drag region, search pill, back/forward buttons and inbox button, with no layout shift where the toggles were: on macOS the left cluster starts after the traffic-light inset and on Windows/Linux the right cluster stays right-aligned.

#### Scenario: Remaining controls present
- **WHEN** the title bar renders in a mission window
- **THEN** the drag region, search pill, back/forward buttons and inbox button are present

#### Scenario: No layout shift
- **WHEN** the toggles are absent on macOS
- **THEN** the left cluster keeps the 80px traffic-light inset
- **WHEN** the toggles are absent on Windows/Linux
- **THEN** the right cluster keeps its right alignment and minimum width

### Requirement: Other windows keep their title bar
The main window title bar SHALL keep both sidebar toggle buttons with unchanged labels and titles, and the ⌘B / ⌥⌘B shortcuts SHALL keep cycling the sidebars. The loop window, plugin window and browser (non-Tauri) title bars SHALL be unchanged.

#### Scenario: Main window
- **WHEN** the title bar renders in the main window
- **THEN** both sidebar toggle buttons appear with their existing labels and titles

#### Scenario: Loop and plugin windows
- **WHEN** the title bar renders in a loop or plugin native window
- **THEN** it is identical to its current rendering

#### Scenario: Browser session
- **WHEN** the title bar renders outside Tauri
- **THEN** the sidebar recovery buttons are still shown
