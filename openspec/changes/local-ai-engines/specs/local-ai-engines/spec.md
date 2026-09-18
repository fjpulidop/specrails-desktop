## ADDED Requirements

### Requirement: Local connections are registered provider adapters
For every `openai-compatible` connection in `~/.specrails/runtime-providers.json`, the app SHALL register a `ProviderAdapter` whose `id` equals the connection id, built by `createLocalAdapter(connection)` (`server/providers/local-adapter.ts`). Registration SHALL run at boot after the connections load and again after every successful `PUT /api/runtime-providers`; connections removed by the save SHALL be unregistered. A connection id that collides with a registered CLI adapter id MUST be rejected by validation.

#### Scenario: Connection becomes an adapter at boot
- **WHEN** the server boots with a `local` openai-compatible connection configured
- **THEN** `hasAdapter('local')` is true and `getAdapter('local').id === 'local'`

#### Scenario: Saving connections re-syncs the registry
- **WHEN** `PUT /api/runtime-providers` removes `local` and adds `lan-box`
- **THEN** `hasAdapter('local')` is false, `hasAdapter('lan-box')` is true, and in-flight jobs that resolved `local` keep their adapter instance

#### Scenario: Reserved id rejected
- **WHEN** a save contains `{ id: 'claude', kind: 'openai-compatible', baseUrl }`
- **THEN** the save fails with a validation error naming the reserved id

### Requirement: Local adapters advertise honest capabilities
A local adapter SHALL advertise `persistentStdin: true`, `nativeResume: true`, `nativeStreamJson: true`, `freestyle: true`, `customModelAliases: true`, `toolPolicies: ['none', 'read-only']`, `supportsImageInput: false`, and SHALL advertise `nativeCostUsd: false`, `nativeOtelEnv: false`, `structuredActions: false`, `profiles: false`, `customRoles: false`, `userMcp: false`, `supportsReasoningEffort: false` (unless the connection sets `supportsReasoningEffort: true`). `instructionsFilename` SHALL be `AGENTS.md`, `projectDirName` SHALL be `.specrails-local`.

#### Scenario: Capability-gated surfaces exclude local engines
- **WHEN** a local engine is the selected provider in Add Spec
- **THEN** SMASH / Contract Layer controls are hidden by the existing `structuredActions` gate and Explore/Quick remain available

#### Scenario: Profiles are not offered
- **WHEN** a rail's engine is a local id
- **THEN** the rail profile selector renders the legacy (no-profile) state and no `SPECRAILS_PROFILE_PATH` is injected

### Requirement: Model catalog is discovered from the endpoint
`modelCatalog()` of a local adapter SHALL return the models discovered by the most recent successful probe of that connection (`GET <baseUrl>/models`, `data[].id`), ordered as returned, with `default` marking the connection's stored `defaultModel` (else the first). When no probe has succeeded the catalog SHALL be `[{ value: defaultModel ?? 'default', label }]` so selectors never render empty. Off-catalog values SHALL be accepted through `customModelAliases`.

#### Scenario: Discovered models populate selectors
- **WHEN** the probe returns `qwen3.5-9b:latest` and `hf.co/x/y:Q5_K_M`
- **THEN** `GET /api/projects/:id/default-spec-model?provider=local` lists both and marks the stored default

#### Scenario: Unprobed connection has a placeholder catalog
- **WHEN** a connection has never been probed successfully and has `defaultModel: 'qwen3.5-9b:latest'`
- **THEN** the catalog is exactly one entry with that value

### Requirement: Local engines are selectable on every provider surface
A detected local connection SHALL be part of `project.providers` for every project and therefore selectable in the rail engine selector, Add Spec Quick/Explore engine selector, the sidebar chat engine selector, the agent-chat provider bar and the mission provider selector, using the existing multi-provider gating (selectors render when the detected set has more than one entry). `validateRequestedProvider` SHALL accept a local id that is in the detected set and reject one that is not, with the existing "not installed" error shape.

#### Scenario: Rail header offers the local engine
- **WHEN** claude and `local` are detected
- **THEN** `RailEngineSelector` lists `claude` and `local`, and `PUT /rails/:i/engine { aiEngine: 'local' }` is stored

