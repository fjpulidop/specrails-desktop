## Why

Mission application processes can survive a requested stop because the shell exits before its descendants and the escalation is cancelled prematurely. Process chips also lack an inspectable log view, hiding the evidence needed to diagnose startup and shutdown failures.

## What Changes

- Track process execution identities and confirmed lifecycle transitions; stop the owned process group/tree with bounded escalation and honest error reporting.
- Make chip body clicks open a log inspector while its close control only requests stop.
- Provide bounded, searchable stdout/stderr with live following, pause, metadata, copying/export, truncation notices and retained terminal logs.
- Reconcile HTTP and WebSocket state across reconnects without resurrecting old processes, hiding failed stops or confusing reused PIDs.
- Align mission MCP discovery, launching, stopping and logs with repository and conversation ownership.

## Capabilities

### New Capabilities

- `mission-process-logs`: Interactive, scoped process log inspection and bounded output retrieval.

### Modified Capabilities

- `agent-mode-background-processes`: Reliable stop lifecycle, stable execution identity and observable chips.

## Impact

Background process registry and teardown, project process routes, Specrails jobs MCP and operator guidance, client process context/chips/composer, log dialog and all eight UI locales. Existing multi-repository and live message work stays on this branch. No new external service or dependency is required.
