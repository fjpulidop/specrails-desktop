## MODIFIED Requirements

### Requirement: Two-mode segmented control in Add Spec
The `Add Spec` modal SHALL render a segmented control with the modes `Intent`, `Quick`, `Explore` and `Raw`, and SHALL NOT render the legacy `Explore codebase` checkbox. `Intent` MUST be selected by default whenever the selected engine can generate specs. When it cannot, `Raw` MUST be selected, as before. The user's mode choice MUST persist for the duration of the modal session and reset when the modal closes.

#### Scenario: Intent is the default
- **WHEN** the user opens the Add Spec modal with a usable spec engine
- **THEN** the `Intent` mode is selected
- **AND** the composer placeholder asks for the problem, the outcome sought and how the user will know it worked, not for the solution
- **AND** the legacy `Explore codebase` checkbox is not present anywhere in the modal

#### Scenario: Switching mode preserves the typed idea
- **WHEN** the user types text in the composer and switches between modes
- **THEN** the typed text is preserved
- **AND** the submit button label updates to reflect the selected mode (`Generate intent and spec` for Intent, `Generate Spec` for Quick, `Continue` for Explore)

#### Scenario: Modal close resets mode
- **WHEN** the user closes the modal in Explore mode and reopens it
- **THEN** the modal opens in Intent mode again

## ADDED Requirements

### Requirement: Intent mode generates the intent and derives the spec
In `Intent` mode the user's text, attachments and the selected model SHALL be sent to `POST /api/projects/:projectId/tickets/generate-spec` with `intent: true`. The modal SHALL close and a toast SHALL track progress, as in Quick mode. The server SHALL first author the intent from the user's text with the five sections and no solution. Where the text does not settle something, it SHALL leave that as an open question rather than invent it. The server SHALL then author the spec from that intent under the premium spec contract, and persist the spec with its intent. A generation whose intent fails validation SHALL fall back to a Quick-mode spec without an intent, and the toast SHALL say so.

#### Scenario: Intent submit
- **WHEN** the user describes a problem in Intent mode and submits
- **THEN** a `POST /api/projects/<id>/tickets/generate-spec` is sent with `{ idea, attachmentIds, pendingSpecId, model, intent: true }`
- **AND** the created spec carries an intent whose problem reflects the user's text

#### Scenario: The user's text is solution-shaped
- **WHEN** the text says "add a Redis cache to the API"
- **THEN** the intent's outcome SHALL describe what the cache is for, and "Redis cache" SHALL appear as a constraint or an open question
