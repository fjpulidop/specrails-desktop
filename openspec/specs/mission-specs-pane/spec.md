# mission-specs-pane Specification

## Purpose
Lets a user see the whole backlog of the mission's project and each spec's status from inside Mission mode, without asking the agent or leaving the mission.

## Requirements

### Requirement: Specs pane lists the project backlog with status
Mission mode SHALL provide a Specs side pane, opened from the right toolbar, listing every spec of the mission's project with its id, title and status. Open specs SHALL appear first ordered in_progress, on_review, todo, draft; done and cancelled specs SHALL be folded by default.

#### Scenario: Open and closed specs
- **WHEN** the user opens the Specs pane in a mission whose project has open and done specs
- **THEN** open specs are listed by status order and done/cancelled specs are collapsed under an expandable group

#### Scenario: Live status update
- **WHEN** a spec of the project changes status while the pane is open
- **THEN** the pane reflects the new status without a reload

### Requirement: Specs pane availability and exclusivity
The Specs tool SHALL be disabled when the mission has no pinned project, and opening it SHALL close the Jobs, Files and Analytics panes.

#### Scenario: Home mission
- **WHEN** the mission has no pinned project
- **THEN** the Specs tool is disabled

#### Scenario: One pane at a time
- **WHEN** the Jobs pane is open and the user opens Specs
- **THEN** Jobs closes and Specs is shown

### Requirement: Spec detail and chat reference
Clicking a spec SHALL open the existing ticket detail modal. Dragging a spec into the composer SHALL add it as a spec reference, and it SHALL be hidden from the pane while it remains in that draft.

#### Scenario: Drag to chat
- **WHEN** the user drops a spec onto the composer
- **THEN** a reference is added and the spec disappears from the pane until the reference is removed or the message is sent

### Requirement: Specs pane shows live implementation
A spec SHALL be marked as in progress while a rail delivery of the active project includes it and has not settled (building, waiting for review, or failed), or while a live Intent (active or paused) holds it; `ticket.status` alone SHALL NOT mark it. A building run SHALL show an animated rail track along the row (static under reduced motion), with the phase as a coloured dot and a screen-reader label naming the rail and phase. When several runs include the spec, the run strip's urgency order SHALL pick one (waiting › failed › running › paused), then a rail run over the Intent label, then the newest. The row SHALL offer one shortcut, aimed at the most recently created non-archived mission working on the spec (an archived mission only when every mission with the spec is archived; any mission over a dashboard launch): open that mission when it is another mission; focus the run card when it is the open mission; open the run log when a dashboard launch has no mission.

#### Scenario: Implemented from another mission
- **WHEN** spec #15 is building on Rail 5, launched from another mission
- **THEN** its row animates, reads "On Rail 5: in progress", and its shortcut opens that mission

#### Scenario: Two missions have the spec
- **WHEN** two missions are working on the same spec
- **THEN** the row's shortcut opens the most recently created of them

#### Scenario: Archived missions
- **WHEN** an active and an archived mission both have the spec
- **THEN** the shortcut opens the active one, even if the archived one is newer; when only archived missions have it, it opens the newest archived one

#### Scenario: Implemented by the open mission
- **WHEN** the spec's run was launched from the mission being viewed
- **THEN** the shortcut focuses that run's card instead of navigating

### Requirement: Pane layout behaviour
The pane SHALL be resizable by a full-height handle, SHALL block text selection only during the drag, and newly created specs SHALL animate in unless reduced motion is requested.

#### Scenario: Resize
- **WHEN** the user drags the handle
- **THEN** the width changes within limits and text selection is restored on release
