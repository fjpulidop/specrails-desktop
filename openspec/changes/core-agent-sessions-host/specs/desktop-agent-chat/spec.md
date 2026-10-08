## MODIFIED Requirements

### Requirement: Every accepted agent turn reaches a terminal state

The app SHALL guarantee that a turn accepted for execution — whether started by a user message or opened by the agent as a continuation after background work — is eventually represented as completed, failed, stopped, or interrupted, and SHALL clear its streaming indicator exactly once for every terminal outcome.

#### Scenario: MCP or provider activity stalls

- **WHEN** an accepted turn produces no provider output, sub-agent output or tool progress for the configured inactivity deadline
- **THEN** the server MUST terminate the owned provider process
- **AND** persist a failed invocation outcome
- **AND** broadcast one terminal `agent_error` for the conversation

#### Scenario: Only background work remains

- **WHEN** no turn is open and the provider reports live background tasks
- **THEN** the turn inactivity deadline MUST NOT run
- **AND** the background stall and maximum-lifetime limits MUST govern the process instead

#### Scenario: Continuation turn settles

- **WHEN** an agent-initiated continuation turn receives its provider result, fails, is stopped, or its process exits
- **THEN** it MUST reach exactly one terminal state with its own invocation record
- **AND** its streaming indicator MUST be cleared once

#### Scenario: Terminal paths race

- **WHEN** timeout, abort, provider exit, or server shutdown attempt to settle the same turn concurrently
- **THEN** terminal settlement MUST be idempotent
- **AND** the client MUST NOT receive contradictory completed and failed outcomes

#### Scenario: One turn stalls while another mission opens

- **WHEN** a project tool stalls in one conversation
- **THEN** the provider-availability API and new-mission controls MUST remain responsive
- **AND** the user MUST be able to create or inspect another mission without restarting the app

### Requirement: Agent live state reconciles after connection recovery

The client SHALL reconcile optimistic per-conversation streaming, tool, resident-phase and sub-agent state against authoritative server state whenever the shared WebSocket reconnects.

#### Scenario: Sidecar restarts during a turn

- **WHEN** the WebSocket reconnects to a restarted sidecar and the previously streaming conversation has no active server turn
- **THEN** the client MUST clear the permanent thinking indicator
- **AND** show an inline interruption outcome for that turn
- **AND** retain the already-sent user message without automatically retrying it
- **AND** show previously live sub-agents as interrupted

#### Scenario: Connection drops but the turn remains active

- **WHEN** the WebSocket reconnects and the server reports that the conversation turn is still active
- **THEN** the client MUST retain or restore its streaming state and live tools
- **AND** continue processing subsequent terminal events without duplicating messages

#### Scenario: Connection drops during background work

- **WHEN** the WebSocket reconnects and the server reports the conversation in the `background` phase
- **THEN** the client MUST restore the background indicator and the live sub-agent rows
- **AND** MUST NOT show a thinking indicator for a turn that is not open

#### Scenario: Reconnection snapshot races with a newer turn

- **WHEN** a reconciliation response predates a newly accepted turn for the same conversation
- **THEN** the client MUST NOT clear the newer turn's live state
