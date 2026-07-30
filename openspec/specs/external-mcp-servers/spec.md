# external-mcp-servers Specification

## Purpose
TBD - created by archiving change add-external-mcp-servers. Update Purpose after archive.
## Requirements
### Requirement: External MCP registry storage
The system SHALL persist the external MCP registry as ONE JSON blob under `desktop_settings['external_mcp_servers']` (`{ version: 1, servers: { [id]: entry } }`) with no SQLite migration. Entry ids SHALL be stable and source-scoped (`d:<sourceProvider>:<name>` for discovered, `c:<name>` for custom). Discovered entries SHALL persist selection metadata only (source, sourceProvider, name, providers matrix) — never a transport snapshot. Custom entries SHALL persist a full stdio transport (`command`, `args`, `env`).

#### Scenario: Discovered entry stores no transport
- **WHEN** the user ticks a server discovered from `~/.claude.json` for kimi missions
- **THEN** the stored entry contains `source: 'discovered'`, `sourceProvider: 'claude'`, the name, and `providers.kimi = true`, and contains NO transport fields

#### Scenario: Custom entry stores its transport
- **WHEN** the user adds a custom entry with command/args/env
- **THEN** the stored entry contains the full stdio transport and `source: 'custom'`

### Requirement: Native-config discovery
The system SHALL discover candidate servers by reading provider native user configs read-only: `~/.claude.json` (top-level `mcpServers`), `~/.gemini/settings.json` (`mcpServers`), `~/.kimi-code/mcp.json` (`mcpServers`), and `~/.codex/config.toml` (names only, via `[mcp_servers.<name>]` table headers). A missing or unparseable config SHALL yield an empty list for that provider and never an error. The system SHALL NEVER write to any provider native config.

#### Scenario: Corrupt native config degrades to empty
- **WHEN** `~/.gemini/settings.json` contains invalid JSON
- **THEN** discovery returns an empty gemini list and every other provider's discovery is unaffected

#### Scenario: Codex servers are names-only
- **WHEN** `~/.codex/config.toml` declares `[mcp_servers.foo]`
- **THEN** discovery lists `foo` under `codexNative` with no transport, and `foo` is not offered as a cross-provider source

### Requirement: External MCP REST surface
The system SHALL expose `GET /api/external-mcp` returning `{ discovered, settings }` (discovery executed per request; discovered entries flagged present/orphan against current selections) and `PATCH /api/external-mcp` replacing the settings blob after validation, both on the desktop router under master-token auth. PATCH SHALL reject with typed error codes: `reserved_name` (server name `specrails`), `duplicate_server_name` (two enabled entries injecting the same name for the same provider), `invalid_transport` (custom entry without a non-empty `command`), `unknown_provider` (matrix key outside the registered adapter ids).

#### Scenario: Reserved name rejected
- **WHEN** a PATCH contains a custom entry named `specrails`
- **THEN** the server responds 400 with error code `reserved_name` and stores nothing

#### Scenario: Duplicate injected name rejected
- **WHEN** a PATCH enables two entries that would both inject the name `jira` into claude missions
- **THEN** the server responds 400 with error code `duplicate_server_name` and stores nothing

#### Scenario: Valid patch round-trips
- **WHEN** a valid PATCH is applied and `GET /api/external-mcp` is called
- **THEN** the returned `settings` equal the patched blob

### Requirement: Mission spawn injection
The system SHALL inject enabled external servers into mission agent spawns by extending the existing per-provider wiring in `prepareAgentMcp`: claude receives all entries in the same per-conversation `--mcp-config` file alongside `specrails`; codex receives one `-c mcp_servers.<name>.*` override group per entry; gemini and kimi receive entries merged into their per-conversation-cwd settings file. Discovered entries SHALL resolve their transport live from the source native config at spawn time; an entry whose source no longer defines it SHALL be skipped for that spawn (logged) without failing the turn. The `specrails` bridge entry SHALL always be present regardless of external entries.

#### Scenario: Claude mission carries external server
- **WHEN** a claude mission turn spawns with entry `jira-interno` enabled for claude
- **THEN** the generated per-conversation `mcp.json` contains both `mcpServers.specrails` and `mcpServers.jira-interno`

#### Scenario: Orphaned discovered entry skipped
- **WHEN** an enabled discovered entry's name is no longer present in its source native config at spawn time
- **THEN** the spawn proceeds with the remaining servers and the entry is skipped for that turn

#### Scenario: Cross-provider injection
- **WHEN** an entry discovered from `~/.claude.json` is enabled for kimi
- **THEN** the kimi mission spawn's `.kimi-code/mcp.json` in the conversation cwd contains that server with the transport read live from `~/.claude.json`

### Requirement: Owned-key cleanup for file-merged providers
For providers whose registration is a persistent settings file (gemini, kimi), the system SHALL track the external keys it wrote in a sidecar ownership file within the conversation cwd, and on every spawn SHALL remove previously-owned external keys before merging the currently-enabled set, so that disabling an entry removes it from the next spawn. Keys not written by the app SHALL never be removed, and the `specrails` key SHALL be managed outside the sidecar.

#### Scenario: Disabled entry removed on next spawn
- **WHEN** an entry previously injected into a gemini conversation's settings file is disabled and the conversation spawns again
- **THEN** the settings file no longer contains that server key and still contains `specrails`

### Requirement: Consent-first activation
The system SHALL NOT enable any discovered or custom server automatically: discovery only lists candidates, and every entry starts fully unticked. The Settings UI SHALL display warning copy stating that mission spawns run without tool-approval prompts and that external tools are outside the Specrails tier ladder. Codex-native servers SHALL be displayed as "native, always on" without a toggle.

#### Scenario: Discovery does not activate
- **WHEN** discovery finds a new server in a native config
- **THEN** no mission spawn includes it until the user ticks it for at least one provider

### Requirement: Kill switch
The system SHALL bypass all external-MCP resolution and injection when `SPECRAILS_EXTERNAL_MCP` is set to `false`/`0`/`off` (case-insensitive), producing byte-identical spawn wiring to the pre-change behaviour while leaving stored settings untouched.

#### Scenario: Kill switch restores legacy wiring
- **WHEN** `SPECRAILS_EXTERNAL_MCP=false` and entries are enabled in settings
- **THEN** mission spawns carry only the `specrails` entry exactly as before the change

### Requirement: Settings UI card
The client SHALL render an "External MCP servers" card in Settings ▸ MCP showing one row per registry entry and per discovered candidate: name, source badge (discovered-from-provider / custom), per-provider activation matrix, orphan badge for selections missing from their source config, an add-custom form (name, command, args, env pairs), and the consent warning copy. All user-visible strings SHALL be translated in all 8 locales under the `mcp` namespace.

#### Scenario: Orphan badge shown
- **WHEN** a stored discovered selection no longer matches any server in its source native config
- **THEN** the row renders an orphan indicator and its matrix toggles remain editable (allowing removal)

### Requirement: Operator prompt disclosure
The mission operator prompt SHALL state that additional user-configured tools may be available and that all Specrails app operations must still be performed through `specrails_*` tools.

#### Scenario: Prompt carries the disclosure
- **WHEN** a mission turn is spawned for any provider
- **THEN** the composed operator prompt contains the external-tools disclosure line

