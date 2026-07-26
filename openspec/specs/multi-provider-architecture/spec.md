# multi-provider-architecture Specification

## Purpose
TBD - created by archiving change add-multi-provider-support. Update Purpose after archive.
## Requirements
### Requirement: ProviderAdapter interface is the single integration point

The app SHALL define a TypeScript interface `ProviderAdapter` in `server/providers/provider-adapter.ts` that every provider implements. Manager code (chat, queue, agent-refine, setup, profile, plugin, explore-cwd, result-event, project-router) MUST consume the adapter exclusively for spawn-time decisions (argv shape, stream parsing, session-id capture, result normalisation, MCP registration mode, filesystem-convention paths). No new `if (provider === '<id>')` branch SHALL be introduced in manager code; existing such branches MUST be migrated to capability-flag or method dispatches as those managers are touched.

#### Scenario: Adding a third provider does not require manager changes
- **WHEN** a developer adds `server/providers/example-adapter.ts` exporting an object that implements `ProviderAdapter` and registers it in `server/providers/registry.ts`
- **THEN** the new provider becomes addressable end-to-end (Add Project, spawn, stream parse, profile validation, plugin install) with no changes to `chat-manager.ts`, `queue-manager.ts`, `agent-refine-manager.ts`, `setup-manager.ts`, `profile-manager.ts`, `plugin-manager.ts`, `result-event.ts`, or `explore-cwd-manager.ts`

#### Scenario: Manager dispatches on capabilities, not provider id
- **WHEN** any manager needs to decide whether to call `--resume <sessionId>` or its equivalent
- **THEN** the decision MUST be expressed as `if (adapter.capabilities.nativeResume) { adapter.buildArgs('chat-resume', { sessionId, ... }) }` rather than `if (provider === 'claude')`

### Requirement: Provider registry exposes lookup by id

The app SHALL expose a `providerRegistry` exporting `getAdapter(id: string): ProviderAdapter`, `listAdapters(): ProviderAdapter[]`, and `hasAdapter(id: string): boolean`. Lookups for unknown ids SHALL throw `UnknownProviderError`. The registry MUST be populated at module-load time by importing each adapter's registration call.

#### Scenario: Lookup returns the matching adapter
- **WHEN** `getAdapter('claude')` is called
- **THEN** the returned adapter has `id === 'claude'`, `binary === 'claude'`, `instructionsFilename === 'CLAUDE.md'`, `projectDirName === '.claude'`

#### Scenario: Lookup for unknown provider throws
- **WHEN** `getAdapter('does-not-exist')` is called
- **THEN** the call throws `UnknownProviderError` whose message names the unknown id and lists registered ids

#### Scenario: listAdapters returns every registered provider
- **WHEN** `listAdapters()` is called after module load
- **THEN** the returned array includes `claude` and `codex` adapters

### Requirement: Adapter exposes filesystem and CLI conventions

Every adapter MUST expose, as readonly properties, the conventions its CLI imposes on the project filesystem and the binary it spawns:
- `id: string` — kebab-case unique identifier
- `displayName: string` — human-readable name used by UI
- `binary: string` — the executable to spawn (`claude`, `codex`, ...)
- `minCliVersion: string | null` — minimum supported CLI version (semver string) or `null` when no pin
- `projectDirName: string` — the directory the provider's CLI scaffolds (`.claude`, `.codex`, ...)
- `instructionsFilename: string` — the top-level instructions file the provider's CLI reads on startup (`CLAUDE.md`, `AGENTS.md`, ...)
- `mcpRegistration: 'project-json' | 'cli-add'` — how MCP servers are declared for this provider

#### Scenario: Claude adapter declares its conventions
- **WHEN** the claude adapter is inspected
- **THEN** `projectDirName === '.claude'`, `instructionsFilename === 'CLAUDE.md'`, `mcpRegistration === 'project-json'`, `binary === 'claude'`

#### Scenario: Codex adapter declares its conventions
- **WHEN** the codex adapter is inspected
- **THEN** `projectDirName === '.codex'`, `instructionsFilename === 'AGENTS.md'`, `mcpRegistration === 'cli-add'`, `binary === 'codex'`

### Requirement: Adapter exposes a capability-flag block

