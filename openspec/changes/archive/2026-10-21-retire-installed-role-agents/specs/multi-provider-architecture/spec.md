## MODIFIED Requirements

### Requirement: Adapter declares baseline agents and detects installation

Every adapter MUST implement:
- `baselineAgents(): readonly string[]` — the role identifiers profile validation considers mandatory in any profile's chain (e.g. `['sr-architect', 'sr-developer', 'sr-reviewer']`). These are identifiers of runtime-defined roles, never installed files: no adapter or caller MAY require a file named after them to exist.
- `detectInstalled(): Promise<DetectionResult>` — returns `{ installed: boolean; executable: boolean; version?: string; meetsMinimum?: boolean }`. Implementations MUST complete within 3 seconds; longer must resolve to `{ installed: false }` rather than hang.

`baselineAgents()` is consumed by `ProfileManager.validateStructural` to know which agent ids must be present in any profile's chain, and by profile migration to seed those ids with the adapter's default model.

#### Scenario: Both default adapters declare the same baseline
- **WHEN** `claudeAdapter.baselineAgents()` and `codexAdapter.baselineAgents()` are compared
- **THEN** they return arrays with the same set of strings (order may differ)

#### Scenario: Profile migration without role files
- **WHEN** `POST /profiles/migrate-from-settings` runs on a project whose catalog holds no `sr-*` file
- **THEN** a `default` profile is created with the baseline ids and the adapter's default model, and the request does not fail

#### Scenario: detectInstalled honours minVersion when set
- **GIVEN** `codexAdapter.minCliVersion === '0.128.0'`
- **WHEN** `codexAdapter.detectInstalled()` runs against a system with codex 0.120.0
- **THEN** the result is `{ installed: true, executable: true, version: '0.120.0', meetsMinimum: false }`

#### Scenario: detectInstalled handles missing binary
- **WHEN** the binary is not on PATH
- **THEN** the result is `{ installed: false, executable: false }`
