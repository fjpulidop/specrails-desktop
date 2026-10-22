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
On macOS/Linux, Desktop SHALL recover missing or empty configured names from the explicit shell, or the account login shell when SHELL is absent. The probe SHALL run asynchronously on project open, on configured-name changes and before a cached success expires, timing out after 10 s by default (`SPECRAILS_LOGIN_SHELL_TIMEOUT_MS`). Spawns SHALL use the cached result; a synchronous 1.5 s probe is allowed only without one. Windows keeps inherited-environment behavior.

#### Scenario: GUI launch without SHELL
- **WHEN** Desktop lacks SHELL and the account login shell exposes a configured value
- **THEN** Desktop probes that shell and passes the recovered value to the project execution

#### Scenario: Slow interactive profile
- **WHEN** the login shell takes 4 seconds to start and defines `NODE_AUTH_TOKEN`, and Desktop was launched from the Dock
- **THEN** the asynchronous probe recovers the value, and later rail and verification spawns receive it without Desktop being launched from a terminal

### Requirement: Login-shell probe results are cached and retried
A probe SHALL accept values from a complete sentinel block regardless of the shell's exit status. Successful recoveries SHALL be cached for at most 10 minutes, failed or empty lookups SHALL be retried after at most 30 seconds, and non-empty explicit source values SHALL take precedence.

#### Scenario: Profile exits non-zero after printing
- **WHEN** the probe output contains the complete sentinel block with the value and the shell exits with status 1
- **THEN** the value is recovered and the non-zero status is recorded only as a diagnostic

#### Scenario: Profile becomes available after a failed lookup
- **WHEN** a probe fails or returns no value and a later probe after the retry window succeeds
- **THEN** subsequent execution receives the value without restarting Desktop

#### Scenario: Credential refresh
- **WHEN** an explicit source value changes or a cached shell value expires
- **THEN** the next resolution uses the current explicit value or the refreshed shell result

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

### Requirement: Configured names expose a resolution status
For each configured name, Desktop SHALL keep a status in the owning project's memory: `inherited`, `recovered`, `not-defined`, `probe-timeout` or `probe-failed`, together with the shell path used and the time of the last check. A project route SHALL return these statuses, and a companion route SHALL trigger an immediate recheck. Responses, logs and MCP output MUST NOT contain values.

#### Scenario: Status after a timeout
- **WHEN** the probe for `NODE_AUTH_TOKEN` exceeds its timeout
- **THEN** the status route reports `{ name: 'NODE_AUTH_TOKEN', status: 'probe-timeout' }` with the shell path and check time, and no value

#### Scenario: Recheck
- **WHEN** the user requests a recheck after fixing the profile
- **THEN** Desktop probes immediately, and the route reports `recovered`

### Requirement: Project settings show environment resolution
The Project environment section SHALL show each configured name's status, with a localized explanation, and a "Check again" action. All shipped locales SHALL contain the strings.

#### Scenario: Name not defined in the shell
- **WHEN** a configured name has status `not-defined`
- **THEN** the section marks it as unresolved and explains that the login shell does not export it

### Requirement: Runs report unresolved configured names
When a rail, loop or queued job spawns with a configured name that is unresolved, Desktop SHALL write one warning line to that run's log naming the variable and its status. The value MUST NOT be printed.

#### Scenario: Run starts without the token
- **WHEN** a rail launches while `NODE_AUTH_TOKEN` has status `probe-failed`
- **THEN** the run log contains a warning naming `NODE_AUTH_TOKEN` and `probe-failed`, and the run proceeds
