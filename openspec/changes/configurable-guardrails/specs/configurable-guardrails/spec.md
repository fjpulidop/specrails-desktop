## ADDED Requirements

### Requirement: Compact-runtime guardrails are a named catalog a project can switch off
Core SHALL expose a stable catalog of configurable guardrails (id + phase) and accept `guardrails: { [id]: boolean }` in the runtime configuration; unknown ids or non-boolean values SHALL be rejected. Every listed guardrail SHALL be ON unless its value is `false`, and switching one off SHALL change only that behaviour. Guardrails SHALL apply only to the compact (local-engine) loop; CLI providers are unaffected.

#### Scenario: Guard switched off
- **WHEN** `guardrails: { 'frozen-plan-writes': false }` and the developer writes under `openspec/`
- **THEN** the write lands and no refusal is returned to the model

#### Scenario: Unset means on
- **WHEN** the configuration carries no `guardrails`
- **THEN** every guardrail behaves exactly as before this change

### Requirement: Desktop shows and edits the guardrails per project
Desktop SHALL read the catalog from the loaded Core (`configurableGuardrails` capability) and render, in project settings ▸ Agent engine, one switch per guardrail grouped by phase with a title, description and rationale; switches default to on and persist only `false` values through the runtime configuration. Desktop SHALL forward `guardrails` to Core only when Core advertises the capability, and SHALL render the section disabled when it does not.

#### Scenario: Older Core
- **WHEN** the loaded Core does not advertise `configurableGuardrails`
- **THEN** the section is disabled with a note and a saved `guardrails` map is not sent to that Core
