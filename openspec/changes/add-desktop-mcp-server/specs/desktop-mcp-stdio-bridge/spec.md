## ADDED Requirements

### Requirement: Bridge relays MCP stdio to the embedded HTTP server
The app SHALL ship a `specrails-mcp` bridge that speaks the MCP stdio transport to a client and relays requests to the embedded MCP server at `http://127.0.0.1:4200/api/mcp`, so clients that only support stdio can use the full MCP surface.

#### Scenario: Client talks to Specrails through the bridge
- **WHEN** an MCP client spawns the `specrails-mcp` bridge and performs MCP calls over stdio
- **THEN** the bridge forwards each call to `/api/mcp` and returns the server's response to the client

#### Scenario: Bridge is transparent to the catalog
- **WHEN** new tools or actions are added to the embedded MCP server
- **THEN** the bridge relays them without code changes (it carries no knowledge of the tool catalog)

### Requirement: Bridge holds the token locally
The bridge SHALL read the MCP-scoped token from the local token file and attach it to its requests, so the token never needs to appear in the MCP client's configuration.

#### Scenario: Token is not in client config
- **WHEN** a user configures their MCP client to use the bridge
- **THEN** the client configuration contains no token, and the bridge supplies the token from the local file

### Requirement: Clear error when the app is not running
The bridge SHALL surface a clear, actionable error when the embedded server is unreachable, instructing the user to start the Specrails app.

#### Scenario: App is closed
- **WHEN** the bridge cannot reach `127.0.0.1:4200`
- **THEN** it returns an error indicating the Specrails app is not running and must be started

### Requirement: Bridge is bundled and run by the bundled Node runtime
The bridge SHALL be shipped inside the app bundle as a script executed by the app's bundled Node runtime, requiring no separately code-signed binary and no system Node installation.

#### Scenario: Bridge runs without system Node
- **WHEN** the bridge is launched per the configuration the app provides
- **THEN** it runs using the bundled Node runtime and does not require Node to be installed on the user's PATH

#### Scenario: Bundled before signing
- **WHEN** the desktop app is built and packaged
- **THEN** the bridge is included in the app's bundled resources before the signing/notarization step
