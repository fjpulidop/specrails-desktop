# Spec Delta

## MODIFIED Requirements

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

### Requirement: Pane layout behaviour
The pane SHALL be resizable by a full-height handle, SHALL block text selection only during the drag, and newly created specs SHALL animate in unless reduced motion is requested.

#### Scenario: Resize
- **WHEN** the user drags the handle
- **THEN** the width changes within limits and text selection is restored on release
