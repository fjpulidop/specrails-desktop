## ADDED Requirements

### Requirement: Agent chat SHALL launch confirmed background shell commands

The agent chat MUST require explicit user confirmation before invoking a project-scoped background shell command action.

#### Scenario: Agent proposes a long-running command
- **WHEN** the user asks the agent to run a likely long-running command such as a dev server or watcher
- **THEN** the agent proposes running it in the background and waits for the user's confirmation before invoking the background start action

#### Scenario: Background command starts
- **WHEN** the user confirms the launch
- **THEN** the server starts the command in the selected project cwd and broadcasts `background_process.started` with pid, command, cwd, startedAt, status, chatId, and projectId

### Requirement: Background processes SHALL be scoped to the launching chat

Background process chips MUST only be visible in the agent chat panel that launched them and MUST NOT survive project or chat switches.

#### Scenario: Process launched in one chat
- **WHEN** a background process is launched from chat A
- **THEN** chat A shows the chip and chat B does not show it

#### Scenario: Project changes
- **WHEN** the active project changes away from the project that launched the process
- **THEN** the background process chip is no longer visible in the composer

### Requirement: Composer SHALL show append-only background process chips

The composer MUST render active background processes as chips above the input, in launch order, without reordering active chips.

#### Scenario: Multiple processes are active
- **WHEN** two or more background processes are started in the same chat
- **THEN** chips are appended in start order and each active chip uses a distinct rotated accent variant while variants are available

#### Scenario: Theme changes
- **WHEN** the app switches between light and dark themes
- **THEN** chips continue to use theme accent CSS variables instead of hardcoded colors

### Requirement: Background process chips SHALL expose elapsed time and immediate kill

Each background process chip MUST show a close control and an elapsed-time tooltip on hover, and close MUST kill immediately without confirmation.

#### Scenario: Hovering a running chip
- **WHEN** the user hovers over a background process chip
- **THEN** the X control and a tooltip with total elapsed time since launch are visible

#### Scenario: Killing from the chip
- **WHEN** the user clicks the X on a background process chip
- **THEN** the server kills the registered process tree immediately without a confirmation dialog and removes or terminally updates the chip

### Requirement: Background process lifecycle SHALL prevent orphaned children

The server MUST terminate background shell children when the user kills them, when they exit themselves, when their project closes, and when the app shuts down.

#### Scenario: Process exits by itself
- **WHEN** a background process exits or fails without user action
- **THEN** the server broadcasts `background_process.exited` with the terminal status and the client updates or removes the chip

#### Scenario: Project or app closes
- **WHEN** a project is removed or Specrails Desktop shuts down
- **THEN** all active background processes for that project are tree-killed and removed from the registry
