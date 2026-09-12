## Why

Mission application logs currently disappear after memory retention or a server restart, making failed startup diagnostics unavailable. In development, requests to `localhost:4200` can reach an unrelated project frontend on IPv6 while Specrails listens on IPv4, breaking mission sends with an HTML-as-JSON error.

## What Changes

- Persist execution metadata and bounded stdout/stderr in a dedicated local SQLite history, with batched writes and recovery after restart.
- Expose retained executions through mission process history and the existing log inspector, independently of short-lived chips.
- Mark recovered unmanaged executions explicitly disconnected without assuming their OS processes stopped or adopting old PIDs.
- Route Specrails requests to its actual loopback address; handle invalid API responses without losing drafts or replaying uncertain sends.
- Keep REST, MCP, lifecycle cleanup and operator diagnostics consistent with persistent history.

## Capabilities

### New Capabilities

- `mission-process-history`: Durable, bounded execution history with truthful restart recovery and inspectable mission UI.
- `mission-api-routing`: Unambiguous application API routing and recoverable errors when development servers share a numeric port across address families.

### Modified Capabilities

- `web-dev-ports`: Explicit IPv4 API/proxy/WebSocket addressing, aligned environment fallback and fixed Vite port selection.

## Impact

Background process storage and startup/shutdown, REST/MCP process access, mission history UI and translations, API decoding and development/native loopback configuration. Extends `mission-process-observability` on this branch. Uses the existing SQLite dependency; no external service.
