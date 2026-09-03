# agent-chat-project-selector Specification

## Purpose
TBD - created by archiving change add-desktop-agent-chat. Update Purpose after archive.
## Requirements
### Requirement: Cursor-style project selector pins the agent's target project
The agent panel SHALL provide a header dropdown — with a search field, a Recents list, the full project list, and footer actions — that selects which project the agent operates on, pinning it for the conversation via `specrails_select_project`.

#### Scenario: Selecting a project scopes the agent
- **WHEN** the user picks a project from the dropdown
- **THEN** the agent pins that project (`specrails_select_project`)
- **AND** subsequent project-relative requests (e.g. "launch the high-priority ones") resolve against that project

#### Scenario: Selector search filters projects
- **WHEN** the user types in the dropdown search field
- **THEN** the project list filters to matching projects

### Requirement: Home mode operates app-globally and asks when ambiguous
When the selector is set to `Home` (no project), the agent SHALL operate at the app level (list/create projects, cross-project queries) and SHALL ask the user to choose or create a project when a request is project-specific but no project is pinned.

#### Scenario: Home handles a global request
- **WHEN** the selector is `Home` and the user asks an app-level question (e.g. "list my projects")
- **THEN** the agent answers without pinning any project

#### Scenario: Home asks on an ambiguous project request
- **WHEN** the selector is `Home` and the user makes a project-specific request without naming a project
- **THEN** the agent asks whether to create a new project or search across all projects, rather than guessing

### Requirement: Selector defaults to the open project and is decoupled from the dashboard view
The selector SHALL default to the dashboard's currently-open project when one is active (otherwise `Home`), be freely overridable, and changing it SHALL NOT change the user's dashboard view.

#### Scenario: Default follows the open project
- **WHEN** the agent chat is opened while a project is active in the dashboard
- **THEN** the selector defaults to that project

#### Scenario: Changing the agent's project does not move the dashboard
- **WHEN** the user changes the agent's selected project (or the agent pins a different one)
- **THEN** the user's dashboard view and active project are unaffected

### Requirement: Cross-project search via project fan-out (v1)
The selector SHALL offer a "search across all projects" action that the agent fulfills by enumerating projects and querying each, since native cross-project search is not yet a capability.

#### Scenario: Search across all projects
- **WHEN** the user invokes "search across all projects" with a query
- **THEN** the agent enumerates projects and queries each, returning aggregated results
