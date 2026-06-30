# bespoke-modal-movable-resizable Specification

## Purpose

Adopt the `useMovableResizableModal()` hook directly on the Tier B custom-overlay centered modals that do not use `DialogContent`. Title-bar modals become move-and-resize; title-less modals are resize-only. TicketDetailModal is resize-only (its header keeps the drag-to-split gesture), and modals embedded inside SplitViewShell disable the hook entirely so the SplitViewShell divider stays the sole resizer.

## Requirements

### Requirement: Tier B Bespoke Modals Adopt The Hook

The custom-overlay centered modals that do not use `DialogContent` SHALL adopt `useMovableResizableModal()` directly on their panel element and render the resize grips: JobDetailModal, JobComparisonModal, SmashConfirmModal, the RecentJobs clear-modal, the IntegrationsPage ModalShell, the FileViewer budget prompt, ExploreSpecShell, and AiEditShell. Modals with a clear title bar SHALL ALSO spread the header move surface on that title bar (move-by-header). Modals without a clear title bar (e.g. the FileViewer budget prompt) SHALL be resize-only (`allowMove: false`). Each modal SHALL keep its existing Escape and backdrop-close behavior unchanged.

#### Scenario: A Tier B modal with a title bar can be moved and resized

- **WHEN** the user opens a Tier B modal that has a title bar on a viewport at or above the gate
- **THEN** the modal SHALL be resizable from its corners and edges
- **AND** it SHALL be movable by dragging its title bar (never by clicking the body)

#### Scenario: Existing close behavior preserved

- **WHEN** a Tier B modal adopts the hook
- **THEN** its existing Escape-to-close and backdrop-click-to-close behavior SHALL continue to function

### Requirement: TicketDetailModal Is Resize-Only

TicketDetailModal SHALL receive resize grips (corners and edges) but SHALL NOT be movable by its header. Its header SHALL remain dedicated to the existing drag-to-split gesture. The hook SHALL be configured with `allowMove: false` for this modal.

#### Scenario: Header still triggers split, not move

- **WHEN** the user drags the TicketDetailModal header past the split threshold
- **THEN** the existing split-view gesture SHALL fire and the modal SHALL NOT enter a free-move state

#### Scenario: TicketDetailModal can be resized

- **WHEN** the user drags a TicketDetailModal corner or edge grip
- **THEN** the modal SHALL resize without affecting the split gesture

### Requirement: Embedded Modals Disable The Hook

When a modal is rendered embedded inside SplitViewShell, the hook SHALL be passed `enabled: false` so the modal applies no fixed positioning and renders no grips, sizing as a flex child while SplitViewShell's divider remains the only resizer in that container.

#### Scenario: Embedded TicketDetailModal is not independently movable or resizable

- **WHEN** TicketDetailModal renders embedded inside SplitViewShell
- **THEN** it SHALL apply no inline fixed positioning and render no resize grips
- **AND** the SplitViewShell divider SHALL remain the sole resize control in that container
