# fable-model-alias Specification

## Purpose
Keeps the Claude Fable model alias pointing at the current Fable release.

## Requirements

### Requirement: Fable alias resolves to Claude Fable 5.2
The Claude adapter SHALL resolve the `fable` alias and older Fable ids to `claude-fable-5-2`, and cost accounting SHALL price it (provisionally at the Fable 5.1 rate).

#### Scenario: Alias resolution
- **WHEN** a run requests model `fable` or `claude-fable-5-1`
- **THEN** the spawned model is `claude-fable-5-2`
