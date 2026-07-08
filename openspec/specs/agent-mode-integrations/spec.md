# agent-mode-integrations Specification

## Purpose
TBD - created by archiving change add-integrations-entry-to-agent-mode-sidebar-with-full-size-modal. Update Purpose after archive.
## Requirements
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

### Requirement: Agent Mode SHALL highlight unread mission conversations

Agent Mode MUST visually distinguish mission conversations that receive assistant or system output while they are not visible to the user.

#### Scenario: Inactive mission receives assistant output
- **GIVEN** Agent Mode is open with mission conversation A selected
- **AND** mission conversation B is visible in the left sidebar
- **WHEN** an `agent_*` assistant or system output event arrives for mission conversation B
- **THEN** conversation B's `MessageSquare` icon SHALL use the theme alert accent
- **AND** conversation B's icon SHALL show a fast breathing glow when motion is allowed
- **AND** any existing streaming title shimmer for conversation B SHALL remain available

#### Scenario: Active mission receives output while app is hidden
- **GIVEN** mission conversation A is selected
- **AND** `document.visibilityState` is `hidden`
- **WHEN** assistant or system output arrives for mission conversation A
- **THEN** conversation A SHALL be marked unread in the left sidebar
- **AND** the unread alert SHALL remain until the conversation is visible again

#### Scenario: Selecting unread mission clears alert after load
- **GIVEN** mission conversation B is marked unread
- **WHEN** the user selects mission conversation B from the sidebar
- **AND** the conversation load succeeds
- **THEN** conversation B SHALL no longer be marked unread

#### Scenario: Returning visible clears active mission alert
- **GIVEN** mission conversation A is active and marked unread because output arrived while the document was hidden
- **WHEN** `document.visibilityState` changes to `visible`
- **THEN** conversation A SHALL no longer be marked unread
- **AND** unread alerts for other conversations SHALL remain unchanged

#### Scenario: Reduced motion disables unread animation
- **GIVEN** a mission conversation is unread
- **AND** the user prefers reduced motion
- **WHEN** the sidebar renders that conversation
- **THEN** the icon SHALL keep the static theme alert accent
- **AND** the icon SHALL NOT run the breathing glow animation

### Requirement: Agent Mode SHALL export the active mission transcript as plain text

The active Agent Mode mission title overflow menu MUST provide an action that downloads the currently loaded mission transcript as a `.txt` file.

#### Scenario: Export transcript from active mission menu
- **GIVEN** Agent Mode is showing an active mission with loaded messages
- **WHEN** the user opens the mission title overflow menu and chooses the transcript export action
- **THEN** the browser SHALL download a plain-text `.txt` file
- **AND** the filename SHALL be derived from a safe slug of the mission title or fall back to the mission id

#### Scenario: Exported transcript contains mission metadata and messages
- **GIVEN** the active mission has a title, id, pinned project metadata, and loaded messages
- **WHEN** the transcript text is generated
- **THEN** it SHALL include the mission title, mission id, project name and path when present, and export timestamp
- **AND** it SHALL include every currently loaded message in loaded chronological order
- **AND** each message SHALL include a readable role label, timestamp, and plain-text content while preserving multiline message content

#### Scenario: Export failure is localized and non-destructive
- **GIVEN** Agent Mode is showing an active mission
- **WHEN** the browser download setup fails
- **THEN** the app SHALL show a localized export failure toast
- **AND** the active mission and loaded messages SHALL remain unchanged

### Requirement: Agent Mode SHALL copy the active mission transcript to the clipboard

The active Agent Mode mission title overflow menu MUST provide an action that copies the currently loaded mission transcript to the clipboard.

#### Scenario: Copy transcript from active mission menu
- **GIVEN** Agent Mode is showing an active mission with loaded messages
- **WHEN** the user opens the mission title overflow menu and chooses the copy transcript action
- **THEN** the app SHALL write the full plain-text transcript to `navigator.clipboard`
- **AND** the copied transcript SHALL use the same content format as the exported `.txt` transcript

#### Scenario: Clipboard failure is localized and non-destructive
- **GIVEN** Agent Mode is showing an active mission
- **WHEN** writing the transcript to the clipboard fails
- **THEN** the app SHALL show a localized copy failure toast
- **AND** the active mission and loaded messages SHALL remain unchanged

### Requirement: Mission transcript actions SHALL preserve existing header actions

Adding transcript actions MUST NOT change the behavior of existing Agent Mode mission title menu actions.

#### Scenario: Existing mission menu actions continue to work
- **GIVEN** Agent Mode is showing an active mission
- **WHEN** the user uses rename, favorite, delete, copy mission name, copy mission id, copy project name, or copy project path from the mission title menu
- **THEN** each existing action SHALL keep its previous behavior

