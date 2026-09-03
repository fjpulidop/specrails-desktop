# desktop-mcp-onboarding-docs Specification

## Purpose
TBD - created by archiving change add-desktop-mcp-server. Update Purpose after archive.
## Requirements
### Requirement: Settings panel explains and configures MCP
The app SHALL provide a `Settings ▸ MCP` panel that explains what an MCP is, how to enable it, and what it grants, and that exposes the enable toggle, the four permission-tier controls, and a ready-to-paste client configuration.

#### Scenario: Panel surfaces the controls and config
- **WHEN** the user opens the MCP settings panel
- **THEN** the panel shows a plain-language explanation, the enable toggle, the Read/Write/AI-spawn/Destructive tier controls, and a copyable client-configuration block

#### Scenario: Copying the client configuration
- **WHEN** the user copies the client configuration from the panel
- **THEN** the copied block contains the correct command/paths (or URL) for connecting an MCP client, without exposing a token in the client config

### Requirement: Welcome wizard surfaces the MCP feature
The welcome/onboarding wizard SHALL include a hint introducing the MCP feature, consistent with how other integrations are surfaced.

#### Scenario: Hint shown in the welcome wizard
- **WHEN** the user views the welcome wizard
- **THEN** a short hint about the MCP feature is shown, pointing to where it can be enabled

### Requirement: Reference documentation for MCP exists
The repository SHALL include a `docs/mcp.md` reference covering what the MCP is, how to enable it, what it exposes, and the security tiers.

#### Scenario: Docs cover enable and access
- **WHEN** a reader opens `docs/mcp.md`
- **THEN** it explains what the MCP is, how to enable it from settings, what operations it exposes, and the permission tiers

### Requirement: All user-facing MCP strings are localized in 8 languages with key-parity
Every user-facing MCP string (settings panel, welcome hint) SHALL be provided in all 8 supported languages (en, es, fr, de, pt, it, zh, ja) and SHALL satisfy the locale key-parity test.

#### Scenario: All locales present and parity holds
- **WHEN** the locale key-parity test runs
- **THEN** every MCP string exists in all 8 locales with matching keys and placeholders

#### Scenario: Active language drives the MCP UI text
- **WHEN** the user has selected one of the 8 supported languages
- **THEN** the MCP settings panel and welcome hint are shown in that language
