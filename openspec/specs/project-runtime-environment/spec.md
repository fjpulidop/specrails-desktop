# project-runtime-environment Specification

## Purpose
Define how Desktop resolves project-configured environment names for multi-repository rails and retained runtime controls, including bounded shell recovery and credential isolation.
## Requirements
### Requirement: Project environment inheritance spans admitted repositories
Desktop SHALL resolve names configured on the owning project into the environment used by rail agents and host verification in every admitted repository and workspace.

#### Scenario: Parent project with multiple repositories
- **WHEN** a project containing two repositories configures NODE_AUTH_TOKEN and a rail verifies both isolated worktrees
- **THEN** both verification processes receive its resolved value without per-repository configuration

### Requirement: Login-shell recovery is scoped and refreshable
On macOS/Linux, Desktop SHALL recover missing or empty configured names using the explicit shell or the account login shell when SHELL is absent. It MUST bound probes, expire cached results within 30 seconds, and retry failed or empty lookups after expiry. Non-empty explicit source values SHALL take precedence. Windows SHALL retain inherited-environment behavior without login-shell recovery.

#### Scenario: GUI launch without SHELL
- **WHEN** Desktop lacks SHELL and the account login shell exposes a configured value
- **THEN** Desktop probes that shell and passes the recovered value to the project execution

#### Scenario: Profile becomes available after a failed lookup
- **WHEN** a probe fails or returns no value and a later probe after cache expiry succeeds
- **THEN** subsequent execution receives the value without restarting Desktop

#### Scenario: Credential refresh
- **WHEN** an explicit source value changes or a cached shell value expires
- **THEN** the next resolution uses the current explicit value or refreshes the shell result

### Requirement: Recovered credentials remain project scoped
Recovered values MUST NOT be added to the server's global process environment or persisted in project settings and runtime metadata. Only currently configured names SHALL be returned from a project's recovery cache.

#### Scenario: Unrelated project
- **WHEN** one project recovers a credential absent from process.env and another project does not configure that name
- **THEN** the second project's spawn environment does not acquire that credential

#### Scenario: Configured name removed
- **WHEN** a configured name is removed while its shell result is cached
- **THEN** subsequent spawns no longer receive that recovered value

### Requirement: Retained runtime controls restore project environment
Desktop SHALL apply current project environment resolution when reconstructing retained runtime controls while preserving the frozen host identity and worktree scope.

#### Scenario: Resume or scoped recovery after restart
- **WHEN** a retained run is resumed or recovered and its configured credential is available only from the login shell
- **THEN** the control's subprocess receives the resolved credential and saved runtime metadata contains no credential value