#### Scenario: Unreachable connection is not selectable
- **WHEN** the `local` probe failed in the last detection cycle
- **THEN** `POST /spawn { aiEngine: 'local' }` returns 400 with the "not installed for this project" error

### Requirement: Rails run on a local engine
Launching a rail whose engine is a local id SHALL map `runtimeProviderOverride` to `{ provider: <id>, model }` (effort dropped) so core's programmatic runtime runs architect/developer/reviewer through its OpenAI-compatible executor; every non-core AI step (freestyle, verify/fix/decider, custom loop ai-steps, legacy QueueManager jobs) SHALL spawn the local agent runner through the adapter. The `runtime_provider_mismatch` guard SHALL treat local ids like CLI ids. `maxCostUsd` limits SHALL NOT be offered for local engines.

#### Scenario: Implement rail on local engine
- **WHEN** `POST /rails/:i/launch { aiEngine: 'local', model: 'qwen3.5-9b:latest' }` on a project with the programmatic runtime
- **THEN** the effective runtime config assigns provider `local` and that model to all three roles, and the job record shows `provider: 'local'`

#### Scenario: Freestyle rail on local engine
- **WHEN** a freestyle rail launches with `aiEngine: 'local'`
- **THEN** the ai-step spawns the runner with the freestyle pre-prompt and `toolPolicy: 'default'`

#### Scenario: Decider runs without tools
- **WHEN** a loop decider step runs on a local engine
- **THEN** the runner is spawned with `--tools __none__` and its verdict is parsed by the existing decider parser

### Requirement: Chat, Explore and missions run on a local engine
`ChatManager` (sidebar + Explore, spawn-per-turn and persistent-stdin transports), Quick spec generation, and `AgentChatManager` (missions) SHALL spawn the local runner through the adapter with the same system prompt, tool policy, cwd and `--resume` semantics they apply to claude, and missions SHALL pass an `--mcp-config` file carrying the specrails bridge and enabled external servers.

#### Scenario: Explore turn on local engine
- **WHEN** an Explore conversation with provider `local` receives a message
- **THEN** the runner is spawned from the explore-cwd (or workspace when `mcp=true`) with the read-only tool set and `chat_stream`/`chat_done` events flow unchanged

#### Scenario: Mission calls specrails tools
- **WHEN** a mission on provider `local` asks to list specs
- **THEN** the runner calls `mcp__specrails__specrails_specs` through the bridge and an `agent_tool` event with `toolId` and input preview is broadcast

#### Scenario: Resume across turns
- **WHEN** a second sidebar chat turn is sent on `local`
- **THEN** the spawn carries `--resume <session_id>` from the first turn's `system/init` frame and the reply has the prior context

### Requirement: Honest accounting for local invocations
Every invocation on a local engine SHALL record `provider = <connection id>`, `model = <raw model id>`, real token counts from `usage`, and `total_cost_usd = NULL` unless the connection carries `rates { inputPer1M, outputPer1M }`, in which case the cost SHALL be computed from tokens and flagged `total_cost_usd_estimated = 1`. Analytics SHALL list local ids in the engine filter when rows exist and SHALL label unknown cost as "cost unknown (local engine)", never `$0`.

#### Scenario: No rates configured
- **WHEN** a local turn settles with `usage { input_tokens: 1200, output_tokens: 300 }` and no rates
- **THEN** the `ai_invocations` row stores the tokens and `total_cost_usd IS NULL`

#### Scenario: Rates configured
- **WHEN** the connection has `rates { inputPer1M: 0.1, outputPer1M: 0.4 }` and the same usage
- **THEN** the row stores `total_cost_usd = 0.00024` with `total_cost_usd_estimated = 1`

### Requirement: Kill switch restores legacy behaviour
`SPECRAILS_LOCAL_ENGINES=0|false|off` SHALL disable adapter registration, connection probing, local ids in `validateRequestedProvider`, and runner spawning, while connections remain editable and remain valid as programmatic-runtime role providers. `VITE_FEATURE_LOCAL_ENGINES=false` SHALL hide the test/models UI of the connections card.

#### Scenario: Kill switch on
- **WHEN** the server boots with `SPECRAILS_LOCAL_ENGINES=false` and a `local` connection
- **THEN** `hasAdapter('local')` is false, the detected set contains only CLIs, and the runtime role radio still offers `local`
