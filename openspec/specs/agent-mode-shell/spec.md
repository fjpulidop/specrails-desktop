# agent-mode-shell Specification

## Purpose
TBD - created by archiving change switch-to-agent-mode. Update Purpose after archive.
## Requirements
### Requirement: Persisted UI mode

The system SHALL expose an app-global `uiMode` with values `'kanban'` and `'agent'`, provided by a `UiModeProvider` and read via `useUiMode()`. The mode SHALL persist to `localStorage` under `specrails-desktop:uiMode` and restore on reload. When `FEATURE_AGENT_MODE` is off, the mode SHALL be pinned to `'kanban'` and writes SHALL be ignored. A consumer rendered outside the provider SHALL receive a NOOP value pinned to `'kanban'`.

#### Scenario: Mode restores from storage on reload
- **WHEN** the user set Agent Mode and reloads the app
- **THEN** `useUiMode().uiMode` reads `'agent'` from `localStorage` on first render

#### Scenario: Feature flag off pins kanban
- **WHEN** `FEATURE_AGENT_MODE` resolves false
- **THEN** `uiMode` is `'kanban'`, `setUiMode('agent')` is a no-op, and no new Agent-Mode UI renders

#### Scenario: NOOP fallback without provider
- **WHEN** a component calls `useUiMode()` with no `UiModeProvider` ancestor
- **THEN** it receives `uiMode==='kanban'` and no-op setters, and does not throw

### Requirement: Switch-mode toggle

The left sidebar SHALL render a Switch button above the Loops entry in both modes. In Kanban it SHALL read "Switch to Agent Mode" and switch to `'agent'`; in Agent Mode it SHALL read "Switch to Kanban mode" and switch to `'kanban'`. The toggle SHALL persist the new mode.

#### Scenario: Toggle flips and persists
- **WHEN** the user clicks the Switch button in Kanban
- **THEN** `uiMode` becomes `'agent'`, the label flips to "Switch to Kanban mode", and `localStorage` records `'agent'`

### Requirement: Center surface swap

In Agent Mode the center content area SHALL render `AgentModeSurface` instead of the routed dashboard, EXCEPT when the current route is a global route (`/loops` or `/docs`), which SHALL still render in the center without leaving Agent Mode. The setup wizard SHALL take precedence over both. In Kanban the center SHALL render the existing `<Routes>` byte-identically.

#### Scenario: Dashboard replaced by agent surface
- **WHEN** `uiMode==='agent'` and the route is a project route
- **THEN** the center renders `AgentModeSurface` and not the dashboard

#### Scenario: Global routes stay in Agent Mode
- **WHEN** `uiMode==='agent'` and the user navigates to `/loops`
- **THEN** the Loops page renders in the center and `uiMode` remains `'agent'`

#### Scenario: Setup wizard precedence
- **WHEN** a project is mid-setup and `uiMode==='agent'`
- **THEN** the setup wizard renders instead of `AgentModeSurface`

### Requirement: Floating surfaces suppressed in Agent Mode

When `uiMode==='agent'` the floating `AgentChatPanel` and `AgentBubble` SHALL NOT mount. In Kanban they SHALL mount exactly as before.

#### Scenario: Bubble hidden in Agent Mode
- **WHEN** `uiMode==='agent'`
- **THEN** neither the agent bubble nor the floating panel is present in the DOM

#### Scenario: Bubble present in Kanban
- **WHEN** `uiMode==='kanban'` and agent chat is enabled
- **THEN** the floating bubble mounts as today

### Requirement: Agent Mode surface states

`AgentModeSurface` SHALL show an EMPTY state (a centered "Plan, Build" composer card) when the active conversation is `null`, and an ACTIVE state (the conversation thread plus docked composer) when a conversation is active. The surface SHALL NOT auto-create or auto-load a conversation on mount (it MUST NOT call `ensureActive`), so the EMPTY state is reachable. When entering Agent Mode with an already-active conversation, the ACTIVE state SHALL show immediately.

#### Scenario: Empty state with no active conversation
- **WHEN** `AgentModeSurface` mounts with `active===null`
- **THEN** it shows the centered composer and creates no conversation

#### Scenario: Active state renders thread
- **WHEN** a conversation is active
- **THEN** the surface renders the thread and the docked composer

### Requirement: Right sidebar swap

In Agent Mode the app SHALL render `AgentWorkspaceSidebar` on the right instead of `ProjectRightSidebar`, and SHALL suppress it on global routes and during setup. In Kanban the existing `ProjectRightSidebar` behavior SHALL be unchanged.

#### Scenario: Workspace sidebar in Agent Mode
- **WHEN** `uiMode==='agent'` and not on a global route
- **THEN** the right side renders `AgentWorkspaceSidebar`

#### Scenario: Project sidebar in Kanban
- **WHEN** `uiMode==='kanban'` with an active project
- **THEN** the right side renders `ProjectRightSidebar` as before

### Requirement: Coherent mode-transition motion

The Kanban↔Agent transition SHALL reuse the app's existing motion vocabulary: the hero curve `cubic-bezier(0.34, 1.56, 0.64, 1)` for the center/surface crossfade, the 200ms rail width animation for the right-sidebar baton-pass, semantic theme tokens only, and `glass-card` chrome. The transition SHALL degrade to an opacity-only crossfade under `prefers-reduced-motion: reduce`.

#### Scenario: Reduced motion degrades gracefully
- **WHEN** the user prefers reduced motion and toggles mode
- **THEN** the swap uses an opacity crossfade with no transform/scale/slide and widths snap
