## ADDED Requirements

### Requirement: Global agent chat is summonable from anywhere and minimizable
The app SHALL provide a single app-level agent chat, mounted above the route outlet, that can be summoned from any screen via a persistent top-bar trigger or `Cmd/Ctrl+K`, and minimized to the existing minimized-chats dock without ending the conversation.

#### Scenario: Summon from any screen
- **WHEN** the user activates the Bot trigger or presses `Cmd/Ctrl+K` on any route
- **THEN** the floating agent panel opens, anchored from the trigger, without navigating away from the current screen

#### Scenario: Minimize preserves the conversation
- **WHEN** the user minimizes the open agent panel
- **THEN** an `agent` chip appears in the minimized-chats dock
- **AND** the conversation, scroll position, and pinned project are preserved
- **AND** re-activating the chip restores the panel with the same state

### Requirement: The panel is non-modal and the app stays live behind it
The agent panel SHALL NOT dim or block the underlying app: the dashboard behind it remains visible and interactive, and updates from the agent's actions appear there in real time.

#### Scenario: Board updates while the agent works
- **WHEN** the agent performs a project mutation (e.g. launches a rail) while the panel is open
- **THEN** the corresponding dashboard surface updates live via the existing WebSocket events
- **AND** the user can still click and navigate the app behind the panel

### Requirement: The panel is movable, resizable, and generously sized
The agent panel SHALL be movable and resizable, open at a generous default size, enforce sane minimum/maximum bounds, and persist its size and position across sessions.

#### Scenario: Default size is spacious
- **WHEN** the agent panel is first opened
- **THEN** it renders at the comfortable default (≈520px wide × 78vh tall), not a small widget

#### Scenario: Resize is bounded and persisted
- **WHEN** the user resizes the panel
- **THEN** it is clamped between the minimum (≈400×420) and maximum (≈880×94vh)
- **AND** the chosen size and position are restored on the next open

### Requirement: App-level agent backend drives the app via the Specrails MCP
The agent SHALL run an AI CLI from an app-level working directory with the Specrails MCP server provided as a tool source, using an operator-oriented system prompt, so it can operate the whole application.

#### Scenario: Agent spawn is pointed at the Specrails MCP bridge
- **WHEN** an agent turn spawns the AI CLI
- **THEN** the spawn runs from the app-level agent cwd (not a project path)
- **AND** it is given `--mcp-config` pointing at the bundled `specrails-mcp` bridge

#### Scenario: Agent operates without a project view change
- **WHEN** the agent calls `specrails_select_project` to target a project
- **THEN** the user's dashboard view does not change as a side effect

### Requirement: Conversations are multi-provider and persisted app-globally
The agent chat SHALL support claude, codex, and gemini selectable per conversation, default to claude, and persist conversations app-globally (independent of any project database).

#### Scenario: Provider selectable per conversation
- **WHEN** the user selects a provider in the panel header
- **THEN** subsequent turns in that conversation spawn the selected provider's CLI

#### Scenario: Conversation survives restart
- **WHEN** the app restarts and the user reopens the agent chat
- **THEN** prior agent conversations and their pinned project / tier are restored from the app-level store

### Requirement: Premium motion that respects reduced-motion and stays GPU-bound
The agent chat SHALL animate its signature interactions (summon, minimize-morph, streamed tool-cards, tier-chip change, project dropdown) using transform/opacity only, and SHALL collapse to a minimal fade when the user prefers reduced motion.

#### Scenario: Reduced motion collapses animations
- **WHEN** the OS/browser reports `prefers-reduced-motion: reduce`
- **THEN** the panel opens/closes with a minimal fade and no spring/morph animation

#### Scenario: Summon is anchored to the trigger
- **WHEN** the panel opens
- **THEN** it animates from the trigger's origin (scale + fade + slight rise), not a generic centered fade

### Requirement: Degraded mode when the MCP server is disabled
When the embedded MCP server is disabled, the agent chat SHALL still open but surface a one-click enable affordance and operate without tools until enabled.

#### Scenario: MCP disabled shows enable banner
- **WHEN** the user opens the agent chat while `mcp_enabled` is `false`
- **THEN** the panel shows an "Enable Specrails MCP" banner
- **AND** activating it enables the MCP server without restarting the app
