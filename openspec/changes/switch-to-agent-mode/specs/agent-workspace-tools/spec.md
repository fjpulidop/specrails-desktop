## ADDED Requirements

### Requirement: On-workspace toolbar

In Agent Mode the right `AgentWorkspaceSidebar` SHALL expose three tools — **Browser**, **Terminal**, and **Files** — styled coherently with the existing right-sidebar rail (semantic tokens, 200ms rail transitions). Each tool SHALL be disabled when there is no active project, with a tooltip explaining an active project is required. The sidebar SHALL render even when no project is active (Home conversations are first-class).

#### Scenario: Tools disabled without active project
- **WHEN** Agent Mode is active and `activeProjectId` is null
- **THEN** Browser, Terminal, and Files are disabled and show the "requires an active project" tooltip

#### Scenario: Tools enabled with active project
- **WHEN** a project is active
- **THEN** all three tools are enabled

### Requirement: Inline Terminal tool

The Terminal tool SHALL open the existing bottom terminal panel for the active project by toggling its visibility, reusing the app-level terminals context. The `BottomPanel` and `StatusBar` SHALL be a single hoisted instance shared by both modes so the terminal survives mode switches without recreating PTYs, and the footer chevron entry point SHALL be hidden in Agent Mode.

#### Scenario: Terminal button toggles the bottom panel
- **WHEN** the user clicks the Terminal tool with an active project
- **THEN** the hoisted bottom terminal panel toggles open/closed for that project

#### Scenario: Terminal survives a mode round-trip
- **WHEN** a terminal session is open and the user switches Kanban→Agent→Kanban
- **THEN** the same session persists with no blank/flicker (single-adopter invariant preserved)

#### Scenario: Footer chevron hidden in Agent Mode
- **WHEN** `uiMode==='agent'`
- **THEN** the StatusBar footer terminal chevron is absent (the Terminal tool is the entry point)

### Requirement: Inline Files (Code) tool

The Files tool SHALL open the Code explorer inline as a resizable split pane beside the conversation thread (Cursor-style), NOT by navigating to the `/code` route. It SHALL require an active project. Code selection SHALL persist per-conversation in Agent-Mode state (not the URL), and the split SHALL honor the code explorer's minimum-width constraints. A maximize affordance SHALL widen the code pane.

#### Scenario: Files opens an inline split pane
- **WHEN** the user clicks the Files tool with an active project
- **THEN** the Code explorer renders in a split pane beside the thread and the app URL does not change to `/code`

#### Scenario: Files disabled without project
- **WHEN** no project is active
- **THEN** the Files tool is disabled

#### Scenario: Selection persists per conversation
- **WHEN** the user selects a file, closes the pane, and reopens Files in the same conversation
- **THEN** the previously selected file is restored

### Requirement: Browser capture tool

The Browser tool SHALL reuse the Explore browser-capture flow (`BrowserCaptureModal` + capture helpers) for the active project, requiring an active project (capture sessions are project-scoped) and gated by the browser-capture feature flag. A capture SHALL be queued as a chip under the composer that rides the next manually-sent message (no auto-send).

#### Scenario: Browser capture produces a composer chip
- **WHEN** the user captures a region via the Browser tool
- **THEN** a capture chip appears under the composer and its attachments are included on the next send

#### Scenario: Browser requires active project
- **WHEN** no project is active
- **THEN** the Browser tool is disabled
