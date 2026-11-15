# Spec Delta

## MODIFIED Requirements

### Requirement: Refuse archive while live
The system SHALL reject archiving a streaming mission or one with background agents/work, using HTTP 409 with an explanatory error and code MISSION_LIVE. Refusal SHALL leave mission state and running work unchanged. Session state that cannot correspond to running work SHALL NOT keep a mission live: at server start every Core session's projected state is settled to idle with no live process or sub-agents, and a Core session reported closed is settled to idle.

#### Scenario: Streaming or background activity
- **WHEN** archive is requested during a streaming turn, reserved turn, background session or running background work
- **THEN** the request returns MISSION_LIVE without setting the archive timestamp, stopping agents or removing the row

#### Scenario: Idle resident session
- **WHEN** a mission has an idle resident session without running work
- **THEN** that alone does not prevent archive

#### Scenario: Stale session state after a restart
- **WHEN** the server starts and a mission's Core session is still projected in a turn or background phase, with a live process or with live sub-agents
- **THEN** that session is settled to idle with no live process or sub-agents, keeping its journal cursor
- **AND** archiving the mission is no longer refused because of it

#### Scenario: Closed session
- **WHEN** a Core session reports it is closed while projected in a non-idle phase
- **THEN** that session is settled to idle with no live process or sub-agents
