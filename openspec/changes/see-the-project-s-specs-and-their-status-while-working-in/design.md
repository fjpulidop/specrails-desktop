# Design

## Context

The Specs pane mirrors the Jobs pane chrome and reuses `useTickets` (bound to the active project, which follows the mission) and the ticket detail modal. Drag payloads carry a draft key and a spec chip; the pane hides specs whose chip is present in the composer reference draft for that key. See proposal.md - Why.

## Goals / Non-Goals

**Goals:**
- Show the mission project's whole backlog and statuses live in Mission mode.

**Non-Goals:**
- Acting on specs from the pane (launching, editing, status changes); the Specs board remains the management surface.
- Modifying the backlog when a spec is dragged to the chat.

## Decisions

- Read-only pane, opened from the right toolbar like Jobs; closed specs folded by default; disabled without a pinned project; exclusive with Jobs, Files and Analytics.

## Risks / Trade-offs

- Live updates and layout beside the composer are asserted in unit tests with a mocked tickets hook, not in a running UI.

## Blast radius

- `client/src/features/boundaries.json` - reviewed frontend boundary manifest update for the new missions-to-specs import.
- `client/src/features/missions/components/__tests__/agent-chat.test.tsx` - composer/chat test updated for spec drops.
- `client/src/features/missions/components/__tests__/AgentModeSpecsPane.test.tsx` - new tagged tests for the Specs pane (list, order, folding, live status, drag, selection lock).
- `client/src/features/missions/components/__tests__/AgentWorkspaceSidebar.test.tsx` - tagged tests for the Specs toolbar button, including disabled with no project.
- `client/src/features/missions/components/AgentComposer.tsx` - drop target for spec references.
- `client/src/features/missions/components/AgentModeSpecsPane.tsx` - new Specs pane.
- `client/src/features/missions/components/AgentModeSurface.tsx` - mounts the Specs pane.
- `client/src/features/missions/components/AgentWorkspaceSidebar.tsx` - Specs toolbar button.
- `client/src/features/missions/context/__tests__/AgentWorkspaceContext.test.tsx` - tagged tests for Specs pane state and exclusivity.
- `client/src/features/missions/context/AgentWorkspaceContext.tsx` - open/close/toggle Specs pane state, exclusive with other panes.
- `client/src/features/missions/lib/__tests__/agent-spec-drag.test.ts` - new tests for the drag payload.
- `client/src/features/missions/lib/agent-context-palette.ts` - spec chip creation for drag/reference.
- `client/src/features/missions/lib/agent-spec-drag.ts` - new spec drag type and payload helpers.
- `client/src/features/missions/lib/mission-windows.ts` - pane state support for Specs.
- `client/src/features/missions/README.md` - documents the Specs pane.
- `client/src/features/specs/README.md` - documents the missions consumer.
- `client/src/locales/de/agent.json` - Specs pane strings.
- `client/src/locales/en/agent.json` - Specs pane strings.
- `client/src/locales/es/agent.json` - Specs pane strings.
- `client/src/locales/fr/agent.json` - Specs pane strings.
- `client/src/locales/it/agent.json` - Specs pane strings.
- `client/src/locales/ja/agent.json` - Specs pane strings.
- `client/src/locales/pt/agent.json` - Specs pane strings.
- `client/src/locales/zh/agent.json` - Specs pane strings.
- `docs/internals/source-map.md` - regenerated source map for added files.

## Rejected alternatives

None were recorded. The open questions were settled as decisions: read-only pane, closed specs folded, pane disabled without a pinned project.

## Assumptions

- The GitHub clone, Fable 5.2 alias and app-area chrome work is out of the ticket's scope but was explicitly confirmed by the user to be kept (Intent decision), so it is recorded as requirements `github-repository-clone`, `fable-model-alias` and `app-area-chrome`, each with a tagged test.
- Fable 5.2 pricing is provisional: it reuses the 5.1 rate and may misstate cost until the real rate is published.
- `server/github-clone.ts` takes a user-supplied URL and destination; it is covered by argument-validation and no-overwrite tests but has not had a separate security audit.
