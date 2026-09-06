## ADDED Requirements

### Requirement: Shared backlog with explicit repository scope
A project SHALL retain one shared backlog. A spec SHALL support a nonempty, unique selection of repository IDs belonging to its project. Historical specs without a selection SHALL retain primary-only scope.

#### Scenario: One spec changes frontend and backend
- **WHEN** a spec selects the frontend and backend repositories
- **THEN** it SHALL remain one spec with one ID and its launch SHALL include both repositories

#### Scenario: Member is added after historical specs exist
- **WHEN** a project gains a repository
- **THEN** specs without an explicit selection SHALL continue targeting the primary rather than silently expanding their scope

#### Scenario: Launch attempts to omit a required repository
- **WHEN** an explicit launch selection excludes a repository required by an assigned spec
- **THEN** the launch SHALL fail before Git preparation or provider execution and identify the missing members

### Requirement: Preserve scope through authoring and integration
Spec creation, draft persistence, editing, mission authoring and Jira refreshes SHALL preserve validated repository selections. Repository scope SHALL remain local project metadata while Jira status and ticket effects remain shared.

#### Scenario: Jira refresh
- **WHEN** a linked Jira issue is refreshed after a local repository selection
- **THEN** the refreshed spec SHALL retain its repository IDs and existing Jira mapping

#### Scenario: Invalid scope during authoring
- **WHEN** a creation or edit supplies an empty, duplicate or foreign repository selection
- **THEN** it SHALL fail without partially replacing the previous valid spec
