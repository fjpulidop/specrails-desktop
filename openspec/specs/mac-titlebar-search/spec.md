# mac-titlebar-search Specification

## Purpose
Define the macOS overlay titlebar search pill behavior and layout.

## Requirements

### Requirement: Search pill displays active project name in title bar
On macOS with native traffic lights active, the title bar SHALL render a centered search pill showing the name of the currently active project. When no project is active, the pill SHALL display the placeholder text "Search…".

#### Scenario: Active project selected
- **WHEN** the app is running on macOS with `titleBarStyle: "Overlay"` active
- **AND** a project is selected as the active project
- **THEN** a centered pill is displayed in the title bar containing a search icon and the project name
- **AND** the pill is truncated with ellipsis if the name exceeds available width

#### Scenario: No active project
- **WHEN** the app is running on macOS with `titleBarStyle: "Overlay"` active
- **AND** no project is currently selected
- **THEN** the pill displays the placeholder text "Search…" with muted styling

### Requirement: Search pill opens command palette on click
Clicking the search pill SHALL open the Cmd+K command palette.

#### Scenario: User clicks the search pill
- **WHEN** the user clicks the search pill in the title bar
- **THEN** the command palette opens (equivalent to pressing Cmd+K)
- **AND** the pill click does NOT trigger window dragging

### Requirement: Title bar is compact on macOS overlay
When macOS native traffic lights are active, the title bar height SHALL be 28px to align vertically with the traffic light circles.

#### Scenario: macOS overlay mode
- **WHEN** `navigator.windowControlsOverlay?.visible` is `true`
- **THEN** the title bar renders at 28px height
- **AND** the search pill is vertically centered within that 28px

### Requirement: Search pill is centered in the full title bar width
The search pill SHALL be absolutely centered relative to the full window width, regardless of traffic light position.

#### Scenario: Pill centering
- **WHEN** the title bar renders on macOS
- **THEN** the pill is positioned at `left: 50%; transform: translateX(-50%)`
- **AND** the pill has `max-width: 360px` and `min-width: 160px`
- **AND** the pill does not overlap the traffic light area on minimum-width windows (900px min)
