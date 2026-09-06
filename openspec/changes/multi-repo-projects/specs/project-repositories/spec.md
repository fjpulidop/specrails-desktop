## ADDED Requirements

### Requirement: Stable repository membership
The system SHALL represent a project as a logical owner of one primary and zero or more additional repository memberships with stable IDs and canonical paths, without duplicating its backlog or integration configuration.

#### Scenario: Existing project is upgraded
- **WHEN** the migration loads a project registered with one path
- **THEN** it SHALL retain its project ID, primary path, workspace and history and create one primary repository membership

#### Scenario: Create a project with several roots
- **WHEN** a user submits a primary root and additional roots
- **THEN** all roots SHALL be validated before registration and the resulting project SHALL expose their stable memberships
- **AND** invalid or duplicate input SHALL leave no partially registered project

### Requirement: Safe membership management
Users SHALL be able to add, rename and detach secondary members in existing projects. Detaching SHALL remove only the membership and SHALL NOT remove filesystem contents. Primary replacement and removal SHALL be rejected in this workflow.

#### Scenario: Add to an existing project
- **WHEN** a valid secondary repository is added
- **THEN** its membership SHALL appear in project settings and mission context without changing existing spec IDs or Jira mappings

#### Scenario: Member is still needed
- **WHEN** removal or relocation targets a member referenced by specs, active execution or pending delivery
- **THEN** the server SHALL reject the operation with a reason and preserve the membership and files

#### Scenario: Repository belongs to another project too
- **WHEN** a physical repository is added as a secondary member of another project
- **THEN** each project's backlog SHALL remain independent and Git mutations SHALL share canonical repository locking

### Requirement: Repository availability and path resolution
The system SHALL distinguish a registered but unavailable member from an unknown member. Repository IDs SHALL be validated against the selected project, and path resolution SHALL report ambiguity when several secondary memberships match without a usable project context.

#### Scenario: Foreign repository ID
- **WHEN** a request selects a repository ID from a different project
- **THEN** it SHALL fail without resolving to the primary or accessing the foreign root

#### Scenario: Additional folder has no Git repository
- **WHEN** a user registers an additional non-Git folder
- **THEN** the system SHALL expose it as context and SHALL reject it as an isolated multi-repository write target
