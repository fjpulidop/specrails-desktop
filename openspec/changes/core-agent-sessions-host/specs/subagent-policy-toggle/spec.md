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
The setting SHALL appear in project settings, and the global setting in app settings, with an explanation of cost and behaviour in all 8 locales, and SHALL be exposed through the project settings API and the Specrails MCP settings surface.

#### Scenario: Settings API
- **WHEN** a client reads project settings
- **THEN** the response MUST include `allowSubagents` with its effective value
