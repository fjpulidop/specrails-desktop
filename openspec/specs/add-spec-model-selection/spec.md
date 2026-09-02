# add-spec-model-selection Specification

## Purpose
TBD - created by archiving change select-model-in-add-spec. Update Purpose after archive.
## Requirements
### Requirement: Model picker in Add Spec modal

The Add Spec modal SHALL render a single-model dropdown picker that is visible and operable in both Quick and Explore tabs. The picker MUST persist its selection when the user toggles between Quick and Explore within a single modal session. The picker MUST reset its selection when the modal closes and reopens.

#### Scenario: Picker is visible in both modes
- **WHEN** the user opens Add Spec
- **THEN** a model dropdown is rendered alongside the Quick / Explore tab control
- **AND** the same dropdown remains visible after toggling between Quick and Explore

#### Scenario: Selection persists across mode toggle within a session
- **WHEN** the user picks `opus` while in Quick mode
- **AND** switches to Explore mode without closing the modal
- **THEN** the dropdown still shows `opus` selected

#### Scenario: Selection resets on modal close
- **WHEN** the user picks `opus`, closes the modal, and reopens it
- **THEN** the dropdown shows the project's resolved default model selected

### Requirement: Provider-aware model list

The picker SHALL list only models valid for the active project's `provider`. Projects with `provider=claude` MUST see the Claude model list; projects with `provider=codex` MUST see the Codex model list. The model lists MUST be sourced from the server's `GET /api/projects/:projectId/default-spec-model` response (`allowed` field) — the client MUST NOT maintain its own copy of the provider model lists for this picker.

#### Scenario: Claude project shows Claude models
- **WHEN** the user opens Add Spec on a `provider=claude` project
- **THEN** the dropdown lists every entry from `CLAUDE_MODELS` and no Codex entries

#### Scenario: Codex project shows Codex models
- **WHEN** the user opens Add Spec on a `provider=codex` project
- **THEN** the dropdown lists every entry from `CODEX_MODELS` and no Claude entries

### Requirement: Default selection resolves from project config

On modal open, the picker's preselected value SHALL resolve in this order:
1. The project's `models.defaults.model` from `.specrails/install-config.yaml`, if it parses successfully AND is in the provider's allow-list.
2. The provider default (`sonnet` for `claude`, `gpt-5.4-mini` for `codex`).

The resolved default MUST be returned by a server endpoint (no client-side parsing of `install-config.yaml`).

#### Scenario: Project config default is honored
- **GIVEN** the project's install-config has `models.defaults.model: opus`
- **WHEN** the user opens Add Spec
- **THEN** the dropdown preselects `opus`

#### Scenario: Provider default fallback
- **GIVEN** the project has no readable `install-config.yaml`
- **WHEN** the user opens Add Spec on a Claude project
- **THEN** the dropdown preselects `sonnet`

#### Scenario: Invalid configured default falls back to provider default
- **GIVEN** the project's install-config references a model not in the provider's allow-list
- **WHEN** the user opens Add Spec
- **THEN** the dropdown preselects the provider default
- **AND** the server logs a warning identifying the invalid configured value

### Requirement: Quick mode submits selected model to generate-spec

In Quick mode, the modal's submit action SHALL include the picker's current value in the `POST /tickets/generate-spec` request body as `model`. The server SHALL use this value as the model for the spawned `claude` or `codex` process.

#### Scenario: Model is sent in body
- **WHEN** the user picks `haiku`, types an idea in Quick mode, and clicks `Generate Spec`
- **THEN** the request body includes `model: "haiku"` alongside `idea`, `attachmentIds`, `pendingSpecId`

#### Scenario: Server uses the model in the spawn args
- **GIVEN** a request body with `model: "opus"` on a `provider=claude` project
- **WHEN** the server spawns the `claude` process
- **THEN** the spawn args include `--model opus`

#### Scenario: Codex provider receives the model
- **GIVEN** a request body with `model: "gpt-5.4"` on a `provider=codex` project
- **WHEN** the server spawns the `codex` process
- **THEN** the spawn args include `--model gpt-5.4`

### Requirement: Explore mode seeds conversation with selected model

In Explore mode, the launch handler SHALL pass the picker's current value as `model` on the launch payload, and the server SHALL persist it as the conversation's `model` field from creation. Every subsequent assistant turn in the conversation MUST use that same model.

#### Scenario: Launch payload carries model
- **WHEN** the user picks `opus` and clicks `Continue` in Explore mode
- **THEN** the `onExploreLaunch` payload includes `model: "opus"`

#### Scenario: Conversation row stores the chosen model
- **WHEN** the Explore conversation is created from the launch payload
- **THEN** the conversation's `model` column equals the value from the launch payload

#### Scenario: Every turn uses the chosen model
- **GIVEN** an Explore conversation created with `model: "haiku"`
- **WHEN** the user sends three messages in a row
- **THEN** all three assistant responses are generated by `haiku`

### Requirement: No model-change UI downstream of Add Spec

The model combo box SHALL exist in exactly one place: the Add Spec modal. No surface reached after submitting Add Spec — including but not limited to the Explore overlay header, the Explore composer, the Explore restore-from-minimize flow, the Create Spec migration dialog, and the Quick-mode loading toast — SHALL render any control that mutates the chosen model. Once the user submits Add Spec, the model is immutable for the lifetime of that spec generation flow.

#### Scenario: Explore overlay shows no model picker
- **WHEN** the Explore overlay is mounted after Add Spec submit
- **THEN** no `<Select>`, dropdown, or button labeled or behaving as a model switcher is present anywhere in the overlay (header, composer, draft panel)

#### Scenario: Restored Explore session shows no model picker
- **WHEN** a minimized Explore session is restored from the dock
- **THEN** the restored overlay still shows no model-change UI
- **AND** the conversation continues to use its persisted model

#### Scenario: Quick toast shows no model picker
- **WHEN** the Quick generation toast is visible after submit
- **THEN** the toast offers no control to change the model

#### Scenario: Create Spec migration dialog shows no model picker
- **WHEN** the user clicks `Create Spec` from the Explore overlay
- **THEN** any confirmation or migration UI rendered shows no model-change control

### Requirement: Server validates model against provider allow-list

`POST /tickets/generate-spec` SHALL validate the `model` field against the active project's provider allow-list before spawning. Invalid values MUST result in HTTP 400 with a body of `{ error: string, allowed: string[] }` and MUST NOT spawn any subprocess. Missing or empty values MUST fall back to the project's resolved default model.

#### Scenario: Valid model is accepted
- **WHEN** a request arrives with `model: "sonnet"` on a Claude project
- **THEN** the server proceeds to spawn with `--model sonnet`

#### Scenario: Invalid model is rejected
- **WHEN** a request arrives with `model: "claude-vintage-2"` on a Claude project
- **THEN** the response status is 400
- **AND** the response body includes `allowed` listing the valid Claude model ids
- **AND** no subprocess is spawned

#### Scenario: Missing model falls back to default
- **WHEN** a request arrives with no `model` field
- **THEN** the server resolves the project's default model
- **AND** spawns the subprocess with that default

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
