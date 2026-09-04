# desktop-mcp-server Specification

## Purpose
TBD - created by archiving change add-desktop-mcp-server. Update Purpose after archive.
## Requirements
### Requirement: MCP server is disabled by default and toggled from settings
The app SHALL expose an `mcp_enabled` app-level setting (default `false`) that boots or tears down the embedded MCP transport without restarting the server.

#### Scenario: MCP disabled by default
- **WHEN** the app starts with no prior MCP setting
- **THEN** `mcp_enabled` is `false`
- **AND** requests to `/api/mcp` are rejected (not served)

#### Scenario: Enabling MCP from settings
- **WHEN** the user enables MCP via `PUT /api/settings` (`mcp_enabled: true`)
- **THEN** the embedded MCP transport starts serving `/api/mcp` without a server restart

#### Scenario: Disabling MCP from settings
- **WHEN** the user disables MCP via `PUT /api/settings` (`mcp_enabled: false`)
- **THEN** the MCP transport stops serving and existing MCP sessions are closed

### Requirement: Embedded streamable-HTTP transport at /api/mcp
The embedded MCP server SHALL serve the MCP streamable-HTTP transport at `/api/mcp` on the existing sidecar (`127.0.0.1:4200`), mounted so the transport receives the raw request body (ahead of the global JSON body parser).

#### Scenario: MCP client initializes a session
- **WHEN** an MCP client performs the MCP initialize handshake against `http://127.0.0.1:4200/api/mcp` with a valid MCP token
- **THEN** the server establishes an MCP session and advertises its tools and resources

#### Scenario: Raw body is preserved
- **WHEN** a request reaches `/api/mcp`
- **THEN** the MCP transport reads the unparsed request stream (the global `express.json` parser does not consume it first)

### Requirement: MCP uses a scoped token distinct from the master token
The MCP surface SHALL authenticate with a dedicated MCP-scoped token, separate from the all-powerful master token, and SHALL never require or accept the master token as the MCP credential of record.

#### Scenario: Valid MCP token grants access
- **WHEN** a request to `/api/mcp` presents the MCP-scoped token
- **THEN** the request is authorized for the MCP surface

#### Scenario: Missing or wrong token is rejected
- **WHEN** a request to `/api/mcp` presents no token or an invalid token
- **THEN** the request is rejected with an authentication error

#### Scenario: Token can be regenerated
- **WHEN** the user regenerates the MCP token from settings
- **THEN** a new MCP-scoped token replaces the old one and previously issued tokens no longer authorize

### Requirement: Four-tier opt-in permission enforcement
The MCP server SHALL classify every tool into one of four tiers — Read (always available when MCP is enabled), Write, AI-spawn, Destructive — and SHALL refuse any tool whose tier is not enabled, returning a machine-readable error naming the tier to enable.

#### Scenario: Read works whenever MCP is enabled
- **WHEN** MCP is enabled and a client invokes a Read-tier tool
- **THEN** the tool executes regardless of the other tier toggles

#### Scenario: Disabled tier refuses with guidance
- **WHEN** a client invokes a tool in a tier that is disabled (e.g. an AI-spawn tool while AI-spawn is off)
- **THEN** the server refuses the call and returns an error identifying the required tier

#### Scenario: Enabled tier permits the action
- **WHEN** the corresponding tier is enabled in settings and the client invokes a tool in that tier
- **THEN** the tool executes

### Requirement: Asynchronous results are observable through a watch tool
For operations that return acceptance immediately and emit their real result over the WebSocket bus, the MCP server SHALL provide a way to wait for and return the settled result rather than only the acceptance.

#### Scenario: Watching a cost-incurring operation to completion
- **WHEN** a client launches an asynchronous operation and then watches its returned reference
- **THEN** the server streams or accumulates the operation's events and returns the final result on completion, error, or a bounded timeout

### Requirement: MCP surface reuses the existing managers in-process
MCP tools SHALL drive the same in-process managers as the REST/WS surface (project registry, queue, chat, specs, analytics) rather than re-implementing behavior, so MCP and the GUI stay consistent.

#### Scenario: MCP action reflects in the GUI
- **WHEN** an MCP tool performs a mutation (e.g. creates a spec)
- **THEN** the change is persisted through the same manager the GUI uses and the corresponding WebSocket event is broadcast to connected GUI clients
