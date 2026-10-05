## ADDED Requirements

### Requirement: Relaunch preserves optional workspace defaults
Relaunch SHALL omit workspaceSelection when its source manifest records no explicit workspace narrowing. It SHALL retain all selected repository IDs, preserve nonempty partial selections and give saved explicit selections precedence. Invalid explicit selections MUST still be rejected before assignment restoration or execution.

#### Scenario: Multi-repository delivery using defaults
- **WHEN** a failed delivery includes repositories with no selected workspace paths
- **THEN** Relaunch admits the original repository scope without generating an empty workspace-selection map

#### Scenario: Partial narrowing
- **WHEN** only one repository in the manifest records selected workspace paths
- **THEN** Relaunch retains that selection and defaults for the other selected repositories

#### Scenario: Explicit invalid selection
- **WHEN** saved launch options contain an empty path array or a path no longer registered
- **THEN** Relaunch rejects the selection without restoring assignments or launching work

### Requirement: Launch-card projection omits exhausted workspace selections
A launch card SHALL omit workspaceSelection when repository edits leave no selected repository with an explicit workspace entry. Projection MUST preserve any entries belonging to retained repositories without relaxing server validation.

#### Scenario: Last narrowed repository removed
- **WHEN** the user removes the last repository having an explicit workspace selection
- **THEN** the next launch payload omits workspaceSelection instead of sending an empty object
