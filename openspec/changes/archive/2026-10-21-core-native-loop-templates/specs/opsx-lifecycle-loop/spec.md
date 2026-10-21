## MODIFIED Requirements

### Requirement: OpenSpec Lifecycle Loop Template

The system SHALL provide the OpenSpec lifecycle graph (`opsxLifecycleGraph`) that, given a single Specrails ticket, drives the OpenSpec lifecycle with a single AI agent and no multi-agent pipeline. It SHALL be used as the legacy variant of the `factory:sdd-quick-openspec` built-in loop and SHALL NOT be offered in the loop template catalog. The graph SHALL be hand-authored because it combines AI steps with `shell` validation and archive nodes.

#### Scenario: Graph is not offered as a template
- **WHEN** a client requests the loop template catalog
- **THEN** no `opsx-lifecycle` template is present

#### Scenario: Graph is valid
- **WHEN** `opsxLifecycleGraph()` is validated
- **THEN** it passes `validateLoopGraph`

#### Scenario: Built-in launch interpolates the ticket
- **WHEN** a rail launches the SDD Quick (OpenSpec) built-in on a Core without the definition engine
- **THEN** the run starts at the first `opsx:ff` step with the ticket's `{{spec.title}}` and `{{spec.description}}` interpolated into the prompt
