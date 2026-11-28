## ADDED Requirements

### Requirement: Tapflow tools for mission agents
While Specrails runs Tapflow and holds its token, every mission agent SHALL receive Tapflow's MCP server as `tapflow`, whatever the person's external-server settings; it SHALL not be injected while Tapflow is off, and a server the person named `tapflow` SHALL win.

#### Scenario: Agent lists devices
- **WHEN** Tapflow is on and a mission agent is asked to list devices with its tools
- **THEN** it calls `tapflow` `list_devices` and answers from the relay

#### Scenario: Tapflow off
- **WHEN** Tapflow is off
- **THEN** no `tapflow` server is injected

### Requirement: Mobile testing through Specrails' MCP
`specrails_integrations` SHALL expose Tapflow as an app-global plugin and a `mobile_test` action that starts Test in Mobile Device for a delivery and platforms and returns the run ref.

#### Scenario: Test from an external client
- **WHEN** a client calls `mobile_test` with a delivery and `["ios"]`
- **THEN** the run starts and its ref is returned, so the client can wait on it

#### Scenario: Missing arguments
- **WHEN** the delivery or a valid platform is missing
- **THEN** the call fails with `invalid_input` and starts nothing
