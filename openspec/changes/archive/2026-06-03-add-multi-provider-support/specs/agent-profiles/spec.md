## ADDED Requirements

### Requirement: Profile carries an optional provider identifier

The profile schema SHALL accept an optional top-level `provider: string` field. When present, the value MUST be the id of a provider registered in `providerRegistry`. When absent, the profile MUST resolve, at consumption time, to the provider of the project where it is loaded.

#### Scenario: Profile with explicit provider
- **WHEN** a profile JSON contains `"provider": "codex"`
- **THEN** schema validation accepts the profile
- **AND** `ProfileManager.resolveProfile` returns a profile whose `provider === 'codex'` regardless of the project's provider

#### Scenario: Profile without provider inherits from project
- **WHEN** a profile JSON omits `provider`
- **AND** the consuming project's `provider === 'codex'`
- **THEN** `ProfileManager.resolveProfile` returns the profile with `provider: 'codex'` materialised in-memory (not written back to disk)

#### Scenario: Profile referencing unregistered provider is rejected
- **WHEN** a profile JSON contains `"provider": "ghost"` and no `ghost` adapter is registered
- **THEN** the profile validation fails with an error naming the unknown provider id

### Requirement: Baseline agents resolved via the provider adapter

`ProfileManager.validateStructural` SHALL no longer assume a hardcoded list of baseline agent ids. Instead, it MUST call `getAdapter(profile.provider).baselineAgents()` and assert that every id returned is present in the profile's `agents[].id` set.

#### Scenario: Codex profile passes baseline check using codex adapter
- **GIVEN** `codexAdapter.baselineAgents()` returns the same `['sr-architect','sr-developer','sr-reviewer','sr-merge-resolver']` set
- **WHEN** a profile with `provider: 'codex'` and all four agents in its chain is validated
- **THEN** the validation succeeds

#### Scenario: Future provider with a different baseline
- **GIVEN** a hypothetical adapter whose `baselineAgents()` returns `['sr-developer']`
- **WHEN** a profile with that provider id and only `sr-developer` in its chain is validated
- **THEN** the validation succeeds even though `sr-architect` is missing

#### Scenario: Hardcoded baseline list is removed from validation code
- **WHEN** the source of `validateStructural` in `server/modules/agents/runtime/profile-manager.ts` is inspected
- **THEN** it contains no hardcoded array of agent ids
- **AND** the baseline assertion is driven exclusively by the adapter's `baselineAgents()` call

## MODIFIED Requirements

### Requirement: Schema validation on every write

The hub SHALL validate every profile write against the v1 JSON schema shipped by specrails-core, plus a runtime structural check that consults the active provider adapter for model and baseline agent constraints. Writes that fail either validation SHALL be rejected before hitting disk.

The JSON schema MUST NOT enumerate the allowed values of `ProfileAgent.model` (the previous `enum: ['sonnet', 'opus', 'haiku']` constraint is removed). Instead, runtime validation MUST assert that `ProfileAgent.model ∈ getAdapter(profile.provider).modelCatalog().map(m => m.value)`. The orchestrator model is constrained identically.

#### Scenario: Invalid schemaVersion rejected
- **WHEN** a profile body with `schemaVersion: 2` is POSTed
- **THEN** the endpoint returns HTTP 400 with the validation error and no file is written

#### Scenario: Missing required field rejected
- **WHEN** a profile body missing `agents` is POSTed
- **THEN** the endpoint returns HTTP 400 identifying the missing field

#### Scenario: Codex model accepted for codex profile
- **WHEN** a profile body has `provider: 'codex'` and an agent entry with `model: 'gpt-5.4-mini'`
- **THEN** the runtime structural check accepts the model because `gpt-5.4-mini` is in `codexAdapter.modelCatalog()`
- **AND** the file is written

#### Scenario: Cross-provider model rejected
- **WHEN** a profile body has `provider: 'claude'` and an agent entry with `model: 'gpt-5.4-mini'`
- **THEN** the runtime structural check rejects the profile with an error naming the agent id, the rejected model value, and the allowed list from `claudeAdapter.modelCatalog()`
- **AND** no file is written

