## ADDED Requirements

### Requirement: Project runtime settings persist setup commands

The project runtime configuration SHALL accept an optional `setup` list with the same entry shape as `verification`, validated by the vendored Core schema, persisted in `.specrails/agent-runtime.json` and returned by the settings API as an array (empty when absent).

#### Scenario: Save and reload

- **WHEN** the user saves a setup command `npx playwright install chromium` for repository `app`
- **THEN** the settings file contains it under `setup`, a reload returns it and `verification` is unchanged

#### Scenario: Invalid entry

- **WHEN** a setup entry lacks a repository id or declares a credential-like env key
- **THEN** the save is rejected with the same validation message family as verification entries

### Requirement: Setup commands reach Core only when supported

The runtime bridge SHALL forward `setup` to Core only when the advertised capabilities include `setupCommands`; otherwise it SHALL strip the list and record a one-line runtime note.

#### Scenario: Supported Core

- **WHEN** Core advertises `setupCommands: 1`
- **THEN** the configuration sent to Core includes `setup`

#### Scenario: Older Core

- **WHEN** Core does not advertise `setupCommands`
- **THEN** the configuration sent to Core omits `setup` and validation on the Core side succeeds

### Requirement: The Agent Runtime settings section edits setup commands

The settings UI SHALL render a "Setup commands" editor below the verification checks with repository selection, command line, label, reorder and remove controls, the same line validation as verification rows, no auto-detect action, and a hint explaining that commands must be idempotent and run before every verification.

#### Scenario: Add and save

- **WHEN** the user adds a setup row and saves
- **THEN** the PUT payload contains `setup` with the parsed command and args, and the saved indicator appears

#### Scenario: Localization

- **WHEN** the app runs in any of the eight shipped locales
- **THEN** every setup editor string is translated
