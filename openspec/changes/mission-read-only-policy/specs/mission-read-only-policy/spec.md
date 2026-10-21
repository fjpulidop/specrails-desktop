## ADDED Requirements

### Requirement: Mission turns run under the provider's native read-only boundary

Every mission (agent chat) turn SHALL request the provider's native read-only boundary on every transport: one-shot spawns, native live sessions and Core agent sessions. A mission turn SHALL NOT have any built-in provider tool that writes files or runs mutating commands in a workspace, except where the provider has no native read-only mode.

#### Scenario: Claude one-shot and live mission turns

- **WHEN** a Claude mission turn spawns through the legacy or stream-json transport
- **THEN** the argv SHALL contain `--tools Read,Grep,Glob,Agent,WebFetch,WebSearch`
- **AND** it SHALL NOT contain `--tools default`, `--permission-mode plan` or `--safe-mode`

#### Scenario: Codex mission turns

- **WHEN** a Codex mission turn spawns or resumes, or opens an app-server thread
- **THEN** it SHALL use the `read-only` sandbox

#### Scenario: Gemini mission turns

- **WHEN** a Gemini mission turn spawns
- **THEN** it SHALL use `--approval-mode plan` and SHALL NOT use `--yolo`

#### Scenario: Local engine mission turns

- **WHEN** a local engine mission turn spawns
- **THEN** the runner SHALL receive its read-only tool set

### Requirement: Specrails MCP tools stay callable in read-only missions

Every read-only mission boundary SHALL keep the MCP servers registered for the turn callable, including state-changing `specrails_*` tools, so the mission can still drive the app.

#### Scenario: Claude keeps its MCP config

- **WHEN** a Claude mission turn is read-only
- **THEN** the `--mcp-config` arguments SHALL be passed unchanged and the turn SHALL NOT use plan mode or `--safe-mode`

#### Scenario: Gemini plan mode allows the registered servers

- **WHEN** a Gemini mission turn is read-only
- **THEN** a policy file that allows every registered MCP server only in plan mode SHALL be written in the conversation's `.gemini` directory with mode 0600
- **AND** it SHALL be passed with `--policy`
- **AND** server names that are not safe identifiers SHALL be omitted from the file

#### Scenario: Codex keeps its MCP overrides

- **WHEN** a Codex mission turn is read-only
- **THEN** the `-c mcp_servers.*` overrides SHALL be passed alongside the read-only sandbox

### Requirement: Core mission sessions carry a read-only policy

A mission on Core agent sessions SHALL send the adapter's declared read-only session mapping. A `tools` restriction SHALL only be sent to a driver that advertises `toolFiltering`. When no enforceable mapping exists, the previous mapping SHALL be kept.

#### Scenario: Claude on Core sessions

- **WHEN** a Claude mission opens a Core session with a tool-filtering driver
- **THEN** the policy SHALL contain `permissions: 'bypass'` and `tools: { mode: 'read-only' }`

#### Scenario: Codex on Core sessions

- **WHEN** a Codex mission opens a Core session
- **THEN** the policy SHALL contain `permissions: 'read-only'` and no `tools` restriction

#### Scenario: Driver without tool filtering

- **WHEN** the adapter's mapping needs a tool restriction and the driver lacks `toolFiltering`
- **THEN** the policy SHALL keep the adapter's previous `sessionPermissions` mapping without `tools`

### Requirement: Providers without a native read-only mode are explicit

A provider that does not advertise `read-only` in `capabilities.toolPolicies` SHALL keep its default mission behaviour. The gap SHALL be logged per turn and documented, never emulated with prompt wording alone.

#### Scenario: Kimi mission turn

- **WHEN** a Kimi mission turn spawns
- **THEN** the spawn SHALL NOT request `toolPolicy: 'read-only'`
- **AND** the turn log SHALL record `tools=default(unsupported)`

### Requirement: Read-only missions have a kill switch

`SPECRAILS_MISSION_READ_ONLY=false` SHALL restore the previous write-capable mission argv and Core session policy without a release. Any other value or no value SHALL keep missions read-only.

#### Scenario: Kill switch off

- **WHEN** `SPECRAILS_MISSION_READ_ONLY` is `false`
- **THEN** a Claude mission turn SHALL spawn with `--tools default`
- **AND** Core mission sessions SHALL use the adapter's previous `sessionPermissions` without `tools`
