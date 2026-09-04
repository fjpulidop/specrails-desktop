# agent-conversation-history Specification

## Purpose
TBD - created by archiving change switch-to-agent-mode. Update Purpose after archive.
## Requirements
### Requirement: Conversations grouped by project

In Agent Mode the left sidebar SHALL group agent conversations by `pinned_project_id`, rendering each conversation as an expandable child under its pinned project row, and rendering conversations with a `null` pin under a synthetic **Home** group. Grouping SHALL be derived from the existing app-global `conversations` list without any schema change.

#### Scenario: Conversation nests under its project
- **WHEN** a conversation has `pinned_project_id` equal to a project's id
- **THEN** it renders as an indented child of that project's row

#### Scenario: Null-pinned conversation under Home
- **WHEN** a conversation has `pinned_project_id === null`
- **THEN** it renders under the Home group, not under any project

#### Scenario: Untitled fallback
- **WHEN** a conversation has a `null` title
- **THEN** the row shows an "Untitled" fallback label

### Requirement: Expandable project trees

Each project row SHALL expose a chevron that toggles expansion independently of row activation, and the chevron SHALL appear only when the project has at least one conversation. Expansion state SHALL persist to `localStorage` under `specrails-desktop:agentTreeExpanded` and default to expanding the active project.

#### Scenario: Chevron toggles without activating
- **WHEN** the user clicks the chevron on a project row
- **THEN** the tree expands/collapses and the project's active state is unchanged by the chevron click

#### Scenario: No chevron for empty project
- **WHEN** a project has zero conversations
- **THEN** no expand chevron renders for it in Agent Mode

#### Scenario: Expansion persists
- **WHEN** the user expands a project and reloads
- **THEN** the same project renders expanded

### Requirement: Project-row and conversation click semantics

In Agent Mode, clicking a project row SHALL set it as the active project and toggle its expansion, WITHOUT navigating routes. Clicking a conversation SHALL load it via `selectConversation(id)` and ensure `uiMode==='agent'`, highlighting the active conversation. In Kanban, project-row click behavior SHALL remain unchanged (navigates as today).

#### Scenario: Agent project click sets active without navigation
- **WHEN** `uiMode==='agent'` and the user clicks a project row body
- **THEN** the active project is set and no route navigation occurs

#### Scenario: Kanban project click still navigates
- **WHEN** `uiMode==='kanban'` and the user clicks a project row
- **THEN** it navigates to the dashboard as before

#### Scenario: Conversation click opens thread
- **WHEN** the user clicks a conversation row
- **THEN** `selectConversation` loads it, the thread shows, and the row is highlighted as active

### Requirement: New Agent action

The sidebar SHALL render a **New Agent** button in Agent Mode that starts a fresh conversation, defaulting its pin to the currently active project (or Home when none). The `newConversation(projectId?)` API SHALL accept an explicit project id while preserving the existing arg-less behavior (pins `active?.pinned_project_id ?? null`).

#### Scenario: New Agent pins to active project
- **WHEN** a project is active and the user clicks New Agent
- **THEN** a new conversation is created pinned to that project

#### Scenario: New Agent from Home
- **WHEN** no project is active and the user clicks New Agent
- **THEN** a new conversation is created with a `null` pin (Home)

### Requirement: Standalone conversation refresh

The agent chat context SHALL expose a `refreshConversations` action that refreshes the conversation list WITHOUT setting panel visibility to `open` (so the suppressed floating panel is not mounted). Entering Agent Mode SHALL use this action rather than `open()`.

#### Scenario: Refresh does not open the floating panel
- **WHEN** `refreshConversations` is called on entering Agent Mode
- **THEN** the conversation list updates and the floating panel does not mount
