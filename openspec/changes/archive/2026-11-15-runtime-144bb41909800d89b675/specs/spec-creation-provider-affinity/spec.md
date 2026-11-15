# Spec Delta

## Purpose

Guarantees that every AI step derived from creating a spec in a mission uses the provider selected in that mission, so no step silently consumes another provider's quota.

## ADDED Requirements

### Requirement: Mission provider governs derived AI steps
A spec created from a mission SHALL run every derived AI step, including automatic triage and contract refinement, on the provider of the authenticated mission context, even when the project primary provider or the triage role is configured with another provider.

#### Scenario: Codex mission, Claude project
- **WHEN** a Codex mission commits a spec in a project whose primary provider and triage role are Claude
- **THEN** the triage request and the contract request both carry provider Codex and no Claude adapter is invoked

#### Scenario: Each supported provider
- **WHEN** a mission with any supported provider commits a spec
- **THEN** each derived step receives exactly that provider and a model valid for its catalog

### Requirement: Provider fixed at operation start
The provider SHALL be captured when the creation starts and kept immutable for that operation's asynchronous jobs.

#### Scenario: Selector changes while work is pending
- **WHEN** the mission provider selector changes after the spec is saved but before triage runs
- **THEN** the pending triage still uses the provider captured at creation

#### Scenario: Concurrent missions
- **WHEN** two missions with different providers create specs at the same time
- **THEN** each spec's steps use only its own mission provider

### Requirement: No silent provider fallback
If a derived step does not support the mission provider, or the provider is disabled, undetected or unregistered, the step SHALL NOT run and SHALL report the step name and reason, and SHALL NOT run another provider.

#### Scenario: Incompatible provider
- **WHEN** the mission provider lacks the capability a step needs
- **THEN** the step is recorded or broadcast as unavailable with the reason and no other adapter is invoked

### Requirement: Saved spec survives enrichment failure
A failure after the spec is saved SHALL preserve exactly one saved spec with its approved content and repositories, and SHALL report save success separately from the failed step. No duplicate SHALL be created and content SHALL NOT be regenerated automatically.

#### Scenario: Triage fails after save
- **WHEN** triage fails after a successful save
- **THEN** the spec remains unchanged, its triage record is failed with the error, and the save response was successful

### Requirement: Actual provider and model are recorded
Diagnostics and accounting for derived steps SHALL record the provider and model actually executed, and that model SHALL belong to the mission provider.

#### Scenario: Accounting row
- **WHEN** triage completes for a Codex mission spec
- **THEN** the invocation row and triage record show provider Codex and a Codex catalog model

### Requirement: Non-mission creation unchanged
Creations without a mission context, including external MCP clients, SHALL keep the existing provider resolution, and project or triage role settings SHALL NOT be modified.

#### Scenario: External MCP client
- **WHEN** an external MCP client commits a spec
- **THEN** triage resolves the engine from project and role settings as before
