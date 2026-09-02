## ADDED Requirements

### Requirement: Provider and model selection change atomically

The Add Spec modal SHALL treat provider and model as one validated pair and SHALL prevent submission while the selected provider's model catalog is unresolved.

#### Scenario: User changes provider

- **WHEN** the user changes the AI Engine from one provider to another
- **THEN** the modal MUST immediately invalidate the prior provider's selected model and allowed-model list
- **AND** display model loading state for the newly selected provider
- **AND** disable button and keyboard submission until resolution completes

#### Scenario: New provider catalog resolves

- **WHEN** the latest model-catalog request resolves for the selected provider
- **THEN** the modal MUST select that provider's resolved default or another model valid for that provider
- **AND** submission MUST send the selected provider and its matching model together

#### Scenario: Catalog responses arrive out of order

- **WHEN** a stale response for a previously selected provider arrives after the latest provider response
- **THEN** the stale response MUST NOT replace the current provider, model, catalog, or loading state

#### Scenario: Submission has no resolved model

- **WHEN** the selected provider is known but no valid model has resolved
- **THEN** the client MUST NOT substitute a Claude-specific model such as `sonnet`
- **AND** it MUST either keep submission disabled or omit the model so the server resolves the selected provider's default
