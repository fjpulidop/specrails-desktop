## ADDED Requirements

### Requirement: The `roles` rail engine launches without flattening the per-role runtime config
A rail whose engine is the sentinel `roles` SHALL launch with no `runtimeProviderOverride`, so Core runs architect, developer and reviewer on the providers and models named per role in the project's runtime configuration. `PUT /rails/:railIndex/engine` and the launch body SHALL accept `aiEngine: 'roles'`. A roles launch that carries an explicit `runtimeProviderOverride` SHALL be rejected with `400 runtime_provider_mismatch`; a roles launch in `freestyle` mode SHALL be rejected with `400 roles_engine_unsupported_mode`.

#### Scenario: Roles engine persisted on a rail
- **WHEN** `PUT /rails/0/engine { aiEngine: 'roles' }`
- **THEN** the rail's `aiEngine` is `roles`

#### Scenario: Freestyle has no roles
- **WHEN** a rail on `roles` launches with `mode: 'freestyle'`
- **THEN** the response is `400 { error: 'roles_engine_unsupported_mode' }` and nothing spawns

### Requirement: Loop roles are stored per project and resolved at launch
The app SHALL persist optional `verifier` and `decider` role engines (`{ provider, model?, effort? }`) in `<workspace>/.specrails/loop-role-engines.json`, exposed as `GET/PUT /:projectId/agent-runtime/loop-roles`. Validation SHALL reject unknown roles, undetected providers, models invalid for the provider and malformed efforts. Under a `roles` launch the loop's provider/model/effort SHALL come from the verifier role and the Loop Decider SHALL run on the decider role; an absent role, or a role whose provider is no longer detected, SHALL fall back to the rail's primary engine; a stale model SHALL fall back to the adapter default and an effort the adapter cannot honour SHALL be dropped. The decider provider MUST support a read-only tool policy.

#### Scenario: Decider on a cheaper engine
- **WHEN** loop roles hold `decider: { provider: 'codex', model: 'gpt-5.4-mini' }` and the rail launches on `roles`
- **THEN** every `runDecider` call receives `provider: 'codex', model: 'gpt-5.4-mini'` while ai-steps keep the verifier engine

#### Scenario: Stale role falls back
- **WHEN** the decider role names a provider that is not detected any more
- **THEN** the Decider runs on the rail's primary engine and the launch is not blocked
