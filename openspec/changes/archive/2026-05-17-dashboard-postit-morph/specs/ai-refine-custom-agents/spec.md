## ADDED Requirements

### Requirement: AI Refine regenerates short_summary when description changes

The AI Refine flow (`server/modules/agents/runtime/agent-refine-manager.ts`) SHALL request a `shortSummary` field in the refine response prompt, and SHALL update the ticket's `short_summary` only when the model returns a non-empty value.

#### Scenario: Refine returns new summary
- **WHEN** AI Refine returns a response with `shortSummary`
- **THEN** the ticket's `short_summary` is updated to the new trimmed value
- **AND** the WS `ticket_updated` event includes the new summary

#### Scenario: Refine omits summary
- **WHEN** AI Refine returns a response without `shortSummary` (or with an empty string)
- **THEN** the ticket's existing `short_summary` is preserved (not overwritten to null)

#### Scenario: Refine only touches summary alongside content changes
- **WHEN** AI Refine does not change title or description
- **THEN** `short_summary` is left untouched regardless of what the model returns
