## ADDED Requirements

### Requirement: Hoisted terminal panel

`BottomPanel` and `StatusBar` SHALL be rendered as a single instance at the `DesktopApp` level (not inside the routed `ProjectLayout`), so they are shared by both `uiMode` values and the terminal survives when the center is no longer a project route. The `ProjectLayout` copy SHALL be removed to preserve the terminal single-adopter invariant (exactly one `TerminalViewport` adopting the shared host at any time). The maximize height math SHALL measure the main-area column that also contains the `StatusBar`.

#### Scenario: Single terminal instance across modes
- **WHEN** the terminal panel is rendered in either Kanban or Agent Mode
- **THEN** exactly one `BottomPanel`/`TerminalViewport` is mounted and no second copy exists in `ProjectLayout`

#### Scenario: Kanban terminal unchanged after hoist
- **WHEN** a user opens the terminal in Kanban Mode
- **THEN** open/restore/maximize behaves exactly as before the hoist, including correct maximize height

### Requirement: Mode-aware center and right-sidebar

The `DesktopApp` center SHALL branch on `uiMode` and route: setup wizard first, then global routes (`/loops`, `/docs`) rendered in-place, then `AgentModeSurface` when `uiMode==='agent'`, else the existing `<Routes>`. The right sidebar SHALL render `AgentWorkspaceSidebar` in Agent Mode (suppressed on global routes/setup) and `ProjectRightSidebar` in Kanban. The Kanban `<Routes>` block SHALL remain byte-identical.

#### Scenario: Center branches by mode
- **WHEN** `uiMode==='agent'` on a project route
- **THEN** the center renders `AgentModeSurface` and the right sidebar renders `AgentWorkspaceSidebar`

#### Scenario: Kanban render unchanged
- **WHEN** `uiMode==='kanban'`
- **THEN** the center `<Routes>` and `ProjectRightSidebar` render exactly as before this change

### Requirement: UiMode provider placement

`UiModeProvider` SHALL be mounted inside `DesktopProvider` and above `TitleBar` and `AgentChatProvider`, so the title bar, sidebar, agent context, and center all read a consistent `uiMode`.

#### Scenario: Shared mode across shell surfaces
- **WHEN** the mode changes
- **THEN** `TitleBar`, `ArcSidebar`, the center, and both right sidebars observe the same new value in the same render pass
