# Design - add-integrations-entry-to-agent-mode-sidebar-with-full-size-modal

## Context
Agent Mode already exposes workspace tools through `AgentWorkspaceSidebar`, with panel/modal state centralized in `AgentWorkspaceContext` and rendered from `AgentModeSurface`. Board mode gates Integrations visibility with `sectionVisibleForProviders('integrations', providers)` from `client/src/lib/provider-capabilities.ts`; the Agent Mode entry should use the same helper. `IntegrationsPage` is currently a route-level full-page component, but its internal install/uninstall confirmation dialogs already use their own modal shell and must remain nested.

Scope: frontend

## Goal
Add an Agent Mode Integrations sidebar action that opens existing integrations content in a large movable/resizable modal without navigating away from the current Agent Mode workspace.

## Non-Goals
- Do not change board mode Integrations routing or `ProjectRightSidebar` behavior.
- Do not change integration provider business logic or plugin/Jira card behavior.
- Do not alter the existing IntegrationsPage install/uninstall confirmation modal behavior.
- Do not add new provider capability rules beyond reusing the existing Integrations visibility gate.

## Design

### Architecture
Extend `AgentWorkspaceContext` with `integrationsModalOpen` plus open/close/toggle functions following the `jobsPaneOpen` pattern. `AgentWorkspaceSidebar` derives the active project providers from `useDesktop()`, checks `sectionVisibleForProviders('integrations', providers)`, and appends an Integrations tool entry immediately after the Files entry when visible. The entry calls `workspace.toggleIntegrationsModal()` and is disabled when no project is active.

`AgentModeSurface` lazy-loads a new `AgentIntegrationsModal` component and renders it when `integrationsModalOpen && activeProjectId`. The modal portals to `document.body`, uses `fixed inset-0 z-[65]`, a `glass-card` panel, and `useMovableResizableModal({ minWidth: 320, minHeight: 200, persistKey: 'specrails-desktop:agent-integrations-modal' })`. The modal body renders `<IntegrationsPage />`, so plugin cards and the Jira card stay source-of-truth in the current route component.

### Data shapes
```ts
interface AgentWorkspaceContextValue {
  integrationsModalOpen: boolean
  openIntegrationsModal: () => void
  closeIntegrationsModal: () => void
  toggleIntegrationsModal: () => void
}
```

```ts
type AgentWorkspaceSidebarToolEntry = {
  key: string
  icon: ComponentType
  label: string
  onClick: () => void
  disabled?: boolean
  disabledTitle?: string
}
```

### State & lifecycle
```text
integrationsModalOpen: false
  -- sidebar Integrations click / toggleIntegrationsModal --> true
  -- close button or backdrop / closeIntegrationsModal -----> false
```

The modal should only render for an active project. If the project disappears while open, `AgentModeSurface` naturally unmounts the modal because `activeProjectId` is falsey; the context boolean may remain true until the next close/toggle, matching the lightweight panel state pattern already used in Agent Mode.

### Public API / surface
```ts
// client/src/context/AgentWorkspaceContext.tsx
const {
  integrationsModalOpen,
  openIntegrationsModal,
  closeIntegrationsModal,
  toggleIntegrationsModal,
} = useAgentWorkspace()
```

```tsx
// client/src/components/agent-chat/AgentIntegrationsModal.tsx
export function AgentIntegrationsModal({ onClose }: { onClose: () => void }): JSX.Element
```

No HTTP routes, CLI flags, backend APIs, or external integration data shapes change.

## Trade-offs

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Wrap existing `IntegrationsPage` in a new Agent Mode modal | Reuses current content, cache, WebSocket refresh, plugin cards, Jira card, and nested confirmation dialogs | Route-level heading/layout comes along inside the modal | Yes |
| Extract a shared `IntegrationsContent` component first | Cleaner separation between route and modal shell | Larger refactor and more regression risk for board mode | No |
| Navigate Agent Mode to `/integrations` | Minimal implementation | Violates the requirement to keep the current chat/session workspace in place | No |

The chosen option keeps the behavior change small and preserves the existing IntegrationsPage as the single content source.

## Risks
- Nested portal/backdrop interactions could close the outer modal during install/uninstall confirmation flows; mitigate by using the same backdrop guard pattern as `JobDetailModal` and relying on nested modal event handling.
- Provider visibility could drift from board mode; mitigate by importing the same `sectionVisibleForProviders` helper and deriving providers with `projectProviders(activeProject)`.
- Tests may miss lazy-loaded modal behavior; mitigate with focused component tests that mock `AgentIntegrationsModal` or wait for Suspense resolution.

## Open questions
- None.
