## ADDED Requirements

### Requirement: Active local subscription scope
The system SHALL expose account-wide usage for the current host Claude and Codex subscription logins. It SHALL keep usage independent of project connections, budgets, job accounting and provider execution availability. Local engines and hidden providers SHALL NOT receive fabricated quota rows.

#### Scenario: Switching projects
- **WHEN** the active project changes while the same backend host and local account remain active
- **THEN** the usage snapshot remains available and no project ID or project accounting data is added to it

#### Scenario: Multiple connections share a login
- **WHEN** two configured connections use the same provider and resolved host auth context
- **THEN** both consume one cached account snapshot and one in-flight refresh

### Requirement: Authoritative read-only provider collection
The system SHALL use validated provider-reported data. Claude SHALL use the active context's OAuth credentials and usage endpoint; Codex SHALL use compatible app-server account and rate-limit read methods. Collection SHALL NOT start a prompt, thread or turn, modify credentials, refresh tokens explicitly, or change queue policy. Unsupported auth, CLI or platform SHALL produce explicit unavailable states.

#### Scenario: Codex probe succeeds
- **WHEN** a compatible authenticated app-server answers its account and rate-limit read requests
- **THEN** the system reports validated windows and closes only its owned probe without starting a turn

#### Scenario: API-key login
- **WHEN** the active login exposes no subscription allowance because it uses API-key authentication
- **THEN** the system reports unsupported-auth with no invented plan or consumption

#### Scenario: Unsupported CLI
- **WHEN** required read-only RPC methods are not supported
- **THEN** the system reports unsupported-cli without launching a PTY or paid prompt fallback

### Requirement: Preserve missing measurement semantics
Each usage window SHALL carry a stable ID, scope, nullable percentage, nullable duration and nullable ISO UTC reset time. Only finite percentages from 0 through 100 SHALL be numeric measurements. The system SHALL preserve additional validated provider/model windows and classify durations using metadata rather than response position. Plan SHALL be nullable and provider-reported.

#### Scenario: Genuine zero
- **WHEN** the provider explicitly reports a valid used percentage of zero
- **THEN** the normalized window reports 0 and the UI can render a 0% consumed value

#### Scenario: Missing or invalid field
- **WHEN** percentage is absent, NaN or outside the accepted range, or reset time is invalid
- **THEN** the affected field becomes null while independently valid fields remain available

#### Scenario: Additional or reordered windows
- **WHEN** weekly and session windows change order or a model-specific window is added
- **THEN** duration and scope determine labels and every validated window remains represented

### Requirement: Identity-safe ephemeral cache
Usage SHALL be cached in memory per host auth context and opaque account generation. Auth changes, sign-out and auth/permission failures SHALL clear old figures. Old-generation replies SHALL NOT replace current data. Network/server failures SHALL preserve only same-account verified snapshots without changing their observation timestamp. Restart SHALL begin with unknown freshness and empty measurements.

#### Scenario: Account switch during refresh
- **WHEN** account A's pending response arrives after the auth context changes to account B
- **THEN** A's response is discarded and its quota is not displayed for B

#### Scenario: Refresh fails transiently
- **WHEN** a same-account refresh fails due to network or provider server failure
- **THEN** the previous snapshot remains labeled stale with its original observedAt and a normalized issue code

#### Scenario: Sign-in expires
- **WHEN** the provider returns an authentication or permission failure
- **THEN** cached figures are cleared and automatic retries stop until explicit refresh or a relevant auth-context change

### Requirement: Bounded refresh lifecycle
The service SHALL deduplicate concurrent refreshes per auth context, enforce a minimum 30-second refresh interval, refresh at most two providers concurrently, honor retry backoff, and dispose owned subprocesses/listeners/timers on every terminal path. Automatic provider refresh SHALL be demand-driven at no more than once per 120 seconds per provider while a visible usage surface exists. Provider failures SHALL settle independently.

#### Scenario: Multiple windows refresh together
- **WHEN** multiple app windows or components request the same provider refresh concurrently
- **THEN** the server schedules one provider operation and subsequent requests join its state

#### Scenario: Provider throttles requests
- **WHEN** a provider responds with 429 and Retry-After
- **THEN** the service exposes retryAt and manual/automatic requests respect it with the defined minimum interval

#### Scenario: Probe hangs or shutdown begins
- **WHEN** a probe exceeds its deadline or the desktop server shuts down
- **THEN** its owned process tree is terminated, listeners and timers are removed, and unrelated jobs remain running

### Requirement: Explicit freshness
Snapshots SHALL become stale after five minutes without successful observation; a passed known reset time SHALL make the affected observation stale immediately. Local clocks SHALL NOT reset percentages to zero. Failed attempts SHALL NOT advance successful observation time.

#### Scenario: Reset passes offline
- **WHEN** the reset timestamp passes while no provider refresh succeeds
- **THEN** the measured usage stays unchanged and the interface requests confirmation by refresh

### Requirement: Global authenticated HTTP contract
The system SHALL provide authenticated machine-scoped GET `/api/subscription-usage` and POST `/api/subscription-usage/refresh` using existing desktop route/security conventions. GET SHALL return cached state without starting collection. POST SHALL accept only optional supported providerId, return 202 with snapshot/scheduling/retry information, and reject invalid input with 400. Responses and logs SHALL exclude tokens, credential paths, raw identity, provider response bodies and unredacted stderr.

#### Scenario: Snapshot read
- **WHEN** a client GETs usage without requesting refresh
- **THEN** cached normalized state is returned immediately without invoking provider effects

#### Scenario: Invalid refresh target
- **WHEN** a refresh request supplies an arbitrary provider, URL or credential path
- **THEN** validation returns 400 and performs no credential/network/process operation

#### Scenario: One provider fails
- **WHEN** Claude collection fails while Codex succeeds
- **THEN** the snapshot contains independent row outcomes and the refresh endpoint does not convert the provider failure to a global HTTP 500
