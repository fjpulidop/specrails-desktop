# Proposal

## Why

In Mission mode, selecting a mission pinned to a different project leaves `activeProjectId` unchanged, so the title bar, Kanban, terminal panel and right sidebar keep showing the previous project while the conversation belongs to another one. The workspace tools then no longer match the mission on screen.

## What Changes

- Selecting a mission from the Mission sidebar (`useOpenMission`) switches the app's active project to the mission's pinned project, synchronously in the same handler that selects the conversation, via the existing `useDesktop().setActiveProjectId`.
- The switch is a no-op when the mission has no pinned project (Home), the pinned project is not in `projects`, or it already equals `activeProjectId`.
- A pure helper `resolveMissionProjectSwitch` decides the target project.
- `AgentChatContext`'s backward-binding effect (re-pins an unstarted active mission to the new `activeProjectId`) is suppressed while a mission selection is pending, so the switch never rewrites the pin of the mission being left.
- Tests for different-project, same-project, no-project, unregistered-project, rapid A-B-A and draft persistence.

## Capabilities

### New Capabilities
- `mission-project-follow`: selecting a mission makes the app's active project follow the mission's pinned project, without altering any pin.

### Modified Capabilities

None.

## Impact

- Client only: `client/src/features/missions/hooks/useOpenMission.ts`, `client/src/features/missions/context/AgentChatContext.tsx`, a new helper and tests. No server, schema, API or persisted-format change; no new network call beyond an existing project switch.
