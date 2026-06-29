# reasoning-effort Specification

## Purpose
TBD - created by archiving change loop-builder. Update Purpose after archive.
## Requirements
### Requirement: Per-Invocation Reasoning Effort Selection

The system SHALL allow a reasoning-effort value of exactly one of `low`, `medium`, or `high` to be selected for an individual AI invocation. The selection MUST be available on AI Step nodes within a loop and on the rail header for a `loop`-mode rail. When no effort is explicitly selected for an invocation, the system SHALL resolve effort from the rail's stored default and, if none is stored, SHALL omit any effort directive entirely (provider default behaviour).

#### Scenario: Effort selected on the rail header

- **WHEN** a user selects `high` reasoning effort in the rail header before launching a loop
- **THEN** that invocation SHALL be spawned with `high` effort applied according to the selected provider's capability
- **AND** the value `high` SHALL be threaded into the launch options for the run

#### Scenario: Effort selected on an AI Step node

- **WHEN** an AI Step node carries a reasoning-effort value of `medium`
- **THEN** the invocation for that node SHALL be spawned with `medium` effort applied
- **AND** other AI Step nodes in the same loop without an explicit value SHALL fall back to the rail's resolved default

#### Scenario: No effort selected anywhere

- **WHEN** neither the invocation nor the rail's stored default specifies a reasoning effort
- **THEN** the system SHALL NOT pass any effort directive to the provider CLI
- **AND** the invocation SHALL behave identically to a pre-change spawn for that provider

### Requirement: Native Codex Effort Application

For the Codex provider the system SHALL apply the selected reasoning effort natively by appending the config override `-c model_reasoning_effort=<value>` to the Codex CLI argv, where `<value>` is the validated effort (`low`, `medium`, or `high`). The override MUST be constructed by the Codex provider adapter's argv-building path and MUST NOT be hardcoded at a call site.

#### Scenario: Codex receives the native config override

- **WHEN** a Codex invocation is spawned with reasoning effort `low`
- **THEN** the Codex CLI argv SHALL contain `-c model_reasoning_effort=low`
- **AND** the override SHALL be produced by the Codex adapter's argv construction

#### Scenario: Codex invocation with no effort

- **WHEN** a Codex invocation is spawned with no reasoning effort resolved
- **THEN** the Codex CLI argv SHALL NOT contain any `model_reasoning_effort` config override

### Requirement: Native Claude Effort Application

For the Claude provider the system SHALL apply the selected reasoning effort natively by appending the `--effort <level>` flag to the Claude CLI argv, where `<level>` is the validated effort (`low`, `medium`, or `high`; the Claude CLI additionally accepts `xhigh` and `max`). The flag MUST be constructed by the Claude provider adapter's argv-building path, MUST NOT mutate the user prompt, and MUST NOT be hardcoded at a call site.

#### Scenario: Claude receives the native --effort flag

- **WHEN** a Claude invocation is spawned with reasoning effort `high`
- **THEN** the Claude CLI argv SHALL contain `--effort high`
- **AND** the user prompt SHALL be unchanged

#### Scenario: Claude invocation with no effort

- **WHEN** a Claude invocation is spawned with no reasoning effort resolved
- **THEN** the Claude CLI argv SHALL NOT contain a `--effort` flag

### Requirement: Capability-Gated Effort Behaviour Per Provider

Each provider adapter SHALL advertise a `supportsReasoningEffort` capability flag indicating whether it has a per-invocation reasoning-effort mechanism. A provider that advertises support SHALL apply the effort via its native argv mechanism (Claude via `--effort <level>`; Codex via `-c model_reasoning_effort=<value>`). A provider that does NOT advertise support — e.g. Gemini, which exposes thinking levels only via `settings.json` and has NO per-invocation flag — MUST hide the effort selector and MUST ignore any supplied effort: it emits no effort flag and makes no compensating change to the prompt. In no case SHALL the system emit an invalid or unrecognised CLI flag to a provider.

