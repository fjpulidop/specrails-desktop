# Design

## Context

Mission mode already had right-toolbar side panes (Jobs, Files, Analytics). The Specs pane follows the Jobs pattern, reading the project's tickets and live updates. The branch also bundles the Fable 5.2 alias, GitHub clone, and area chrome work. See proposal.md for motivation.

## Blast radius

- `client/src/App.tsx`: shell wiring for area chrome / sidebar behaviour.
- `client/src/components/__tests__/ArcSidebar.test.tsx`: tests updated for headerless, fully hidden sidebar.
- `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx`: tests updated for sidebar changes.
- `client/src/components/__tests__/ProjectRightSidebar.test.tsx`: tests updated for sidebar changes.
- `client/src/components/__tests__/TitleBar.test.tsx`: tests updated for title bar owning collapse controls.
- `client/src/components/ArcSidebar.tsx`: area accent, header removed, fully hidden when unpinned.
- `client/src/components/ProjectRightSidebar.tsx`: area accent, header removed, fully hidden when unpinned.
- `client/src/components/TitleBar.tsx`: owns collapse control; area surface layering.
- `client/src/features/boundaries.json`: reviewed frontend boundary manifest updated for new cross-feature imports.
- `client/src/features/chat/components/ChatInput.tsx`: accepts spec drops / spec reference support.
- `client/src/features/loops/lib/loop-run-models.ts`: Fable model entry updated to 5.2.
- `client/src/features/missions/components/__tests__/agent-chat.test.tsx`: tests for chat/composer changes.
- `client/src/features/missions/components/__tests__/AgentModeAnalyticsPane.test.tsx`: new tests for Analytics pane header/resize.
- `client/src/features/missions/components/__tests__/AgentModeCodePane.test.tsx`: tests for Files pane header/resize.
- `client/src/features/missions/components/__tests__/AgentModeJobsPane.test.tsx`: tests for Jobs pane header/resize.
- `client/src/features/missions/components/__tests__/AgentModeSpecsPane.test.tsx`: new tests for Specs pane.
- `client/src/features/missions/components/__tests__/AgentWorkspaceSidebar.test.tsx`: tests for Specs tool in toolbar.
- `client/src/features/missions/components/AgentComposer.tsx`: drop target for spec references.
- `client/src/features/missions/components/AgentModeAnalyticsPane.tsx`: 48px header, full-height handle, selection blocking.
- `client/src/features/missions/components/AgentModeCodePane.tsx`: 48px header, full-height handle, selection blocking.
- `client/src/features/missions/components/AgentModeJobsPane.tsx`: 48px header, full-height handle, selection blocking.
- `client/src/features/missions/components/AgentModeSpecsPane.tsx`: new Specs pane.
- `client/src/features/missions/components/AgentModeSurface.tsx`: mounts the Specs pane.
- `client/src/features/missions/components/AgentWorkspaceSidebar.tsx`: Specs tool in the right toolbar.
- `client/src/features/missions/context/__tests__/AgentWorkspaceContext.test.tsx`: tests for Specs pane state and exclusivity.
- `client/src/features/missions/context/AgentWorkspaceContext.tsx`: Specs pane open state and exclusivity.
- `client/src/features/missions/lib/__tests__/agent-spec-drag.test.ts`: new tests for drag payload helpers.
- `client/src/features/missions/lib/agent-context-palette.ts`: spec reference handling for dragged specs.
- `client/src/features/missions/lib/agent-spec-drag.ts`: new drag payload helpers.
- `client/src/features/missions/lib/mission-windows.ts`: per-mission state for specs hidden while in draft.
- `client/src/features/missions/README.md`: documents the Specs pane.
- `client/src/features/projects/components/__tests__/AddProjectDialog.test.tsx`: tests for GitHub entry.
- `client/src/features/projects/components/__tests__/CloneRepositoryDialog.test.tsx`: new tests for clone dialog.
- `client/src/features/projects/components/AddProjectDialog.tsx`: GitHub clone entry for the main repository.
- `client/src/features/projects/components/CloneRepositoryDialog.tsx`: new clone dialog.
- `client/src/features/projects/README.md`: documents clone flow.
- `client/src/features/settings/components/ProjectRepositoriesSection.tsx`: GitHub clone entry for additional repositories.
- `client/src/features/specs/README.md`: documents Specs pane consumption.
- `client/src/globals.css`: area accents, layered surfaces, spec arrival animation.
- `client/src/lib/__tests__/area-chrome.test.ts`: new tests for area chrome requirements.
- `client/src/locales/de/agent.json`: new strings (Specs pane).
- `client/src/locales/de/common.json`: new strings (shared/chrome).
- `client/src/locales/de/setup.json`: new strings (clone dialog).
- `client/src/locales/en/agent.json`: new strings (Specs pane).
- `client/src/locales/en/common.json`: new strings (shared/chrome).
- `client/src/locales/en/setup.json`: new strings (clone dialog).
- `client/src/locales/es/agent.json`: new strings (Specs pane).
- `client/src/locales/es/common.json`: new strings (shared/chrome).
- `client/src/locales/es/setup.json`: new strings (clone dialog).
- `client/src/locales/fr/agent.json`: new strings (Specs pane).
- `client/src/locales/fr/common.json`: new strings (shared/chrome).
- `client/src/locales/fr/setup.json`: new strings (clone dialog).
- `client/src/locales/it/agent.json`: new strings (Specs pane).
- `client/src/locales/it/common.json`: new strings (shared/chrome).
- `client/src/locales/it/setup.json`: new strings (clone dialog).
- `client/src/locales/ja/agent.json`: new strings (Specs pane).
- `client/src/locales/ja/common.json`: new strings (shared/chrome).
- `client/src/locales/ja/setup.json`: new strings (clone dialog).
- `client/src/locales/pt/agent.json`: new strings (Specs pane).
- `client/src/locales/pt/common.json`: new strings (shared/chrome).
- `client/src/locales/pt/setup.json`: new strings (clone dialog).
- `client/src/locales/zh/agent.json`: new strings (Specs pane).
- `client/src/locales/zh/common.json`: new strings (shared/chrome).
- `client/src/locales/zh/setup.json`: new strings (clone dialog).
- `docs/internals/adding-a-provider.md`: Fable alias reference updated.
- `docs/internals/api-reference.md`: documents the GitHub clone endpoint.
- `docs/internals/source-map.md`: regenerated for added files.
- `docs/internals/visual-design-audit.md`: documents area accents and surface layering.
- `openspec/changes/archive/2026-11-14-see-the-project-s-specs-and-their-status-while-working-in/.openspec.yaml`: archived earlier change metadata (added in the working tree).
- `openspec/changes/archive/2026-11-14-see-the-project-s-specs-and-their-status-while-working-in/design.md`: archived earlier change design.
- `openspec/changes/archive/2026-11-14-see-the-project-s-specs-and-their-status-while-working-in/proposal.md`: archived earlier change proposal.
- `openspec/changes/archive/2026-11-14-see-the-project-s-specs-and-their-status-while-working-in/specs/app-area-chrome/spec.md`: archived delta spec.
- `openspec/changes/archive/2026-11-14-see-the-project-s-specs-and-their-status-while-working-in/specs/fable-model-alias/spec.md`: archived delta spec.
- `openspec/changes/archive/2026-11-14-see-the-project-s-specs-and-their-status-while-working-in/specs/github-repository-clone/spec.md`: archived delta spec.
- `openspec/changes/archive/2026-11-14-see-the-project-s-specs-and-their-status-while-working-in/specs/mission-specs-pane/spec.md`: archived delta spec.
- `openspec/changes/archive/2026-11-14-see-the-project-s-specs-and-their-status-while-working-in/tasks.md`: archived earlier change tasks.
- `openspec/specs/app-area-chrome/spec.md`: main spec for area chrome.
- `openspec/specs/fable-model-alias/spec.md`: main spec for Fable alias.
- `openspec/specs/github-repository-clone/spec.md`: main spec for GitHub clone.
- `openspec/specs/mission-specs-pane/spec.md`: main spec for the Specs pane.
- `server/agent-native-transports.test.ts`: expectations updated for the Fable 5.2 model id.
- `server/desktop-router.test.ts`: tests for the clone route.
- `server/desktop-router.ts`: mounts the GitHub clone route.
- `server/github-clone.test.ts`: new tests for clone validation, no-overwrite and cleanup.
- `server/github-clone.ts`: new shell-less GitHub clone implementation.
- `server/modules/accounting/runtime/pricing.test.ts`: tests for Fable 5.2 pricing.
- `server/modules/accounting/runtime/pricing.ts`: prices Fable 5.2 at the 5.1 rate.
- `server/modules/specs/runtime/spec-models.ts`: Fable model list updated to 5.2.
- `server/providers/claude-adapter.test.ts`: tests for alias resolution to 5.2.
- `server/providers/claude-adapter.ts`: `fable` and older ids resolve to `claude-fable-5-2`.

## Rejected alternatives

None were recorded beyond the decisions in the conversation (e.g. no icon rail for hidden sidebars, read-only pane rather than a second Specs board).

## Non-Goals

- Acting on specs from the pane beyond opening detail and dragging a reference; no backlog modification.
- Changing card status colours.
- Registering a project as part of the clone call.

## Assumptions

- Per-file reasons were derived from file names, the conversation summary and the existing main specs; individual diffs were not each read line by line.
- The archived `openspec/changes/archive/...` files and the `openspec/specs/...` files already exist in the working tree from an earlier derivation of the same work. Because the four capabilities therefore already exist in `openspec/specs`, the deltas in this change are MODIFIED requirements that restate them (the pane layout requirement keeps the existing wording) rather than ADDED ones, so archiving does not collide.
