# global-plugin-center Specification

## Purpose

Provide a global plugin center that hosts both global plugins and project-local plugins, including transparent Headroom AI installation/activation and guided recovery when install or activation fails.

## Requirements

### Requirement: Global Plugins navigation

The app SHALL expose a `Plugins` entry in the left sidebar immediately below `Loops` in both Board and Mission modes.

#### Scenario: Board mode opens plugin route
- **WHEN** the user clicks `Plugins` in Board mode
- **THEN** the app navigates to `/plugins`
- **AND** the content renders outside the project layout.

#### Scenario: Mission mode opens plugin modal
- **WHEN** the user clicks `Plugins` in Mission mode
- **THEN** the app opens a large modal containing the plugin center
- **AND** the active mission surface remains behind the modal.

### Requirement: Integration sidebar migration

The app SHALL remove project `Integrations` from the right sidebar and represent Jira and Serena in the global plugin center as project-scoped plugins.

#### Scenario: Legacy integrations route redirects
- **WHEN** the user navigates to `/integrations`
- **THEN** the app redirects to `/plugins`.

### Requirement: Plugin catalog scopes

The plugin center SHALL visually distinguish global plugins from project plugins and expose search/filter controls.

#### Scenario: Catalog lists scopes
- **WHEN** the plugin center loads
- **THEN** Headroom AI appears as a global plugin
- **AND** Jira and Serena appear as project plugins.

### Requirement: Project plugin wizard

Project plugins SHALL require a target project selection before installation or configuration.

#### Scenario: Jira wizard selects project
- **WHEN** the user chooses setup for Jira
- **THEN** the plugin center asks for a project
- **AND** continues into the existing Jira connection flow for that project.

#### Scenario: Serena wizard selects project
- **WHEN** the user chooses install for Serena
- **THEN** the plugin center asks for a project
- **AND** continues into the existing Serena project plugin install flow for that project.

### Requirement: Headroom transparent install

Specrails SHALL install Headroom AI as a global plugin using bundled `uv` and a Specrails-owned tool directory.

#### Scenario: Headroom install succeeds
- **WHEN** the user clicks install for Headroom AI
- **THEN** Specrails runs bundled `uv tool install "headroom-ai[all]"`
- **AND** stores the executable in a Specrails-owned bin directory
- **AND** marks Headroom installed only after `headroom --version` succeeds.

#### Scenario: Install failure is guided
- **WHEN** Headroom installation fails
- **THEN** the response includes a structured error code, human guidance, retry action, and diagnostics details.

### Requirement: Headroom per-platform activation

Headroom activation SHALL be independent for Codex and Claude.

#### Scenario: Activate Codex
- **GIVEN** Headroom is installed
- **WHEN** the user activates Codex
- **THEN** Specrails ensures a healthy Headroom proxy
- **AND** routes Codex spawns with `OPENAI_BASE_URL`
- **AND** marks Codex active only after verification succeeds.

#### Scenario: Activate Claude
- **GIVEN** Headroom is installed
- **WHEN** the user activates Claude
- **THEN** Specrails ensures a healthy Headroom proxy
- **AND** routes Claude spawns with `ANTHROPIC_BASE_URL`
- **AND** marks Claude active only after verification succeeds.

### Requirement: Activation rollback and diagnostics

Activation failures SHALL be recoverable and SHALL NOT leave a provider falsely marked active.

#### Scenario: Proxy port busy
- **WHEN** activation fails because the proxy port is busy
- **THEN** the user can choose another port or retry
- **AND** the provider remains inactive.

#### Scenario: Partial activation
- **WHEN** activation mutates provider state but verification fails
- **THEN** Specrails attempts rollback
- **AND** reports whether rollback succeeded.

### Requirement: Bundled uv runtime

Specrails desktop builds SHALL bundle `uv` as a first-class runtime.

#### Scenario: Bundled uv satisfies prerequisites
- **GIVEN** a desktop build with bundled runtimes
- **WHEN** setup prerequisites check for `uv`
- **THEN** the bundled `uv` binary is accepted as installed and executable.

#### Scenario: Runtime smoke checks uv
- **WHEN** bundled runtime smoke tests run
- **THEN** `uv --version` is executed successfully.