#### Scenario: Unsupported provider hides the selector and ignores effort

- **WHEN** the selected provider advertises `supportsReasoningEffort: false` (e.g. Gemini)
- **THEN** the reasoning-effort selector SHALL NOT be rendered for that provider
- **AND** no effort flag SHALL be appended to that provider's argv even if a value is supplied
- **AND** the prompt SHALL NOT be altered to compensate

#### Scenario: No silent invalid flag

- **WHEN** an effort value is resolved for any provider
- **THEN** the system SHALL produce a native effort flag ONLY for a provider whose capability advertises support
- **AND** the system SHALL NEVER append an effort-derived flag that the target provider CLI would reject

### Requirement: Effort Threading Through Spawn, Adapter, and Enqueue Options

The selected reasoning effort SHALL be threaded end-to-end: through the enqueue/launch options accepted by the engine, through the spawn options handed to the adapter, and into the provider adapter's argv construction. The effort MUST NOT be resolved or applied by branching on a provider id at a call site; it MUST be carried as data and consumed by the adapter responsible for the spawn.

#### Scenario: Effort carried from launch to argv

- **WHEN** a loop run is launched with an explicit reasoning effort
- **THEN** the effort value SHALL be present in the launch options, the spawn options, and the adapter argv-construction input for the resulting invocation

#### Scenario: Effort applied by adapter, not by call-site branching

- **WHEN** an invocation is spawned with a resolved reasoning effort
- **THEN** the active provider adapter SHALL decide how (or whether) to materialise the effort into argv
- **AND** the spawning call site SHALL NOT inspect the provider id to construct an effort flag itself

### Requirement: Rail Stored Default Effort and Override Endpoint

A rail SHALL persist a default reasoning effort in a dedicated `reasoning_effort` column. The system SHALL expose a `PUT /api/projects/:projectId/rails/:i/effort` endpoint that sets the rail's stored default effort. An effort value supplied explicitly at launch SHALL override the stored default for that launch only, leaving the persisted column unchanged.

#### Scenario: Persisting a rail default via the endpoint

- **WHEN** a client issues `PUT /rails/:i/effort` with `{ effort: "medium" }`
- **THEN** the rail's `reasoning_effort` column SHALL be updated to `medium`
- **AND** subsequent launches of that rail with no explicit effort SHALL resolve to `medium`

#### Scenario: Per-launch value overrides stored default

- **WHEN** a rail has a stored default effort of `low` and a loop is launched with an explicit effort of `high`
- **THEN** that launch SHALL use `high`
- **AND** the rail's persisted `reasoning_effort` column SHALL remain `low`

#### Scenario: Launch with no explicit value uses stored default

- **WHEN** a rail with stored default `high` is launched without an explicit effort
- **THEN** the launch SHALL resolve the effort to `high`

### Requirement: Server-Side Effort Validation

The server SHALL validate every supplied reasoning-effort value against the allowed set `{ low, medium, high }`. Any value outside this set, including empty strings, mismatched casing not normalised to an allowed value, or non-string values, SHALL be rejected with a client error and SHALL NOT be persisted or passed to a spawn. Validation MUST apply both at the `PUT /rails/:i/effort` endpoint and at any launch endpoint that accepts an explicit effort.

#### Scenario: Invalid effort rejected at the effort endpoint

- **WHEN** a client issues `PUT /rails/:i/effort` with `{ effort: "extreme" }`
- **THEN** the server SHALL respond with a 400 client error
- **AND** the rail's `reasoning_effort` column SHALL NOT be modified

#### Scenario: Invalid effort rejected at launch

- **WHEN** a loop launch request supplies an effort value of `urgent`
- **THEN** the server SHALL reject the launch with a 400 client error
- **AND** no spawn SHALL occur for that request

#### Scenario: Valid effort accepted

- **WHEN** a request supplies the effort value `low`
- **THEN** the server SHALL accept it as a valid reasoning effort

