## 1. Durable execution storage

- [x] 1.1 Implement bounded SQLite execution/log storage, partial-line upserts and write failure diagnostics.
- [x] 1.2 Integrate lifecycle batching, final/shutdown flush and disconnected recovery without PID adoption.
- [x] 1.3 Verify persistence across reopened databases, retention and scoped ownership with isolated tests.

## 2. API and mission integration

- [x] 2.1 Initialize/close persistence with the server; expose retained REST/MCP reads and reject historical process signalling.
- [x] 2.2 Update mission launch/failure guidance and lifecycle cleanup for durable histories.

## 3. Mission interface

- [x] 3.1 Add searchable process history independent of chip expiry and reconnect state.
- [x] 3.2 Localize recovered/persistence states and verify inspector/history behavior.

## 4. API routing recovery

- [x] 4.1 Align development/native HTTP, auth and WebSocket addresses with the IPv4 server and configured ports.
- [x] 4.2 Handle unexpected API responses with localized errors, preserved drafts and stable retry identities; add regressions.

## 5. Verification and documentation

- [x] 5.1 Run affected regression suites, typecheck/build and visual history checks; document retention, recovery and fixes.
