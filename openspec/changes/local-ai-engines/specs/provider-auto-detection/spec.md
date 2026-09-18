## MODIFIED Requirements

### Requirement: App-level provider detection singleton

The app SHALL maintain a single app-level detection service (`server/provider-detection.ts`) that probes every registered provider adapter for: binary presence on the resolved PATH, executable version, and authentication state — and, for every registered local (OpenAI-compatible) adapter, an HTTP `GET <baseUrl>/models` probe bounded at 3000 ms that yields `installed`/`executable`/`authState` plus the discovered `models`. Results SHALL be cached in memory for 60 seconds. The detected set SHALL exclude providers vetoed by their beta kill switches (`SPECRAILS_CODEX_BETA=0`, `SPECRAILS_GEMINI_BETA=0`) and SHALL exclude local adapters entirely when `SPECRAILS_LOCAL_ENGINES` is off, so consumers always see detected ∩ non-vetoed.

#### Scenario: Detection covers all registered adapters
- **WHEN** the detection service runs on a host with claude and gemini installed and codex/kimi absent
- **THEN** the detected set is `{ claude, gemini }` with per-provider `{ installed, executable, version, authState }`

#### Scenario: Beta veto filters detection
- **WHEN** gemini is installed but `SPECRAILS_GEMINI_BETA=0` is set
- **THEN** gemini is absent from the detected set exposed to all consumers

#### Scenario: Cache prevents repeated probing
- **WHEN** two detection reads happen within 60 seconds
- **THEN** the second read returns the cached result without spawning probe processes

#### Scenario: Reachable local connection is detected
- **WHEN** a `local` connection answers `GET /v1/models` with 200 and a `data` array
- **THEN** the detected set includes `local` with `{ installed: true, executable: true, authState: 'authenticated', kind: 'local', models: [...] }`

#### Scenario: Unauthorized local connection stays listed
- **WHEN** the probe answers 401
- **THEN** `local` is detected with `authState: 'unauthenticated'` and the UI shows the not-signed-in badge

#### Scenario: Unreachable local connection is excluded
- **WHEN** the probe times out or refuses the connection
- **THEN** `local` reports `installed: false` and is absent from the detected set
