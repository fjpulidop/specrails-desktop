# agent-mission-project-binding Specification

## Purpose
TBD - created by archiving change fix-desktop-reopen-pin-release-opus. Update Purpose after archive.
## Requirements
### Requirement: Active project selection binds an unstarted mission

In Agent (mission) mode the left sidebar's active project and the mission's pinned project SHALL stay coherent in both directions while the mission has not started.

When the user changes the active project in Agent Mode, the agent SHALL bind the current mission to that project: a mission that has no conversation yet SHALL update its draft pin, and a conversation that exists but carries no messages SHALL have its pinned project patched. The binding SHALL be applied immediately, without requiring the user to also open the mission's project selector.

The existing reverse direction is unchanged: choosing a project in the mission's project selector while composing SHALL also move the sidebar's active project.

#### Scenario: Sidebar click pins a draft mission

- **WHEN** Agent Mode is active, no mission conversation exists yet, and the user selects a project in the sidebar
- **THEN** the agent's draft pinned project SHALL become that project

#### Scenario: Sidebar click pins an empty mission

- **WHEN** Agent Mode is active, the active mission conversation has no messages, and the user selects a project in the sidebar
- **THEN** the mission's pinned project SHALL be patched to that project

### Requirement: A started mission keeps its pinned project

A mission whose conversation already carries messages SHALL NOT be re-pinned by an active-project change, because its transcript, tool calls, and reference resolution are scoped to the project it was started against.

The binding SHALL also not fire from the initial render of Agent Mode: only an actual change of the active project after mount SHALL bind a mission, so an explicitly Home-pinned (app-global) mission is never silently converted to a project mission.

#### Scenario: Started mission ignores a project switch

- **WHEN** the active mission has at least one message and the user selects a different project in the sidebar
- **THEN** the mission's pinned project SHALL remain unchanged

#### Scenario: Mount does not bind a Home mission

- **WHEN** Agent Mode mounts with a Home (app-global) mission while a project is active in the sidebar
- **THEN** the mission SHALL remain Home-pinned until the user actually changes the active project

#### Scenario: Board mode is unaffected

- **WHEN** the UI is in board mode and the active project changes
- **THEN** the floating agent panel's pinned project SHALL remain unchanged

