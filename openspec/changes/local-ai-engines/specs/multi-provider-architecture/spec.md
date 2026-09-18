## MODIFIED Requirements

### Requirement: Provider registry exposes lookup by id

The app SHALL expose a `providerRegistry` exporting `getAdapter(id: string): ProviderAdapter`, `listAdapters(): ProviderAdapter[]`, `hasAdapter(id: string): boolean`, and `unregisterAdapter(id: string): boolean`. Lookups for unknown ids SHALL throw `UnknownProviderError`. The registry MUST be populated at module-load time by importing each CLI adapter's registration call; local (OpenAI-compatible) adapters are registered and unregistered dynamically by `syncLocalAdapters` when connections load or save. `listAdapters()` SHALL return CLI adapters first, in registration order, followed by local adapters.

#### Scenario: Lookup returns the matching adapter
- **WHEN** `getAdapter('claude')` is called
- **THEN** the returned adapter has `id === 'claude'`, `binary === 'claude'`, `instructionsFilename === 'CLAUDE.md'`, `projectDirName === '.claude'`

#### Scenario: Lookup for unknown provider throws
- **WHEN** `getAdapter('does-not-exist')` is called
- **THEN** the call throws `UnknownProviderError` whose message names the unknown id and lists registered ids

#### Scenario: listAdapters returns every registered provider
- **WHEN** `listAdapters()` is called after module load
- **THEN** the returned array includes `claude` and `codex` adapters

#### Scenario: Unregister removes a local adapter only
- **WHEN** `unregisterAdapter('local')` is called for a registered local adapter
- **THEN** it returns true and `hasAdapter('local')` is false; calling it for `claude` returns false and leaves the CLI adapter registered

### Requirement: Adapter declares baseline agents and detects installation

Every adapter MUST implement:
- `baselineAgents(): readonly string[]` — the agent ids profile validation considers mandatory (e.g. `['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver']`)
- `detectInstalled(): Promise<DetectionResult>` — returns `{ installed: boolean; executable: boolean; version?: string; meetsMinimum?: boolean }`. Implementations MUST complete within 3 seconds; longer must resolve to `{ installed: false }` rather than hang. For a local adapter, `detectInstalled()` SHALL be the bounded HTTP models probe of its connection and `version` SHALL be absent.

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

#### Scenario: Local adapter detection is the HTTP probe
- **WHEN** `getAdapter('local').detectInstalled()` runs against a reachable endpoint
- **THEN** the result is `{ installed: true, executable: true }` with no `version`
