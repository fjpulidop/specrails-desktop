## ADDED Requirements

### Requirement: Projects control whether agents may use sub-agents
Each project SHALL have an "Allow sub-agents" setting, disabled by default, that applies to every conversational surface of that project (missions, explore and refinements) and not to Implement pipelines; missions without a project SHALL use an app-global setting with the same default.

#### Scenario: Default project
- **WHEN** a mission starts in a project whose setting was never changed
- **THEN** the Core session MUST be opened with sub-agents disabled

#### Scenario: Enabled project
- **WHEN** the project setting is enabled
- **THEN** missions, explore and refinement sessions of that project MUST be opened with sub-agents enabled

#### Scenario: Implement pipelines
- **WHEN** an Implement pipeline runs in a project with the setting enabled or disabled
- **THEN** its execution MUST NOT be affected by this setting

#### Scenario: Mission without a project
- **WHEN** a mission has no pinned project
- **THEN** the app-global setting MUST decide its sub-agent policy

### Requirement: The policy is enforced, not suggested
Desktop SHALL deliver the resolved policy to Core as session policy and SHALL surface an error when a provider cannot enforce it, rather than relying on prompt instructions.

#### Scenario: Unenforceable provider
- **WHEN** Core rejects a session because the provider cannot enforce the requested policy
- **THEN** the mission MUST show an actionable error naming the provider and the setting

### Requirement: Changing the setting applies safely to running sessions
Changing the setting SHALL update open sessions of that scope through Core at a safe boundary and SHALL NOT terminate running sub-agents implicitly.

#### Scenario: Disabled while sub-agents run
- **WHEN** the user disables the setting while a mission has live sub-agents
- **THEN** the change MUST be reported as deferred in that mission
- **AND** the user MUST be offered to stop the agents and apply it now

### Requirement: The setting is visible and localized
The setting SHALL appear in project settings, and the global setting in app settings, with an explanation of cost and behaviour in all 8 locales. It SHALL be readable and writable through the project and app settings APIs, and readable (never writable) through the Specrails MCP settings surface, so that an agent cannot grant itself sub-agents.

#### Scenario: Settings API
- **WHEN** a client reads project settings
- **THEN** the response MUST include `allowSubagents` with its effective value

#### Scenario: MCP cannot grant sub-agents
- **WHEN** an MCP client reads app settings
- **THEN** the response MUST report the app-wide setting and, when a project is given, that project's setting
- **AND** no MCP action MUST be able to change either setting

### Requirement: Users choose who runs sub-agents
The Sub-agents settings SHALL let the user keep sub-agents native ("Same as the mission agent", the default) or choose a provider, model and effort. A choice that differs from a mission's provider SHALL make Specrails launch that mission's sub-agents itself.

#### Scenario: Untouched configuration
- **WHEN** sub-agents are allowed and the runtime setting was never changed
- **THEN** missions MUST run native sub-agents with the provider's defaults

#### Scenario: Same provider as the mission
- **WHEN** the chosen provider equals the mission's provider
- **THEN** the mission MUST run native sub-agents with the chosen model and effort

#### Scenario: Different provider
- **WHEN** the chosen provider differs from the mission's provider
- **THEN** the mission MUST run delegated sub-agents on the chosen provider, model and effort
- **AND** the mission agent's native sub-agent tool MUST be disabled

#### Scenario: Confirmation before leaving native launching
- **WHEN** the user selects a specific provider for sub-agents
- **THEN** a confirmation dialog MUST explain that launching stops being native when the providers differ, with its cache and speed cost, in exchange for more control
- **AND** cancelling MUST keep the previous setting

#### Scenario: Only applicable overrides are offered
- **WHEN** a provider cannot apply a sub-agent effort (e.g. Claude)
- **THEN** the settings MUST NOT offer an effort for it in native mode

