## ADDED Requirements

### Requirement: Search pill hidden in Agent Mode

The title-bar search pill SHALL NOT render when `uiMode==='agent'`, at both title-bar mount sites (macOS overlay and default). In Kanban Mode the pill SHALL render exactly as specified today. The command palette's global Cmd+K listener SHALL keep working regardless of `uiMode`, so the shortcut remains available with the pill hidden.

#### Scenario: Pill hidden in Agent Mode
- **WHEN** `uiMode==='agent'`
- **THEN** the title-bar search pill is not present in the DOM

#### Scenario: Pill present in Kanban Mode
- **WHEN** `uiMode==='kanban'`
- **THEN** the title-bar search pill renders as specified

#### Scenario: Cmd+K still opens the palette
- **WHEN** the user presses Cmd+K in Agent Mode with the pill hidden
- **THEN** the command palette opens

### Requirement: Sidebar Search button in Agent Mode

In Agent Mode the left sidebar SHALL render a Search button that opens the same command palette as the title-bar pill, by dispatching the equivalent Cmd+K keydown. It SHALL be cross-platform (the palette accepts `metaKey || ctrlKey`).

#### Scenario: Sidebar Search opens the palette
- **WHEN** the user clicks the sidebar Search button in Agent Mode
- **THEN** the command palette opens
