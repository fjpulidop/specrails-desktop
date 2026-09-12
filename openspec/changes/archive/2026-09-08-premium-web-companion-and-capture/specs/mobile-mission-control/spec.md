## ADDED Requirements

### Requirement: Capability-aware mission operation
Companion SHALL expose supported mission conversation, follow-up and process operations on a phone and recover authoritative state after reconnection.

#### Scenario: Connect to an older Desktop
- **WHEN** mission capabilities are unavailable
- **THEN** existing authorized Specs and Rails features remain usable and unsupported mission controls are not offered.

### Requirement: Preserve paired-device authorization
Mission reads and writes MUST require all-project grants while agent project pinning is only contextual. Existing lists, events and controls MUST respect restricted project grants.

#### Scenario: Restricted device requests mission control
- **WHEN** a restricted paired device requests a mission transcript or sends a mission message
- **THEN** the gateway rejects the operation and the client explains the missing capability without exposing cross-project data.

### Requirement: Repository context and honest state
Companion SHALL distinguish repository scope, pending messages, execution and readiness using server evidence; demo controls MUST remain read-only.

#### Scenario: Reconnect during active work
- **WHEN** the phone reconnects after missing events
- **THEN** mission and job views refresh from server snapshots rather than retaining stale optimistic execution state.