Every adapter MUST expose a readonly `capabilities` object containing at least:
- `nativeResume: boolean` — true when the CLI supports resuming a session by id natively (no synthetic id workaround)
- `nativeStreamJson: boolean` — true when the CLI emits JSONL events natively (i.e. `--json` or equivalent)
- `nativeCostUsd: boolean` — true when the CLI reports `total_cost_usd` in its terminal event
- `nativeOtelEnv: boolean` — true when the CLI honours environment variables to emit OTLP (e.g. Claude's `CLAUDE_CODE_ENABLE_TELEMETRY`)
- `profileEnvSupport: boolean` — true when the provider's runtime reads `SPECRAILS_PROFILE_PATH` to apply profile resolution
- `systemPromptArg: boolean` — true when the CLI accepts a `--system-prompt`-style flag (false means the system prompt MUST be folded into the user prompt)

#### Scenario: Claude adapter capabilities
- **WHEN** the claude adapter's `capabilities` is read
- **THEN** all six flags are `true`

#### Scenario: Codex adapter capabilities reflect 0.128.0 behaviour
- **WHEN** the codex adapter's `capabilities` is read
- **THEN** `nativeResume === true`, `nativeStreamJson === true`, `nativeOtelEnv === false`, `nativeCostUsd === false`, `profileEnvSupport === true`, `systemPromptArg === false`

### Requirement: Adapter exposes a typed model catalog

Every adapter MUST expose:
- `modelCatalog(): readonly { value: string; label: string; default?: boolean }[]` — the full list of models valid for this provider, with at most one entry marked `default: true`
- `defaultModel(): string` — the `value` of the default entry, returned as a stable string regardless of catalog ordering

The model catalog is the single source of truth for: profile schema validation, the Add Spec model picker dropdown, `POST /tickets/generate-spec` model validation, and the `/api/projects/:id/default-spec-model` endpoint's `allowed` field.

#### Scenario: defaultModel matches a catalog entry
- **WHEN** any adapter is queried
- **THEN** `defaultModel()` returns a string equal to some `catalog[i].value` where `catalog[i].default === true`

#### Scenario: Server validation uses the catalog
- **WHEN** `POST /tickets/generate-spec` validates a request body's `model` field for a project whose provider is `<id>`
- **THEN** the validation calls `getAdapter(id).modelCatalog().map(m => m.value)` and rejects values not in that list

### Requirement: Adapter builds spawn args per action

Every adapter MUST implement `buildArgs(action: SpawnAction, opts: SpawnOptions): string[]` that returns the complete `argv` (excluding the binary name) for spawning the CLI for the named action. The supported actions MUST include at least:
- `chat-turn` — first turn of a chat conversation
- `chat-resume` — turn 2+ of a chat conversation, given a captured session id
- `rail-job` — a pipeline job spawned by QueueManager
- `spec-gen` — a Quick spec generation
- `agent-refine` — an AI Edit refine turn
- `setup-enrich` — the post-install enrich pass

`SpawnOptions` MUST carry at least `prompt: string`, `systemPrompt?: string`, `model: string`, `sessionId?: string`, `maxTurns?: number`, `attachmentTextBlocks?: string[]`. Adapters whose CLI lacks `systemPromptArg` MUST fold `systemPrompt` into the prompt instead of emitting a flag.

#### Scenario: Claude chat-turn argv
- **WHEN** `claudeAdapter.buildArgs('chat-turn', { prompt: 'hi', systemPrompt: 'sys', model: 'sonnet' })` is called
- **THEN** the result is `['--model', 'sonnet', '--dangerously-skip-permissions', '--tools', 'default', '--output-format', 'stream-json', '--verbose', '--system-prompt', 'sys', '-p', 'hi']`

#### Scenario: Codex chat-turn argv has no --system-prompt flag
- **WHEN** `codexAdapter.buildArgs('chat-turn', { prompt: 'hi', systemPrompt: 'sys', model: 'gpt-5.4-mini' })` is called
- **THEN** the result is `['exec', '--json', 'sys\n\n---\n\nhi', '--model', 'gpt-5.4-mini']`
- **AND** no element starts with `--system-prompt`

#### Scenario: Codex chat-resume uses exec resume
- **WHEN** `codexAdapter.buildArgs('chat-resume', { prompt: 'next', sessionId: 'UUID', model: 'gpt-5.4-mini' })` is called
- **THEN** the result is `['exec', 'resume', '--json', 'UUID', 'next', '--model', 'gpt-5.4-mini']`

### Requirement: Adapter parses stream lines into uniform events

Every adapter MUST implement `parseStreamLine(line: string): AdapterEvent | null`, where `AdapterEvent` is a discriminated union of at minimum:
- `{ kind: 'text-delta', text: string }`
- `{ kind: 'tool-use', name: string, inputPreview: string }`
- `{ kind: 'session-started', sessionId: string }`
- `{ kind: 'result', payload: Record<string, unknown> }`
- `{ kind: 'other', type: string, raw: Record<string, unknown> }`

Lines that do not parse as JSON, or that the adapter does not recognise, MUST be returned as `kind: 'other'` (never as `null` for valid JSONL). `null` is reserved for empty lines or lines the adapter declares non-event (e.g. plain text noise when the provider does not support JSONL).

#### Scenario: Codex thread.started maps to session-started
- **WHEN** `codexAdapter.parseStreamLine('{"type":"thread.started","thread_id":"019e37c6-..."}')` is called
- **THEN** the result is `{ kind: 'session-started', sessionId: '019e37c6-...' }`

#### Scenario: Codex item.completed with agent_message maps to text-delta
- **WHEN** `codexAdapter.parseStreamLine('{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}')` is called
- **THEN** the result is `{ kind: 'text-delta', text: 'hello' }`

#### Scenario: Codex turn.completed maps to result
- **WHEN** `codexAdapter.parseStreamLine('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}')` is called
- **THEN** the result is `{ kind: 'result', payload: { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5 } } }`

#### Scenario: Claude `assistant` event maps to text-delta
- **WHEN** `claudeAdapter.parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}')` is called
- **THEN** the result is `{ kind: 'text-delta', text: 'hi' }`

#### Scenario: Unknown event types are captured as other
- **WHEN** any adapter receives a JSON line with an unknown `type`
- **THEN** the result is `{ kind: 'other', type: '<unknown>', raw: <parsed> }`
- **AND** the call does not throw

### Requirement: Adapter extracts a normalised result from a stream

Every adapter MUST implement `extractResult(events: AdapterEvent[]): NormalisedResult` returning the canonical result shape used by `ai_invocations`:
- `tokens_in?: number`
- `tokens_out?: number`
- `tokens_cache_read?: number`
- `tokens_cache_create?: number`
- `total_cost_usd?: number` (only when `capabilities.nativeCostUsd === true`)
- `num_turns?: number`
- `model?: string`
- `duration_ms?: number`
- `duration_api_ms?: number`
- `session_id?: string`

Fields the provider does not report MUST be `undefined` (NULL when persisted). Cost calculation for providers without native cost reporting happens outside the adapter (via `server/pricing.ts`).

#### Scenario: Codex extractResult populates tokens but omits cost
- **GIVEN** an event stream containing one `session-started` and one `result` carrying `turn.completed.usage`
- **WHEN** `codexAdapter.extractResult(events)` is called
- **THEN** `tokens_in`, `tokens_out`, `tokens_cache_read`, `session_id`, and `model` are populated
- **AND** `total_cost_usd` is `undefined`

#### Scenario: Claude extractResult populates tokens and cost
- **GIVEN** an event stream containing one Claude `result` event with `total_cost_usd: 0.012` and `usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 }`
- **WHEN** `claudeAdapter.extractResult(events)` is called
- **THEN** `total_cost_usd === 0.012`, `tokens_in === 100`, `tokens_out === 50`, `tokens_cache_read === 10`

### Requirement: Adapter declares baseline agents and detects installation

Every adapter MUST implement:
- `baselineAgents(): readonly string[]` — the agent ids profile validation considers mandatory (e.g. `['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver']`)
- `detectInstalled(): Promise<DetectionResult>` — returns `{ installed: boolean; executable: boolean; version?: string; meetsMinimum?: boolean }`. Implementations MUST complete within 3 seconds; longer must resolve to `{ installed: false }` rather than hang.

`baselineAgents()` is consumed by `ProfileManager.validateStructural` to know which agent ids must be present in any profile's chain.

#### Scenario: Both default adapters declare the same baseline
- **WHEN** `claudeAdapter.baselineAgents()` and `codexAdapter.baselineAgents()` are compared
- **THEN** they return arrays with the same set of strings (order may differ)

#### Scenario: detectInstalled honours minVersion when set
- **GIVEN** `codexAdapter.minCliVersion === '0.128.0'`
- **WHEN** `codexAdapter.detectInstalled()` runs against a system with codex 0.120.0
- **THEN** the result is `{ installed: true, executable: true, version: '0.120.0', meetsMinimum: false }`

#### Scenario: detectInstalled handles missing binary
- **WHEN** the binary is not on PATH
- **THEN** the result is `{ installed: false, executable: false }`

### Requirement: Provider discovery endpoint walks the registry

The app SHALL expose `GET /api/available-providers` returning `{ <providerId>: boolean, ..., tiers: ('quick' | 'full')[] }` where each key is the id of a registered provider and the boolean reflects whether that provider's CLI is currently detectable on the host. The endpoint MUST NOT hardcode any provider id; the response shape MUST be derived from `providerRegistry.listAdapters()`. The `tiers` array MUST include `'quick'` always; `'full'` only when at least one provider's CLI is detected.

#### Scenario: Endpoint reports detected state for every registered provider
- **WHEN** `GET /api/available-providers` is called on a host where claude is installed and codex is not
- **THEN** the response is `{ claude: true, codex: false, tiers: ['quick', 'full'] }`

#### Scenario: Endpoint shape extends to new providers automatically
- **WHEN** a third provider `example` is registered and its binary is on PATH
- **THEN** `GET /api/available-providers` returns an object with a top-level `example: true` key alongside `claude` and `codex`
- **AND** no source-code change to `desktop-router.ts` is required for the new key to appear

### Requirement: POST /projects accepts any registered provider id

The app SHALL accept `provider: <id>` in the body of `POST /api/projects` if and only if `providerRegistry.hasAdapter(id)`. Unknown ids MUST be rejected with HTTP 400 and a body identifying the unknown id and listing the registered ids. The default when `provider` is omitted MUST be `'claude'` (preserves backwards compatibility for existing client code paths).

#### Scenario: Codex project creation succeeds
- **WHEN** a client POSTs `{ path: '/tmp/ok', provider: 'codex' }` to a host with codex installed and the path being a valid directory
- **THEN** the response is HTTP 201 with the new project row carrying `provider: 'codex'`

#### Scenario: Unknown provider id rejected
- **WHEN** a client POSTs `{ path: '/tmp/ok', provider: 'turbofake' }`
- **THEN** the response is HTTP 400 with an error naming `turbofake` as unknown and listing `claude` and `codex` as valid ids

### Requirement: Setup-prerequisites reports every registered provider

`GET /api/setup-prerequisites` SHALL include one entry per registered provider in the prerequisites array. Each entry MUST report `installed`, `executable`, `version`, and `meetsMinimum` derived from the adapter's `detectInstalled()`. The endpoint MUST surface a project as installable when at least one provider is in a usable state (`installed && executable && meetsMinimum !== false`).

#### Scenario: Both providers usable
- **WHEN** claude and codex are both installed at supported versions
- **THEN** the response contains entries for both, each with `installed: true, executable: true, meetsMinimum: true`
- **AND** `ok: true` at the top level

#### Scenario: Neither provider usable blocks Add Project
- **WHEN** neither provider is installed
- **THEN** the response has both entries with `installed: false`
- **AND** `ok: false`
- **AND** the existing client `prereqsBlock` logic in `AddProjectDialog` continues to disable the Add Project submit button

### Requirement: Provider field on project is immutable post-creation

The app SHALL NOT expose any endpoint that changes a project's `provider` after creation. The `provider` column on `projects` is set on `POST /projects` and is read-only thereafter. UI surfaces that display the provider SHALL render it as informational, not as a control.

#### Scenario: No PATCH endpoint accepts provider
- **WHEN** any existing `PATCH /api/projects/:id` or per-project settings endpoint is inspected
- **THEN** none of them accept a `provider` field
- **AND** sending one is silently dropped or rejected with 400 depending on the endpoint's strictness mode

#### Scenario: SettingsPage shows provider as read-only
- **WHEN** the user opens SettingsPage for a project
- **THEN** the provider name is visible (e.g. as a badge or label)
- **AND** no input control exists to change it

### Requirement: Provider-aware filesystem conventions are honoured by all writers

Every app-managed writer of `CLAUDE.md` / `AGENTS.md` / `.claude/*` / `.codex/*` paths MUST resolve the filename via `adapter.instructionsFilename` and the directory via `adapter.projectDirName`. Hardcoded paths to `.claude/` or `CLAUDE.md` in manager code are forbidden going forward; any pre-existing hardcoded paths MUST be migrated when the surrounding code is touched.

#### Scenario: Explore-cwd writes the right instructions file
- **WHEN** the explore-cwd is materialised for a codex project
- **THEN** the file written is `AGENTS.md`
- **AND** no file named `CLAUDE.md` is created in the codex project's explore-cwd

#### Scenario: Plugin contributors write to the right instructions file
- **WHEN** a plugin's shared-file contributor runs on a codex project
- **THEN** the contributor's `<!-- specrails-desktop-managed:<plugin> -->` block is written to `AGENTS.md`
- **AND** the project's `CLAUDE.md` is not touched (and need not exist)

### Requirement: Minimum CLI version is enforced at startup

When `adapter.minCliVersion` is non-null, the app SHALL surface an error in `setup-prerequisites` if the detected CLI version is less than the minimum. The error MUST include the detected version, the required minimum, and an upgrade hint. Spawn-time enforcement MUST NOT block: managers SHALL spawn the CLI regardless and let the CLI's own error path surface to the user via existing stderr capture.

#### Scenario: Old codex version surfaced in prerequisites
- **GIVEN** `codexAdapter.minCliVersion === '0.128.0'` and the host has codex 0.120.0
- **WHEN** `GET /api/setup-prerequisites` is called
- **THEN** the codex entry reports `installed: true, executable: true, meetsMinimum: false, version: '0.120.0'`
- **AND** the entry's `error` field names `0.128.0` as the minimum and includes an `upgrade hint`

#### Scenario: Spawning an old version still proceeds
- **GIVEN** the codex version on disk is below the minimum
- **WHEN** a job spawns
- **THEN** the spawn still happens (no pre-flight version block)
- **AND** if codex 0.120.0 fails to parse `--json` flags the resulting stderr surfaces via the existing failed-job error path

### Requirement: Claude catalog aliases resolve to explicit model ids at spawn time

The Claude adapter's catalog values are short aliases (`sonnet`, `opus`, `fable`, `haiku`) that remain the stored, validated, and displayed identity of a model choice. Where an alias would otherwise let the CLI decide which generation to run, the adapter SHALL resolve it to an explicit model id in the spawn arguments so the executed model is a product decision, not a CLI default.

The `opus` alias SHALL resolve to `claude-opus-5` in every spawn action that passes a model. Aliases without a pinned generation SHALL be passed through unchanged, and any value that is already a concrete model id SHALL be passed through unchanged.

The reverse mapping that collapses concrete model ids back to a catalog alias SHALL recognise `claude-opus-5` as `opus`, so persistence, analytics grouping, and selector state remain stable across the change.

#### Scenario: Selecting Opus spawns Opus 5

- **WHEN** a Claude spawn is built with model `opus`
- **THEN** the spawn arguments SHALL pass `claude-opus-5` as the model

#### Scenario: Other aliases are unchanged

- **WHEN** a Claude spawn is built with model `sonnet`, `haiku`, or `fable`
- **THEN** the spawn arguments SHALL pass that value unchanged

#### Scenario: Concrete ids pass through

- **WHEN** a Claude spawn is built with an explicit model id
- **THEN** the spawn arguments SHALL pass that id unchanged

#### Scenario: Opus 5 normalises back to the catalog alias

- **WHEN** a stream or stored row reports the model `claude-opus-5`
- **THEN** normalisation SHALL collapse it to the catalog value `opus`

