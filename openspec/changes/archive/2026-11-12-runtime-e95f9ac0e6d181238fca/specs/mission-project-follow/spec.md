# Spec Delta

## Purpose

Keeps the app's active project in step with the mission the user opens in Mission mode, so the title bar, Kanban, terminal panel and right sidebar always show the project of the mission on screen.

## ADDED Requirements

### Requirement: Selecting a mission activates its pinned project
When a mission pinned to a registered project different from the active project is selected, the system SHALL make that project the active project in the same interaction as the selection, with no extra click.

#### Scenario: Mission of another project
- **WHEN** project A is active and the user selects a mission pinned to registered project B
- **THEN** the active project becomes B and the title bar, Kanban, terminal panel and right sidebar show B without a frame of A's data under the mission

#### Scenario: Alternating missions
- **WHEN** the user alternates between missions of projects A and B
- **THEN** the active project follows the selected mission each time

#### Scenario: Rapid selection
- **WHEN** the user selects missions of A, B and A in rapid succession
- **THEN** the final active project is A

### Requirement: Selection leaves the project unchanged when there is nothing to switch to
The system SHALL NOT change the active project when the selected mission is already in the active project, has no pinned project, or is pinned to a project that is not registered; the mission SHALL still open and no error SHALL surface.

#### Scenario: Same project
- **WHEN** the user selects a mission of the active project
- **THEN** the active project is not set again and no project-scoped surface remounts or resets

#### Scenario: Home mission
- **WHEN** the user selects a mission with no pinned project
- **THEN** the active project is unchanged and the mission opens

#### Scenario: Unregistered project
- **WHEN** the user selects a mission pinned to a project absent from the registered projects
- **THEN** the active project is unchanged, the mission opens and no error is thrown

### Requirement: The switch never alters pins or user work
The switch SHALL NOT modify any mission's pinned project, including the mission being left, and SHALL NOT discard an unsent composer draft. The active project SHALL remain as switched when the user leaves Mission mode.

#### Scenario: Unstarted mission left behind
- **WHEN** the user leaves an empty mission pinned to A by selecting a mission of B
- **THEN** the empty mission remains pinned to A

#### Scenario: Draft survives
- **WHEN** a mission has an unsent draft and the user switches to a mission of another project and back
- **THEN** the draft is still present
