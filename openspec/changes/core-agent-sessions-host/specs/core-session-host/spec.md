## ADDED Requirements

### Requirement: Desktop detects and negotiates Core sessions
Desktop SHALL use Core sessions only when the selected Core runtime advertises the `sessions` capability, the host negotiates a supported protocol version, and `SPECRAILS_CORE_SESSIONS` is not `off`.

#### Scenario: Core without sessions
- **WHEN** the selected Core runtime does not advertise `sessions`
- **THEN** every conversational surface MUST keep using its legacy transport
- **AND** no session host process MUST be started

#### Scenario: Protocol mismatch
- **WHEN** the host rejects every protocol version Desktop supports
- **THEN** Desktop MUST fall back to legacy transports for that scope
- **AND** record a diagnostic that names both version sets

### Requirement: One supervised host per project scope
Desktop SHALL run at most one Core session host per scope (project key or `global`), start it lazily, supervise its health, restart it with capped backoff after unexpected exit, and stop it when its project is removed or the app shuts down.

#### Scenario: Host exits unexpectedly
- **WHEN** a scope's host process exits without a stop request
- **THEN** Desktop MUST restart it with backoff
- **AND** re-open that scope's open sessions with resume
- **AND** replay events after each session's stored cursor before accepting new input

#### Scenario: Repeated host failure
- **WHEN** a host fails to stay healthy beyond the restart budget
- **THEN** the scope MUST become degraded
- **AND** new turns in that scope MUST use the legacy transport with a visible notice

#### Scenario: Project removed
- **WHEN** a project is removed
- **THEN** its host MUST receive a graceful shutdown and be tree-killed after the grace period
- **AND** hosts of other scopes MUST be unaffected

#### Scenario: Journal held by another process
- **WHEN** the host reports `journal_locked`
- **THEN** Desktop MUST NOT start another host for that scope
- **AND** MUST show an actionable error

### Requirement: Features choose a transport through one port
Conversational features SHALL depend on a conversation transport port selected at composition time, and SHALL NOT branch on provider ids to decide execution behaviour.

#### Scenario: Provider with a Core driver
- **WHEN** a mission uses a provider for which the host lists a driver and Core sessions are enabled
- **THEN** the mission MUST run on the Core session transport

#### Scenario: Provider without a Core driver
- **WHEN** the host does not list a driver for the provider
- **THEN** the mission MUST run on the legacy transport

### Requirement: The Desktop projection is idempotent and rebuildable
Desktop SHALL apply Core session events to its database in one transaction together with the session cursor, SHALL ignore events at or below the cursor, and SHALL be able to rebuild a session's projection by replaying from sequence zero.

#### Scenario: Duplicate event after reconnect
- **WHEN** an event with a sequence at or below the stored cursor is received
- **THEN** it MUST NOT change the projection or be broadcast again

#### Scenario: Crash during projection
- **WHEN** the sidecar stops while applying an event
- **THEN** after restart the projection MUST equal the state obtained by replaying from the stored cursor

#### Scenario: Rebuild
- **WHEN** a session's projection is rebuilt from sequence zero
- **THEN** it MUST equal the live projection

### Requirement: Core usage is recorded with its declared semantics
Desktop SHALL record one invocation per Core turn from its usage event, with origin `user`, `subagent` or `system`, keeping billed and estimated values distinct and missing values null, and SHALL NOT add sub-agent usage to invocation totals.

#### Scenario: Continuation turn billed
- **WHEN** Core reports usage for a continuation turn
- **THEN** Desktop MUST record a separate invocation with origin `subagent`

#### Scenario: Estimated cost
- **WHEN** Core marks a turn's cost as estimated
- **THEN** the invocation MUST be stored with the estimated flag set

### Requirement: Specrails MCP capability is bound to the Core session
The Specrails MCP capability for a mission SHALL be minted when its Core session opens, bound to the conversation, database, Core session and host epoch, and revoked when the session closes or the host is lost.

#### Scenario: Caller after host restart
- **WHEN** an MCP call carries a capability minted for a previous host epoch
- **THEN** it MUST be rejected
- **AND** MUST NOT consume pending mission input
