# desktop-agent-chat Specification

## Purpose
TBD - created by archiving change add-desktop-agent-chat. Update Purpose after archive.
## Requirements
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

### Requirement: Every accepted agent turn reaches a terminal state

The app SHALL guarantee that a turn accepted for execution is eventually represented as completed, failed, stopped, or interrupted, and SHALL clear its streaming indicator exactly once for every terminal outcome.

#### Scenario: MCP or provider activity stalls

- **WHEN** an accepted turn produces no provider output or tool progress for the configured inactivity deadline
- **THEN** the server MUST terminate the owned provider process
- **AND** persist a failed invocation outcome
- **AND** broadcast one terminal `agent_error` for the conversation

#### Scenario: Terminal paths race

- **WHEN** timeout, abort, provider exit, or server shutdown attempt to settle the same turn concurrently
- **THEN** terminal settlement MUST be idempotent
- **AND** the client MUST NOT receive contradictory completed and failed outcomes

#### Scenario: One turn stalls while another mission opens

- **WHEN** a project tool stalls in one conversation
- **THEN** the provider-availability API and new-mission controls MUST remain responsive
- **AND** the user MUST be able to create or inspect another mission without restarting the app

### Requirement: Agent live state reconciles after connection recovery

The client SHALL reconcile optimistic per-conversation streaming state against authoritative server turn state whenever the shared WebSocket reconnects.

#### Scenario: Sidecar restarts during a turn

- **WHEN** the WebSocket reconnects to a restarted sidecar and the previously streaming conversation has no active server turn
- **THEN** the client MUST clear the permanent thinking indicator
- **AND** show an inline interruption outcome for that turn
- **AND** retain the already-sent user message without automatically retrying it

#### Scenario: Connection drops but the turn remains active

- **WHEN** the WebSocket reconnects and the server reports that the conversation turn is still active
- **THEN** the client MUST retain or restore its streaming state
- **AND** continue processing subsequent terminal events without duplicating messages

#### Scenario: Reconnection snapshot races with a newer turn

- **WHEN** a reconciliation response predates a newly accepted turn for the same conversation
- **THEN** the client MUST NOT clear the newer turn's live state

### Requirement: Failed provider turns preserve useful partial output

When a provider emits non-empty assistant text before an unsuccessful exit, the app SHALL preserve that text while clearly representing the turn as failed or interrupted.

#### Scenario: Provider emits text and exits non-zero

- **WHEN** a provider streams non-empty text and subsequently exits with a non-zero code or normalized provider error
- **THEN** the server MUST persist the partial assistant text
- **AND** the client MUST render it with an explicit failed or interrupted indication
- **AND** clear the thinking indicator
- **AND** the turn MUST NOT be recorded as successful

#### Scenario: Provider fails without output

- **WHEN** a provider fails without emitting assistant text
- **THEN** the client MUST show the failure reason inline
- **AND** clear the thinking indicator

### Requirement: Agent-authored Contract Layer preserves provider ownership

Post-commit Contract Layer enrichment for an agent-authored spec SHALL use only the provider that authored the request and SHALL NOT silently select a different installed provider.

#### Scenario: Selected provider supports Contract Layer

- **WHEN** an agent-authored commit requests Contract Layer and the originating provider advertises structured actions
- **THEN** the enrichment MUST run with that same provider and a model valid for it

#### Scenario: Selected provider does not support Contract Layer

- **WHEN** an agent-authored commit requests Contract Layer and the originating provider does not advertise structured actions
- **THEN** the committed spec MUST be retained without Contract Layer enrichment
- **AND** the system MUST report an explicit unsupported/skipped outcome
- **AND** it MUST NOT invoke Claude or any other installed provider as a fallback

### Requirement: Stopping a turn preserves the shared server connection

Stopping an agent turn SHALL terminate only the provider process tree owned by that conversation and SHALL leave the desktop sidecar, shared WebSocket, unrelated turns, and all connected clients available.

#### Scenario: Provider exits during graceful Stop

- **WHEN** Stop sends graceful termination and the owned provider child closes before escalation
- **THEN** the pending force-kill timer MUST be cancelled
- **AND** no later signal MUST target that PID or process group

#### Scenario: Provider ignores graceful Stop

- **WHEN** the owned provider child remains alive through the graceful termination period
- **THEN** forceful escalation MUST target only the still-owned provider process group
- **AND** MUST NOT target the desktop sidecar or another conversation's process

#### Scenario: Another client is connected during Stop

- **WHEN** one client stops an active conversation while another client is connected to the same desktop server
- **THEN** both clients' WebSocket connections MUST remain usable
- **AND** provider availability and new-mission APIs MUST continue responding
- **AND** only the stopped conversation and its queued messages MUST settle
