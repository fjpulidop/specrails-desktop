## MODIFIED Requirements

### Requirement: Login-shell recovery is scoped and refreshable
On macOS/Linux, Desktop SHALL recover missing or empty configured names using the explicit shell, or the account login shell when SHELL is absent.

The probe SHALL run asynchronously:

- when the project is opened;
- when its configured names change;
- before a successful cached result expires.

Its timeout SHALL be 10 seconds by default, overridable with `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS`. Spawn-time resolution SHALL use the cached result. It MAY run a synchronous probe bounded at 1.5 seconds only when no cached result exists.

A probe SHALL accept values from a complete sentinel block regardless of the shell's exit status. Successful recoveries SHALL be cached for at most 10 minutes. Failed or empty lookups SHALL be retried after at most 30 seconds. Non-empty explicit source values SHALL take precedence. Windows SHALL retain inherited-environment behavior without login-shell recovery.

#### Scenario: GUI launch without SHELL
- **WHEN** Desktop lacks SHELL and the account login shell exposes a configured value
- **THEN** Desktop probes that shell and passes the recovered value to the project execution

#### Scenario: Slow interactive profile
- **WHEN** the login shell takes 4 seconds to start and defines `NODE_AUTH_TOKEN`, and Desktop was launched from the Dock
- **THEN** the asynchronous probe recovers the value, and later rail and verification spawns receive it without Desktop being launched from a terminal

#### Scenario: Profile exits non-zero after printing
- **WHEN** the probe output contains the complete sentinel block with the value and the shell exits with status 1
- **THEN** the value is recovered and the non-zero status is recorded only as a diagnostic

#### Scenario: Profile becomes available after a failed lookup
- **WHEN** a probe fails or returns no value and a later probe after the retry window succeeds
- **THEN** subsequent execution receives the value without restarting Desktop

#### Scenario: Credential refresh
- **WHEN** an explicit source value changes or a cached shell value expires
- **THEN** the next resolution uses the current explicit value or the refreshed shell result

## ADDED Requirements

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
