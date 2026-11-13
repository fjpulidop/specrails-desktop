# mission-sidebar-active-filter Specification

## Purpose
Lets a person supervising several missions narrow the Mission-mode left sidebar to the missions that are running right now, and return to the full list with one click.

## Requirements

### Requirement: Active-missions toggle in the sidebar
In Mission mode with the sidebar expanded, the system SHALL show an icon-only toggle button at the right end of the "Projects" section label, with a localized accessible name and tooltip, operable by keyboard.

#### Scenario: Button visible in expanded Mission mode
- **WHEN** Mission mode is on and the sidebar is expanded
- **THEN** a filter toggle with an accessible name is visible beside the "Projects" label

#### Scenario: Button hidden otherwise
- **WHEN** the sidebar is collapsed to the rail, or Mission mode is off
- **THEN** the filter toggle is not rendered

### Requirement: Toggle state is exposed
The toggle SHALL expose `aria-pressed` reflecting whether the filter is on and SHALL use a distinct lit style while on.

#### Scenario: Pressed state
- **WHEN** the person activates the toggle
- **THEN** it reports `aria-pressed="true"` and shows the lit style
- **AND** activating it again reports `aria-pressed="false"`

### Requirement: Filter limits missions to live ones
While the filter is on, Favorites, Home and every project group SHALL list only missions within the selected archive scope that the sidebar already marks live (a turn streaming or agents working in the background), subject to the existing open-mission exception. Missions that are only awaiting a decision or failed are not included unless also live or open. Changing either filter SHALL NOT reset the other.

#### Scenario: Filter on
- **WHEN** some missions are live and the filter is turned on
- **THEN** every group lists only the live missions within the selected archive scope, subject to the open-mission exception

#### Scenario: Filter off restores the list
- **WHEN** the filter is turned off
- **THEN** all missions within the selected archive scope are listed again in their original order

#### Scenario: Independent archive scope
- **WHEN** Archived is selected while live-only is on
- **THEN** only archived missions satisfying live-only or its open-mission exception remain
- **AND** changing archive scope does not turn live-only off, and changing live-only does not alter archive scope

### Requirement: Open mission stays visible
While the filter is on, the currently open mission SHALL remain listed in its group even when it is not live, provided it belongs to the selected archive scope. The open-mission exception SHALL NOT bypass archive scope.

#### Scenario: Open idle mission
- **WHEN** the filter is on and the open mission is not live but belongs to the selected archive scope
- **THEN** that mission is still listed

#### Scenario: Open archived mission outside Active
- **WHEN** Active is selected and an archived mission is open
- **THEN** the archived mission is excluded from the sidebar even under the open-mission exception

### Requirement: Empty groups and empty state
While the filter is on, Favorites and Home groups with no remaining missions SHALL be hidden and project rows SHALL stay visible without a mission tree. If no mission remains anywhere, the sidebar SHALL show a "No active missions" line.

#### Scenario: No live missions
- **WHEN** the filter is on, no mission is live and none is open
- **THEN** a "No active missions" message is shown and the Favorites and Home groups are not rendered

### Requirement: Live updates without reload
The filtered list SHALL follow liveness changes without a reload, including in the collapsed rail.

#### Scenario: Mission stops being live
- **WHEN** the filter is on and a live, non-open mission finishes
- **THEN** it disappears from the list

#### Scenario: Mission starts streaming
- **WHEN** the filter is on and an idle mission starts streaming
- **THEN** it appears in the list

#### Scenario: Collapsed rail
- **WHEN** the filter is on and the sidebar is collapsed
- **THEN** rail indicators reflect only the filtered missions

### Requirement: Filter state persists
The filter state SHALL be stored locally and restored on reload; a missing or invalid stored value SHALL mean off, and storage failures SHALL NOT break the sidebar.

#### Scenario: Restored on reload
- **WHEN** the filter was turned on and the app is reloaded
- **THEN** the filter is on

#### Scenario: Corrupt stored value
- **WHEN** the stored value is not a valid state
- **THEN** the filter is off
