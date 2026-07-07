# Implementation Tasks

> The developer agent runs these in order. Each "## N." block is a single TDD cycle: write the failing test, run it to confirm it fails, write production code, run again to confirm it passes. Do NOT skip the failing-test step.

## 1. Workspace context exposes Integrations modal state
- [x] 1.1 Write a failing test covering `AgentWorkspaceContext` or a small consumer component that asserts `integrationsModalOpen` defaults to false and `toggleIntegrationsModal` flips it. Run the targeted client test; the new test MUST fail.
- [x] 1.2 Extend `client/src/context/AgentWorkspaceContext.tsx` with `integrationsModalOpen`, `openIntegrationsModal`, `closeIntegrationsModal`, and `toggleIntegrationsModal`, mirroring the existing jobs pane pattern. Run the targeted client test; ALL tests MUST pass.
- [x] 1.3 Refactor if needed without changing behavior. Run the targeted client test again; all tests still pass.

## 2. Sidebar shows provider-gated Integrations after Files
- [x] 2.1 Write a failing test for `client/src/components/agent-chat/AgentWorkspaceSidebar.tsx` that renders the sidebar with an active project and verifies the Integrations entry appears immediately after Files and calls `toggleIntegrationsModal` when clicked. Run the targeted client test; the new test MUST fail.
- [x] 2.2 Update `AgentWorkspaceSidebar.tsx` to import `Puzzle`, `projectProviders`, and `sectionVisibleForProviders`, derive providers from the active project, and insert the `integrations` tool entry immediately after `files` when visible. Use the same tool-entry shape and disabled project behavior as Files. Run the targeted client test; ALL tests MUST pass.
- [x] 2.3 Add or extend the sidebar test to cover the provider-hidden case by mocking `sectionVisibleForProviders` false. Run the targeted client test; all tests still pass.

## 3. Full-size Agent Integrations modal wraps existing page content
- [x] 3.1 Write a failing test for a new `AgentIntegrationsModal` that mocks `IntegrationsPage`, renders the modal, and asserts the modal portals a fixed z-[65] overlay with the IntegrationsPage content and close control. Run the targeted client test; the new test MUST fail.
- [x] 3.2 Create `client/src/components/agent-chat/AgentIntegrationsModal.tsx` using `createPortal`, `useMovableResizableModal({ minWidth: 320, minHeight: 200, persistKey: 'specrails-desktop:agent-integrations-modal' })`, `ResizeGrips`, `glass-card`, and `<IntegrationsPage />` in the scrollable body. Keep the internal IntegrationsPage confirmation dialogs untouched. Run the targeted client test; ALL tests MUST pass.
- [x] 3.3 Refactor if needed without changing behavior. Run the targeted client test again; all tests still pass.

## 4. AgentModeSurface mounts modal without navigation
- [x] 4.1 Write a failing `AgentModeSurface` test that mocks `useAgentWorkspace()` with `integrationsModalOpen: true`, mocks `AgentIntegrationsModal`, and asserts the modal renders when an active project exists. Run the targeted client test; the new test MUST fail.
- [x] 4.2 Update `client/src/components/agent-chat/AgentModeSurface.tsx` to lazy-load `AgentIntegrationsModal`, include `integrationsModalOpen` from workspace context, compute `showIntegrations`, and render the modal with `closeIntegrationsModal`. Run the targeted client test; ALL tests MUST pass.
- [x] 4.3 Add or extend a test asserting the modal does not render without an active project. Run the targeted client test again; all tests still pass.

## 5. Validation gate
- [x] 5.1 Run the targeted client tests for the changed Agent Mode and integrations modal files; all pass.
- [x] 5.2 Run the full client test suite (`cd client && npm run test`); all pass.
- [x] 5.3 Run the client build (`cd client && npm run build`); succeeds.
- [x] 5.4 No `console.log`, debug prints, or commented-out code in the diff.
