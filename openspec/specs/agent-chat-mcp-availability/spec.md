# agent-chat-mcp-availability Specification

## Purpose
TBD - created by archiving change add-desktop-agent-chat. Update Purpose after archive.
## Requirements
### Requirement: Specrails MCP is injected into each project's workspace on setup
On project setup the app SHALL surgically merge a `mcpServers.specrails` entry into the project's app-managed workspace `.mcp.json` so the project's own AI spawns can call the Specrails MCP, without ever writing to the pristine repository.

#### Scenario: Workspace mcp.json gets the Specrails entry
- **WHEN** a project completes setup
- **THEN** the app merges a `mcpServers.specrails` entry into `~/.specrails/projects/<slug>/workspace/.mcp.json`
- **AND** the repository's own files (including any repo `.mcp.json`) are not modified

#### Scenario: Merge is surgical and additive
- **WHEN** the workspace `.mcp.json` already contains other `mcpServers` entries (e.g. plugins)
- **THEN** merging the `specrails` entry preserves the existing entries
- **AND** only the `specrails` key is added or updated

### Requirement: The injected entry runs the bundled bridge without inlining the token
The injected `mcpServers.specrails` entry SHALL invoke the bundled `specrails-mcp` stdio bridge, which reads the local MCP token from disk, so no token value is written into the `.mcp.json` file.

#### Scenario: No token in the config file
- **WHEN** the `specrails` entry is written to the workspace `.mcp.json`
- **THEN** the file contains the bridge invocation
- **AND** does not contain the MCP token value

#### Scenario: Bridge authenticates from the local token file
- **WHEN** a project spawn launches the `specrails` MCP server via the entry
- **THEN** the bridge authenticates using the local `~/.specrails/mcp.token`