#### Scenario: Profile referencing unregistered model rejected
- **WHEN** a profile body has `provider: 'claude'` and `model: 'claude-vintage-2'` somewhere in its chain
- **THEN** the structural check rejects the profile with the allow-list of registered claude models

### Requirement: Snapshot-per-job

The hub SHALL write a snapshot of the resolved profile to `~/.specrails/projects/<slug>/jobs/<jobId>/profile.json` before spawning a rail. The snapshot SHALL be chmod-400. The snapshot path SHALL be referenced via the `SPECRAILS_PROFILE_PATH` environment variable injected into the spawned process when, and only when, the resolved adapter declares `capabilities.profileEnvSupport === true`.

#### Scenario: Snapshot written before spawn (Claude)
- **WHEN** `QueueManager` starts a rail in a claude project with resolved profile `data-heavy`
- **THEN** the byte contents of `.specrails/profiles/data-heavy.json` are copied to `~/.specrails/projects/<slug>/jobs/<jobId>/profile.json` before the `claude` process starts

#### Scenario: Snapshot written before spawn (Codex)
- **WHEN** `QueueManager` starts a rail in a codex project with resolved profile `default`
- **THEN** the snapshot is written to the same path under the codex project's slug
- **AND** `codexAdapter.capabilities.profileEnvSupport === true` so the env var is injected (see next scenario)

#### Scenario: Env var injected when adapter supports it
- **WHEN** `QueueManager` spawns the rail and `adapter.capabilities.profileEnvSupport === true`
- **THEN** the spawned process environment contains `SPECRAILS_PROFILE_PATH=/abs/path/to/job-snapshot.json`

#### Scenario: Env var omitted when adapter does not support it
- **WHEN** the adapter's `capabilities.profileEnvSupport === false`
- **THEN** the snapshot is still written (for analytics) but `SPECRAILS_PROFILE_PATH` is NOT injected
- **AND** the rail runs in legacy fallback (no per-agent routing)

#### Scenario: Snapshot immutability
- **WHEN** a running rail's snapshot file is attempted to be modified
- **THEN** the filesystem permission prevents writes (chmod 400)

### Requirement: Legacy fallback when provider runtime is too old

The hub SHALL NOT inject `SPECRAILS_PROFILE_PATH` into a rail spawn when the project's installed specrails-core version is below the minimum required for the profile-aware pipeline of that provider. For the claude provider this minimum is 4.1.0 (unchanged). For the codex provider the minimum is 4.6.0 (the version that ships codex rail skills consuming the snapshot). When the env var is suppressed, the rail SHALL spawn in legacy fallback and a UI banner SHALL prompt the user to upgrade.

#### Scenario: Claude project with core 4.0.x launches rail
- **WHEN** the project's installed specrails-core is 4.0.8 AND the user launches a rail
- **THEN** `QueueManager` spawns `claude` WITHOUT `SPECRAILS_PROFILE_PATH` (legacy behavior)
- **AND** the Agents tab shows an upgrade banner

#### Scenario: Claude project with core 4.1.0+ launches rail
- **WHEN** the project's installed specrails-core is 4.1.0 or newer AND a profile is selected
- **THEN** `QueueManager` injects `SPECRAILS_PROFILE_PATH` pointing at the snapshot

#### Scenario: Codex project with core 4.5.x launches rail
- **WHEN** the project's installed specrails-core is 4.5.0 AND the user launches a codex rail
- **THEN** `QueueManager` spawns `codex` WITHOUT `SPECRAILS_PROFILE_PATH`
- **AND** the Agents tab shows an upgrade banner targeting the codex minimum (4.6.0)

#### Scenario: Codex project with core 4.6.0+ launches rail
- **WHEN** the project's installed specrails-core is 4.6.0 or newer AND a profile is selected
- **THEN** `QueueManager` injects `SPECRAILS_PROFILE_PATH` pointing at the snapshot
