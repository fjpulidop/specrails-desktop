## ADDED Requirements

### Requirement: Project runtime configuration
Desktop SHALL expose validated runtime configuration through project API and settings, supporting all four current CLI providers and additional OpenAI-compatible local or remote endpoints.

#### Scenario: Add local model
- **WHEN** a user adds a local endpoint and assigns its model to a role
- **THEN** the saved configuration is usable without an API key or paid gateway

### Requirement: Shared implementation execution
Configured implementation requests SHALL execute the packaged Core runtime with frozen scope, existing worktree and delivery ownership, and observable individual phases.

#### Scenario: Existing provider
- **WHEN** runtime execution selects Claude, Codex, Gemini or Kimi on macOS or Windows
- **THEN** its existing coding capabilities remain usable through the compatible executor

### Requirement: Legacy compatibility
Desktop SHALL retain legacy execution when runtime configuration is absent or disabled and SHALL reject an enabled configuration if its compatible Core runtime is missing.

#### Scenario: Older project
- **WHEN** an existing project has no runtime configuration
- **THEN** its current provider and workflow behavior remains unchanged

### Requirement: Recovery and cancellation
Desktop SHALL expose persisted run status and explicit resume or recovery and SHALL propagate cancellation without certifying interrupted work as successful.

#### Scenario: Resume preserved run
- **WHEN** a user resumes a paused or interrupted runtime run
- **THEN** its original scope and identity are retained and Core checks determine which evidence remains valid

### Requirement: Safe configuration persistence
Desktop SHALL validate provider references, bounds and credential environment names before atomic writes and SHALL NOT return secret values.

#### Scenario: Invalid update
- **WHEN** a malformed provider configuration is submitted
- **THEN** the API returns a validation error and preserves the previous file
