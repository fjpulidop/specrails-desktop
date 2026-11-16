## Purpose

Let Blueprint users persist their usual AI configuration for future milestone generation and choose a temporary configuration without changing that preference.

## ADDED Requirements

### Requirement: Project-scoped generation preference
The system SHALL expose GET and PUT project Blueprint generation-settings routes for provider, model and nullable reasoningEffort. A valid save SHALL persist only for that project and future milestone conversations, surviving router recreation without changing project primary, day-0 defaults, ordinary chats or existing conversations.

#### Scenario: Save and reopen
- **WHEN** a user saves Codex, a compatible model and high effort and the project's router is recreated
- **THEN** GET returns that selection, another project's preference is unchanged, and an ordinary conversation still uses its ordinary provider

### Requirement: Compatible configuration catalog
Settings SHALL offer only installed providers supporting native read-only policy, their models and model-specific effort levels. With no saved preference, the compatible project primary or first compatible installed provider SHALL supply the default. A well-shaped unavailable saved preference SHALL remain visible.

#### Scenario: Filter incompatible provider
- **WHEN** the project has Claude, Codex and a provider lacking read-only support installed
- **THEN** the settings catalog contains only the compatible installed providers

#### Scenario: No saved choice
- **WHEN** no generation preference is stored
- **THEN** settings return the compatible primary provider's default model and null effort, or the first compatible provider if the primary is incompatible

### Requirement: Validate preference before persistence
PUT SHALL reject unavailable providers, incompatible models and unsupported effort with HTTP 400 before changing the saved preference. Null effort SHALL mean provider default.

#### Scenario: Invalid update preserves choice
- **WHEN** a saved valid configuration is followed by PUT with an unknown provider, wrong model or invalid effort
- **THEN** each invalid request returns 400 and GET retains the valid configuration

### Requirement: Sidebar usual configuration and milestone exception
For the next planned milestone, the Blueprint flyout SHALL let users save their usual provider/model/effort and optionally select another configuration for that milestone only. Generate SHALL emit a snapshot of the effective selection. Changing provider SHALL reset model to its default and clear effort; changing model SHALL clear effort.

#### Scenario: Save usual configuration
- **WHEN** a user changes provider and effort, saves, closes and reopens the controls
- **THEN** the saved values are restored and Generate uses them

#### Scenario: Temporary exception
- **WHEN** a user enables the milestone exception and chooses another model and effort
- **THEN** Generate uses the exception without writing the usual preference, and disabling the exception restores the usual choice

### Requirement: Guard generation controls against unusable selections
Generation controls SHALL disable Generate while loading, saving, holding unsaved usual changes, or lacking an available effective selection. Load/save failures SHALL show an error. Unavailable selections SHALL offer explicit provider-default reset when a compatible catalog exists; corrected usual values SHALL require saving.

#### Scenario: Failed save blocks changed preference
- **WHEN** saving edited usual values fails
- **THEN** an error is visible, the previous saved values remain unchanged and Generate stays disabled while edits remain unsaved

#### Scenario: Obsolete effort
- **WHEN** a saved effort is no longer offered
- **THEN** Generate is disabled and using provider defaults prepares corrected values for an explicit save

### Requirement: Selection state respects project boundaries
Switching active project SHALL close the Blueprint flyout and generation shell. Responses from unmounted previous-project controls SHALL not replace the new project's configuration.

#### Scenario: Old response arrives late
- **WHEN** project A's settings resolve after controls have switched to project B
- **THEN** Generate uses project B's selection

### Requirement: Localized configuration controls
Generation and M1 execution configuration labels, error messages and recovery actions SHALL use matching builder locale keys across de, en, es, fr, it, ja, pt and zh.

#### Scenario: Shipped locales expose controls
- **WHEN** configuration controls are rendered in any shipped builder locale
- **THEN** the preference, milestone exception, provider default, save, unavailable/reset and execution/retry messages have localized entries
