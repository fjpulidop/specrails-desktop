# Tasks

## 1. Specs pane

- [x] 1.1 Add the Specs pane listing the project backlog with status, folded closed group and detail modal
  - Evidence: client/src/features/missions/components/AgentModeSpecsPane.tsx, AgentModeSpecsPane.test.tsx (tags spec:mission-specs-pane/specs-pane-lists-the-project-backlog-with-status, covering ordering, folding and re-render on a status change)
- [x] 1.2 Add Specs pane state to workspace context, toolbar button and surface; disabled without a project, exclusive with other panes
  - Evidence: AgentWorkspaceContext.tsx, AgentWorkspaceSidebar.tsx, AgentModeSurface.tsx, AgentWorkspaceContext.test.tsx and AgentWorkspaceSidebar.test.tsx (tag spec:mission-specs-pane/specs-pane-availability-and-exclusivity, incl. disabled for a Home mission)
- [x] 1.3 Drag a spec into the composer as a reference and hide it while in the draft; open detail on click
  - Evidence: agent-spec-drag.ts, agent-context-palette.ts, AgentComposer.tsx, agent-spec-drag.test.ts, AgentModeSpecsPane.test.tsx (tag spec:mission-specs-pane/spec-detail-and-chat-reference)
- [x] 1.4 Give the Specs pane a 48px header, full-height resize handle and drag-only selection lock
  - Evidence: AgentModeSpecsPane.tsx, AgentModeSpecsPane.test.tsx (tag spec:mission-specs-pane/pane-layout-behaviour)
- [x] 1.5 Add pane locale strings in 8 languages and update READMEs, boundaries and source map
  - Evidence: client/src/locales/*/agent.json, missions and specs READMEs, boundaries.json, source-map.md (no dedicated test; locale parity and architecture checks)

## 2. Kept at the user's request

- [x] 2.1 GitHub repository clone (server/github-clone.ts, desktop-router, CloneRepositoryDialog)
  - Evidence: github-clone.test.ts, desktop-router.test.ts, CloneRepositoryDialog.test.tsx (tags spec:github-repository-clone/*)
- [x] 2.2 Fable 5.2 model alias and provisional pricing
  - Evidence: claude-adapter.test.ts (tag spec:fable-model-alias/fable-alias-resolves-to-claude-fable-5-2), pricing.test.ts
- [x] 2.3 Area accents, surface layering and hideable sidebars
  - Evidence: area-chrome.test.ts, ArcSidebar.test.tsx, ProjectRightSidebar.test.tsx (tags spec:app-area-chrome/*)
