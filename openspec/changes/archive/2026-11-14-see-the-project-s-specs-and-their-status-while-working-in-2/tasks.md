# Tasks

## 1. Specs pane

- [x] 1.1 Add the Specs side pane listing the project backlog by status, with folded done/cancelled and live updates
  - Evidence: client/src/features/missions/components/AgentModeSpecsPane.tsx, client/src/features/missions/components/__tests__/AgentModeSpecsPane.test.tsx (asserts listing, ordering and folding)
- [x] 1.2 Add the Specs tool to the toolbar, disabled without a pinned project, exclusive with other panes
  - Evidence: client/src/features/missions/components/AgentWorkspaceSidebar.tsx, client/src/features/missions/context/AgentWorkspaceContext.tsx, AgentWorkspaceSidebar.test.tsx and AgentWorkspaceContext.test.tsx (assert tool state and exclusivity)
- [x] 1.3 Drag specs into the composer as references, hidden while in the draft
  - Evidence: client/src/features/missions/lib/agent-spec-drag.ts, client/src/features/missions/components/AgentComposer.tsx, client/src/features/missions/lib/__tests__/agent-spec-drag.test.ts
- [x] 1.4 Align pane headers (48px), full-height handles and drag-only selection blocking on Jobs, Files, Analytics
  - Evidence: AgentModeJobsPane.tsx, AgentModeCodePane.tsx, AgentModeAnalyticsPane.tsx and their tests under client/src/features/missions/components/__tests__/

## 2. Fable 5.2

- [x] 2.1 Resolve `fable` and older ids to `claude-fable-5-2` and price it
  - Evidence: server/providers/claude-adapter.ts, server/providers/claude-adapter.test.ts, server/modules/accounting/runtime/pricing.ts, pricing.test.ts

## 3. GitHub clone

- [x] 3.1 Add the shell-less clone service and route with no-overwrite and cleanup rules
  - Evidence: server/github-clone.ts, server/github-clone.test.ts, server/desktop-router.ts, server/desktop-router.test.ts
- [x] 3.2 Add the clone dialog to Add Project and repository settings
  - Evidence: CloneRepositoryDialog.tsx, AddProjectDialog.tsx, CloneRepositoryDialog.test.tsx, AddProjectDialog.test.tsx; ProjectRepositoriesSection.tsx has no dedicated test

## 4. Area chrome

- [x] 4.1 Add area accents, layered surfaces and fully hidden headerless sidebars
  - Evidence: client/src/globals.css, ArcSidebar.tsx, ProjectRightSidebar.tsx, TitleBar.tsx, client/src/lib/__tests__/area-chrome.test.ts, ArcSidebar.test.tsx, TitleBar.test.tsx

## 5. Docs and locales

- [x] 5.1 Add locale strings in 8 languages and update docs and source map
  - Evidence: client/src/locales/*, docs/internals/*; no dedicated automated test
