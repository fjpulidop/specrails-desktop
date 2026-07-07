## ADDED Requirements

### Requirement: Agent Mode exposes provider-gated Integrations

Agent Mode SHALL show an Integrations entry in the right workspace sidebar immediately after the Files entry when `sectionVisibleForProviders('integrations', providers)` returns true for the active project's providers.

#### Scenario: Integrations appears after Files
- **GIVEN** Agent Mode is open with an active project whose providers can see the integrations section
- **WHEN** the right workspace sidebar renders with the Files entry enabled by feature flags
- **THEN** the sidebar SHALL render an Integrations entry immediately after Files

#### Scenario: Provider gate hides Integrations
- **GIVEN** Agent Mode is open with an active project whose providers do not satisfy `sectionVisibleForProviders('integrations', providers)`
- **WHEN** the right workspace sidebar renders
- **THEN** the Integrations entry SHALL NOT be shown

### Requirement: Agent Mode Integrations opens in a movable modal

Clicking the Agent Mode Integrations entry SHALL open a modal over the current Agent Mode workspace instead of navigating to the board-mode `/integrations` route. The modal SHALL use the same near-fullscreen custom-overlay pattern as `JobDetailModal`: portal to `document.body`, `fixed inset-0 z-[65]`, `glass-card` panel, and `useMovableResizableModal` with minimum dimensions of 320 by 200.

#### Scenario: Sidebar click opens modal without navigation
- **GIVEN** Agent Mode is open on an active conversation or empty composer
- **WHEN** the user clicks the Integrations sidebar entry
- **THEN** the current Agent Mode workspace SHALL remain mounted
- **AND** an Integrations modal SHALL open above it
- **AND** the app SHALL NOT navigate to `/integrations`

#### Scenario: Modal can be closed back to Agent Mode
- **GIVEN** the Agent Mode Integrations modal is open
- **WHEN** the user activates the modal close control or closes through the backdrop
- **THEN** the modal SHALL close
- **AND** the user SHALL remain in the same Agent Mode workspace

### Requirement: Modal renders existing Integrations content

The Agent Mode Integrations modal SHALL render the same integration management content as board mode's `IntegrationsPage`, including Jira integration content and plugin cards, while preserving the existing install/uninstall confirmation dialogs nested inside that page.

#### Scenario: Existing content appears in modal
- **GIVEN** the Agent Mode Integrations modal is open for an active project
- **WHEN** integrations data is loaded
- **THEN** the modal SHALL display the Jira integration card and applicable plugin cards from `IntegrationsPage`

#### Scenario: Confirmation dialogs remain nested
- **GIVEN** the Agent Mode Integrations modal is open
- **WHEN** the user starts an install or uninstall flow from an integration card
- **THEN** the existing IntegrationsPage confirmation dialog SHALL open inside the modal flow
- **AND** board mode's Integrations route behavior SHALL remain unchanged
