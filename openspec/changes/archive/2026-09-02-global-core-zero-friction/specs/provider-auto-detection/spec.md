# provider-auto-detection

## ADDED Requirements

### Requirement: App-level provider detection singleton

The app SHALL maintain a single app-level detection service (`server/provider-detection.ts`) that probes every registered provider adapter for: binary presence on the resolved PATH, executable version, and authentication state. Results SHALL be cached in memory for 60 seconds. The detected set SHALL exclude providers vetoed by their beta kill switches (`SPECRAILS_CODEX_BETA=0`, `SPECRAILS_GEMINI_BETA=0`), so consumers always see detected ∩ non-vetoed.

#### Scenario: Detection covers all registered adapters
- **WHEN** the detection service runs on a host with claude and gemini installed and codex/kimi absent
- **THEN** the detected set is `{ claude, gemini }` with per-provider `{ installed, executable, version, authState }`

#### Scenario: Beta veto filters detection
- **WHEN** gemini is installed but `SPECRAILS_GEMINI_BETA=0` is set
- **THEN** gemini is absent from the detected set exposed to all consumers

#### Scenario: Cache prevents repeated probing
- **WHEN** two detection reads happen within 60 seconds
- **THEN** the second read returns the cached result without spawning probe processes

### Requirement: Auth state is probed, bounded, and degradable

Each provider probe SHALL report `authState: 'authenticated' | 'unauthenticated' | 'unknown'` using an offline, provider-specific check (kimi's existing readiness/auth probe; codex auth file presence; claude credential heuristic; `gh auth token`-style exit-code pattern where applicable). Every probe MUST be timeout-bounded at 1500 ms; a timeout or probe error SHALL degrade to `authState: 'unknown'` with the provider still listed as installed — never an exclusion.

#### Scenario: Unauthenticated provider still offered
- **WHEN** codex is installed but has no auth credentials
- **THEN** codex appears in the detected set with `authState: 'unauthenticated'`
- **AND** UI surfaces render a "not signed in" badge instead of hiding the provider

#### Scenario: Hung probe degrades
- **WHEN** a provider's auth probe exceeds 1500 ms
- **THEN** the probe is abandoned and the provider reports `authState: 'unknown'`

### Requirement: Detection refresh triggers

Detection SHALL refresh (cache-bypassing) on: server startup, project registration (`POST /api/projects`), and an explicit client request `GET /api/providers/detected?refresh=1`. The client SHALL issue the refresh request on window focus, throttled to the 60-second cache window. When a refresh produces a different detected set than the previous one, the server SHALL broadcast an app-global WebSocket message `providers.detected_changed` carrying the new set (no `projectId`).

#### Scenario: Window focus after installing a CLI
- **WHEN** the user installs codex in a terminal and refocuses the app window after the cache expired
- **THEN** the client requests a refresh, the server detects codex, and `providers.detected_changed` is broadcast

#### Scenario: Unchanged set broadcasts nothing
- **WHEN** a refresh produces an identical detected set
- **THEN** no `providers.detected_changed` message is broadcast

### Requirement: Every project offers the full detected set

Provider availability SHALL be a property of the machine, not the project. `resolveProvider` / `validateRequestedProvider` SHALL validate requested engines against the current detected set instead of the project row's `providers` column. The `projects.providers` column SHALL be retained for wire compatibility and reported as the detected set on read, but SHALL NOT gate any behavior.

#### Scenario: New provider available everywhere immediately
- **WHEN** kimi becomes detected on a machine with three existing projects
- **THEN** all three projects accept `aiEngine: 'kimi'` on their invocation routes without any per-project mutation

#### Scenario: Legacy client reads providers field
- **WHEN** an existing client (or the mobile app) reads a project row
- **THEN** the `providers` field contains the current detected set

### Requirement: Primary provider is derived with stability

Each project's primary/default provider SHALL be derived: the stored `provider` if it is still detected; otherwise claude if detected; otherwise the first detected provider in the fixed order `[claude, codex, gemini, kimi]`. When a stored engine reference (project primary, `rails.ai_engine`, `chat_conversations.provider`) names an undetected provider at spawn time, the spawn SHALL fall back to the derived primary and surface a subtle non-blocking notice — never fail the spawn on that ground alone.

#### Scenario: Stored primary survives while detected
- **WHEN** a project's stored primary is codex and codex remains detected
- **THEN** the derived primary is codex even though claude is also installed

#### Scenario: Disappeared provider falls back
- **WHEN** a rail's stored `ai_engine` is gemini and gemini is no longer detected
- **THEN** the launch proceeds with the derived primary and a non-blocking notice names the substitution

#### Scenario: Nothing detected
- **WHEN** no provider CLI is detected
- **THEN** provider-dependent actions surface a clear "no AI provider detected" state and project registration still succeeds

### Requirement: Newly detected providers trigger lazy workspace assembly

When detection adds a provider that a relocated project's workspace has not been assembled for, the app SHALL assemble that provider's workspace surface in the background (bundled framework, offline) before or upon the first spawn requesting that provider. Assembly failure SHALL degrade to the previously assembled providers with a warning, never block the project.

#### Scenario: Install codex after projects exist
- **WHEN** codex becomes detected and the user launches a codex invocation on an existing project
- **THEN** the workspace's codex surface (`.codex/`, `AGENTS.md`, MCP registration) exists by spawn time, assembled without any user action
