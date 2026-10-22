# programmatic-agent-runtime Specification

## Purpose
Defines how Desktop configures and runs implementation through the packaged Core agent runtime, including configuration persistence, recovery and cancellation.

## Requirements

### Requirement: Project runtime configuration
Desktop SHALL expose validated runtime configuration through the project API and settings. Role engines SHALL reference global provider connections: the CLI providers Desktop detects and additional OpenAI-compatible local or remote endpoints.

#### Scenario: Add local model
- **WHEN** a user adds a local endpoint and assigns its model to a role
- **THEN** the saved configuration is usable without an API key or paid gateway

### Requirement: Shared implementation execution
Configured implementation requests SHALL execute the packaged Core runtime with frozen scope, existing worktree and delivery ownership, and observable individual phases.

#### Scenario: Existing provider
- **WHEN** runtime execution selects Claude, Codex, Gemini or Kimi on macOS or Windows
- **THEN** its existing coding capabilities remain usable through the compatible executor

### Requirement: Default runtime configuration
The Core runtime SHALL be the only implementation engine. When a project has no runtime configuration, Desktop SHALL derive an enabled default that assigns every role to a detected CLI connection, migrate provider entries embedded in older project files into global connections, and reject execution when the compatible Core runtime is missing.

#### Scenario: Older project
- **WHEN** an existing project has no runtime configuration
- **THEN** Desktop runs it with a default configuration whose roles use a detected CLI provider

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
