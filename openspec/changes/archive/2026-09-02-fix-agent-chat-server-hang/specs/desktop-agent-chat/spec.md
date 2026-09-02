## ADDED Requirements

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
