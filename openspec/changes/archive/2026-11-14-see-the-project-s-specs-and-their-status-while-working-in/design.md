# Design

## Context

The Specs pane mirrors the Jobs pane chrome and reuses `useTickets` (bound to the active project, which follows the mission) and the ticket detail modal. Drag payloads carry a draft key and a spec chip; the pane hides specs whose chip is present in the composer reference draft for that key. See proposal.md - Why.

## Goals / Non-Goals

**Goals:**
- Show the mission project's whole backlog and statuses live in Mission mode.

**Non-Goals:**
- Acting on specs from the pane (launching, editing, status changes); the Specs board remains the management surface.
- Modifying the backlog when a spec is dragged to the chat.
- Official Fable 5.2 pricing.

## Decisions

- Read-only pane, opened from the right toolbar like Jobs; closed specs folded by default; disabled without a pinned project; exclusive with Jobs, Files and Analytics.
- Clone destination is user-chosen and never overwritten; a completed clone is kept if registration is cancelled.
- Area accents use theme colours; surfaces layer top bar < centre < sidebars; hidden sidebars disappear entirely.

## Risks / Trade-offs

- Live updates and layout beside the composer are asserted in unit tests with a mocked tickets hook, not in a running UI.

## Blast radius

- `client/src/App.tsx` - app shell wiring for area chrome and hideable sidebars.
- `client/src/components/__tests__/ArcSidebar.test.tsx` - tests for sidebar area accent and hiding.
- `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx` - adjusted for sidebar changes.
- `client/src/components/__tests__/ProjectRightSidebar.test.tsx` - tests for right sidebar accent/hiding.
- `client/src/components/__tests__/TitleBar.test.tsx` - adjusted for title bar chrome changes.
- `client/src/components/ArcSidebar.tsx` - area accent, header removal and full hiding.
- `client/src/components/ProjectRightSidebar.tsx` - area accent and full hiding.
- `client/src/components/TitleBar.tsx` - area surface/accent chrome.
- `client/src/features/boundaries.json` - reviewed frontend boundary manifest update for the new missions-to-specs import.
- `client/src/features/chat/components/ChatInput.tsx` - Fable 5.2 model label.
- `client/src/features/loops/lib/loop-run-models.ts` - Fable 5.2 model label.
- `client/src/features/missions/components/__tests__/agent-chat.test.tsx` - composer/chat test updated for spec drops.
- `client/src/features/missions/components/__tests__/AgentModeAnalyticsPane.test.tsx` - new tests for Analytics header/handle/selection lock.
- `client/src/features/missions/components/__tests__/AgentModeCodePane.test.tsx` - tests for Files header/handle/selection lock.
- `client/src/features/missions/components/__tests__/AgentModeJobsPane.test.tsx` - tests for Jobs header/handle/selection lock.
- `client/src/features/missions/components/__tests__/AgentModeSpecsPane.test.tsx` - new tagged tests for the Specs pane (list, order, folding, live status, drag, selection lock).
- `client/src/features/missions/components/__tests__/AgentWorkspaceSidebar.test.tsx` - tagged tests for the Specs toolbar button, including disabled with no project.
- `client/src/features/missions/components/AgentComposer.tsx` - drop target for spec references.
- `client/src/features/missions/components/AgentModeAnalyticsPane.tsx` - 48px header, full-height handle, selection lock.
- `client/src/features/missions/components/AgentModeCodePane.tsx` - 48px header, full-height handle, selection lock.
- `client/src/features/missions/components/AgentModeJobsPane.tsx` - 48px header, full-height handle, selection lock.
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
- `client/src/features/projects/components/__tests__/AddProjectDialog.test.tsx` - tests for GitHub clone entry in add-project.
- `client/src/features/projects/components/__tests__/CloneRepositoryDialog.test.tsx` - new tests for the clone dialog.
- `client/src/features/projects/components/AddProjectDialog.tsx` - GitHub clone option for the main repository.
- `client/src/features/projects/components/CloneRepositoryDialog.tsx` - new clone-from-GitHub dialog.
- `client/src/features/projects/README.md` - documents the clone dialog.
- `client/src/features/settings/components/ProjectRepositoriesSection.tsx` - GitHub clone option for additional repositories.
- `client/src/features/specs/README.md` - documents the missions consumer.
- `client/src/globals.css` - area accent and surface layer styles.
- `client/src/lib/__tests__/area-chrome.test.ts` - new tests for area accent/surface definitions.
- `client/src/locales/de/agent.json` - Specs pane strings.
- `client/src/locales/de/common.json` - shared chrome/clone strings.
- `client/src/locales/de/setup.json` - clone/add-project strings.
- `client/src/locales/en/agent.json` - Specs pane strings.
- `client/src/locales/en/common.json` - shared chrome/clone strings.
- `client/src/locales/en/setup.json` - clone/add-project strings.
- `client/src/locales/es/agent.json` - Specs pane strings.
- `client/src/locales/es/common.json` - shared chrome/clone strings.
- `client/src/locales/es/setup.json` - clone/add-project strings.
- `client/src/locales/fr/agent.json` - Specs pane strings.
- `client/src/locales/fr/common.json` - shared chrome/clone strings.
- `client/src/locales/fr/setup.json` - clone/add-project strings.
- `client/src/locales/it/agent.json` - Specs pane strings.
- `client/src/locales/it/common.json` - shared chrome/clone strings.
- `client/src/locales/it/setup.json` - clone/add-project strings.
- `client/src/locales/ja/agent.json` - Specs pane strings.
- `client/src/locales/ja/common.json` - shared chrome/clone strings.
- `client/src/locales/ja/setup.json` - clone/add-project strings.
- `client/src/locales/pt/agent.json` - Specs pane strings.
- `client/src/locales/pt/common.json` - shared chrome/clone strings.
- `client/src/locales/pt/setup.json` - clone/add-project strings.
- `client/src/locales/zh/agent.json` - Specs pane strings.
- `client/src/locales/zh/common.json` - shared chrome/clone strings.
- `client/src/locales/zh/setup.json` - clone/add-project strings.
- `docs/internals/adding-a-provider.md` - documents the fable alias pinned to 5.2 and legacy ids.
- `docs/internals/api-reference.md` - documents the repository clone endpoint.
- `docs/internals/source-map.md` - regenerated source map for added files.
- `docs/internals/visual-design-audit.md` - documents area accents and surface layering.
- `server/agent-native-transports.test.ts` - expects `fable` to spawn as `claude-fable-5-2`.
- `server/desktop-router.test.ts` - tests for the clone endpoint.
- `server/desktop-router.ts` - adds `POST /repositories/clone`.
- `server/github-clone.test.ts` - new tests for clone validation and no-overwrite.
- `server/github-clone.ts` - new GitHub clone implementation.
- `server/modules/accounting/runtime/pricing.test.ts` - tests for Fable 5.2 pricing.
- `server/modules/accounting/runtime/pricing.ts` - provisional Fable 5.2 rate (reuses 5.1).
- `server/modules/specs/runtime/spec-models.ts` - Fable 5.2 model label.
- `server/providers/claude-adapter.test.ts` - tests for the Fable 5.2 alias and legacy collapse.
- `server/providers/claude-adapter.ts` - `fable` resolves to `claude-fable-5-2`; 5.1 and 5 collapse to `fable`.

## Rejected alternatives

None were recorded. The open questions were settled as decisions: read-only pane, closed specs folded, pane disabled without a pinned project.

## Assumptions

- The GitHub clone, Fable 5.2 alias and app-area chrome work is outside the ticket's stated scope but the user explicitly confirmed keeping it ("Mantener todo y registrarlo como requisitos con tests"), so it is recorded as requirements `github-repository-clone`, `fable-model-alias` and `app-area-chrome`.
- Per-file reasons for locale, docs, shell and test files not read line-by-line are inferred from file names and the conversation summary.
- Fable 5.2 pricing is provisional: it reuses the 5.1 rate and may misstate cost until the real rate is published.
- `server/github-clone.ts` takes a user-supplied URL and destination; it is covered by argument-validation and no-overwrite tests but has not had a separate security audit.
