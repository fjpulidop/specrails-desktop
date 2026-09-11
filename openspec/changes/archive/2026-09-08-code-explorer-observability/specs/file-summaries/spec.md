## ADDED Requirements

### Requirement: Explanations are bound to evidence and lifecycle
Summary generation SHALL use the hash of the source bytes actually sent to the provider, expose model/date/truncation and freshness, and reject provider error results. Story generation SHALL disclose incomplete patch evidence and SHALL NOT invent explanations when evidence is absent.

#### Scenario: Source changes while queued or running
- **WHEN** source bytes change before or during generation
- **THEN** the persisted hash MUST match the supplied snapshot
- **AND** the resulting freshness state MUST reflect the current source

#### Scenario: Project closes during generation
- **WHEN** the project or manager is disposed
- **THEN** queued requests MUST settle and active provider processes MUST be cancelled
- **AND** late results MUST NOT access a closed database

#### Scenario: Concurrent explanations near the spending limit
- **WHEN** several summary/story requests arrive together
- **THEN** generation MUST obey bounded concurrency and shared spending checks

#### Scenario: Provider returns an error with exit code zero
- **WHEN** a provider event reports an error result
- **THEN** the text MUST NOT be persisted as a successful explanation
