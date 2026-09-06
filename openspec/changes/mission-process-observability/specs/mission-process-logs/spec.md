## ADDED Requirements

### Requirement: Process chips open an execution inspector
Clicking the body of a mission process chip SHALL open an accessible modal scoped to that execution. The close control SHALL only request process stop and SHALL NOT open the inspector.

#### Scenario: Inspect a running application
- **WHEN** the user clicks or keyboard-activates the chip body
- **THEN** the modal SHALL show command, cwd, execution status, elapsed time and captured stdout/stderr
- **AND** new output SHALL appear while the application is running.

#### Scenario: Stop from the chip
- **WHEN** the user presses the close control
- **THEN** the process SHALL enter the stop flow without opening the modal.

### Requirement: Logs remain explorable and bounded
The inspector SHALL support text search, stdout/stderr filters, pausing/following and copying or downloading the visible log view. Terminal control output SHALL be rendered as inert text and retained buffers SHALL have documented bounds.

#### Scenario: Search while output continues
- **WHEN** the user pauses or scrolls away and filters logs
- **THEN** arriving output SHALL NOT force them back to the bottom
- **AND** resuming follow SHALL reveal the latest output.

#### Scenario: Truncation and expired logs
- **WHEN** retained output is incomplete or a finished execution has expired
- **THEN** the inspector SHALL show that limitation explicitly and offer retry where applicable
- **AND** SHALL NOT substitute another execution that reused the same PID.

#### Scenario: Inspect after process exit
- **WHEN** a selected process finishes and its chip later disappears
- **THEN** the open inspector SHALL retain its terminal metadata and captured logs until closed.

### Requirement: API and MCP inspection preserve ownership
Log reads and process listing SHALL respect project/chat scope and supplied execution identity. MCP mission calls SHALL derive the chat from the active capability.

#### Scenario: Foreign or stale process reference
- **WHEN** a caller requests a different chat's process or a stale execution identity
- **THEN** the server SHALL refuse the read or stop without affecting that process.
