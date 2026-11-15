# Spec Delta

## MODIFIED Requirements

### Requirement: History remains discoverable in the mission
The mission composer SHALL provide access to scoped process history after completed chips expire. The history SHALL support finding an execution and opening its logs with localized status and recovery information. Processes SHALL first open a non-modal hover/focus/click popover containing up to eight executions, unfinished first and newest first within each group, with access to the full history modal.

#### Scenario: Return to an earlier failure
- **WHEN** the user reloads the mission after its failed-process chip expires
- **THEN** the history SHALL still list the retained execution
- **AND** selecting it SHALL open its inspector without affecting another process.

#### Scenario: Inspect from the compact list
- **WHEN** the user hovers, focuses or clicks Processes
- **THEN** its compact process list SHALL open and refresh on mount
- **AND** selecting an execution SHALL open that execution's inspector

#### Scenario: Open full history without changing a draft
- **WHEN** the user opens Processes, chooses View all processes and closes the history modal
- **THEN** the unsent mission draft SHALL remain intact
- **AND** no mission message SHALL be sent
