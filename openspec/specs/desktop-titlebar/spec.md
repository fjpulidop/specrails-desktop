# desktop-titlebar Specification

## Purpose
Define titlebar rendering and drag behavior for desktop and browser contexts.

## Requirements

### Requirement: Custom titlebar renders only inside the Tauri shell
The `TitleBar` component SHALL render only when `window.__TAURI_INTERNALS__` is defined. In browser or non-desktop contexts it SHALL render nothing, leaving the existing layout unaffected.

#### Scenario: Running inside Tauri on macOS with Overlay
- **WHEN** the React app loads inside the Tauri WebView on macOS
- **AND** `navigator.windowControlsOverlay?.visible` is `true`
- **THEN** a compact 28px title bar strip is rendered at the top of the window
- **AND** the title bar contains only a drag region and a centered search pill
- **AND** no SR icon, no app name text, and no custom window control buttons are rendered

#### Scenario: Running inside Tauri on Windows or Linux
- **WHEN** the React app loads inside the Tauri WebView on Windows or Linux
- **AND** `navigator.windowControlsOverlay?.visible` is `false` or `undefined`
- **THEN** a 38px title bar strip is rendered with SR icon, Specrails label, and custom window control buttons

#### Scenario: Running in a browser
- **WHEN** the React app loads in a regular browser
- **THEN** no titlebar is rendered
- **AND** the existing layout is unchanged

### Requirement: Titlebar drag region allows window movement
The titlebar SHALL include a drag region that enables the user to move the frameless window.

#### Scenario: User drags the titlebar
- **WHEN** the user clicks and drags the titlebar drag region
- **THEN** the app window moves following the cursor
- **AND** clicking on window control buttons does NOT trigger dragging
