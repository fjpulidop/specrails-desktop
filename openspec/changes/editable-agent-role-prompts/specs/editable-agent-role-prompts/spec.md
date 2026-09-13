## ADDED Requirements
### Requirement: Global role definition editor
Desktop SHALL expose the actual factory definitions and editable global overrides for architect, developer and reviewer beside provider connections.
#### Scenario: Edit and reset a role
- **WHEN** a user changes a role definition and saves
- **THEN** reopening settings shows the saved definition independently of provider
- **AND** restoring the role default and saving removes its override without changing other roles
#### Scenario: Invalid data or storage failure
- **WHEN** a definition is blank, oversized, contains a null byte or belongs to an unknown role, or saving fails
- **THEN** settings report an error and retain the last valid saved configuration
### Requirement: Freeze effective role definitions per job
New jobs SHALL resolve global definitions at admission and freeze them with their configuration while retaining dynamic scope, OpenSpec execution and output contracts.
#### Scenario: Global settings change after admission
- **WHEN** a saved job resumes after its global role definition was edited
- **THEN** it uses its original configuration and does not reread current prompt settings
#### Scenario: A new job uses an override
- **WHEN** a job starts with a custom developer definition
- **THEN** the developer receives that definition with the current spec context and required output contract through the selected provider
