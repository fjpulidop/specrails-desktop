## ADDED Requirements

### Requirement: Mission sub-agent state is projected from Core
Desktop SHALL project Core sub-agent events into durable mission state (identity, parent, kind, description, agent type, phase, settled flag, timestamps, usage, result summary, bounded output) without interpreting provider-specific frames.

#### Scenario: Sub-agent starts
- **WHEN** Core emits `subagent.started` for a mission session
- **THEN** Desktop MUST persist the sub-agent linked to the launching turn's assistant message
- **AND** broadcast `agent_subagent` with the full record after the commit

#### Scenario: Re-entrant status
- **WHEN** Core moves a sub-agent from a completed phase back to running
- **THEN** the projection MUST update the same record
- **AND** the UI MUST show it as running again

### Requirement: Mission sub-agent state is exposed through snapshot, events, API and MCP
Desktop SHALL include resident phase, live sub-agents and the open turn's origin in the active-turns snapshot, broadcast sub-agent changes and throttled sub-agent output over WebSocket, serve paged sub-agent history over HTTP, and expose roster and stop operations through the Specrails MCP mission surface.

#### Scenario: Reconnect during background work
- **WHEN** the client reconnects while a mission has live sub-agents and no open turn
- **THEN** the snapshot MUST restore the background indicator and sub-agent rows without duplicates
- **AND** MUST NOT show a thinking indicator

#### Scenario: Page sub-agent history
- **WHEN** a client requests a sub-agent's output after a sequence number
- **THEN** the API MUST return the next page of its bounded projected output

#### Scenario: Stop through MCP
- **WHEN** an authorized MCP caller stops a mission's sub-agents
- **THEN** the same semantics as the UI stop control MUST apply

### Requirement: Missions show sub-agents as first-class activity
The mission UI SHALL show live and finished sub-agents next to the turn that launched them, let the user inspect each one, keep sub-agent tools out of the parent's activity, and indicate background work in the composer and sidebar.

#### Scenario: Agents working card
- **WHEN** a turn launches sub-agents
- **THEN** a card under that turn MUST show counts of working and finished sub-agents
- **AND** one row per sub-agent with status, description, agent type and live elapsed time
- **AND** usage and estimated cost MUST appear only once that sub-agent finishes

#### Scenario: Inspect a sub-agent
- **WHEN** the user expands a sub-agent row
- **THEN** its text and tool activity MUST be shown, live while it runs

#### Scenario: Sub-agent tools stay separate
- **WHEN** a sub-agent uses tools
- **THEN** the parent's live activity chip MUST NOT show them
- **AND** the activity log MUST group them under the sub-agent

#### Scenario: Background indicator
- **WHEN** a mission has live sub-agents and no open turn
- **THEN** the composer MUST show the number of background agents, elapsed time and a stop control
- **AND** the sidebar MUST keep the mission's working indicator

#### Scenario: Continuation turn in an unfocused mission
- **WHEN** a continuation turn settles in a mission that is not focused
- **THEN** the mission MUST be marked unread
- **AND** the message MUST carry a label naming what triggered it

#### Scenario: Provider prose contradicts state
- **WHEN** the agent's text claims a sub-agent finished while Core reports it running
- **THEN** the card MUST show the Core-reported status

#### Scenario: Localized and accessible
- **WHEN** the sub-agent UI renders in any of the 8 supported locales or with reduced motion
- **THEN** all copy MUST be localized
- **AND** status MUST be conveyed by text and accessible labels, not only colour or motion

### Requirement: Interrupted sub-agents are relaunched only by the user
Desktop SHALL show interrupted and stopped sub-agents with their reason and SHALL offer a Relaunch action that only drafts a composer message.

#### Scenario: Relaunch drafting
- **WHEN** the user selects Relaunch on an interrupted sub-agent
- **THEN** the composer MUST contain a relaunch request naming that sub-agent
- **AND** nothing MUST be sent until the user sends it

### Requirement: Settings changes during background work are explicit
When a mission's model, effort, tier or sub-agent policy changes while sub-agents run, Desktop SHALL show that the change is deferred and offer to stop the agents and apply it immediately.

#### Scenario: Deferred model change
- **WHEN** Core reports a mission update as deferred
- **THEN** the UI MUST show a deferred notice with a "stop agents and apply now" action
