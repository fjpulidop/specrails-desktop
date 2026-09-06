## 1. Durable input and tool delivery

- [x] 1.1 Add a durable, idempotent mission input ledger with Stop/restart recovery and metadata preservation.
- [x] 1.2 Add a capability-bound MCP delivery broker and revision acknowledgement gate, including parallel-call and cancellation tests.
- [x] 1.3 Integrate live input preparation, transcript segmentation, fallback continuation and lifecycle cleanup into AgentChatManager.

## 2. Mission interface and contracts

- [x] 2.1 Extend HTTP/WebSocket events and snapshots for pending inputs, stable message IDs and current output.
- [x] 2.2 Render ordered steering messages, reconcile reload/reconnect races and preserve pending edits and attachments.
- [x] 2.3 Keep Send and Stop separately accessible and translate pending/delivered/undelivered labels.

## 3. Verification and documentation

- [x] 3.1 Test real manager/MCP integration, tool outcomes, concurrent updates, abort, restart and provider fallback with simulated providers.
- [x] 3.2 Run affected client/server regression suites, type checks and build; inspect the mission UI states.
- [x] 3.3 Document safe delivery points, provider limits and verification evidence; validate the OpenSpec change.

## 4. Native input during provider execution

- [x] 4.1 Verify native provider protocols and add Claude stream-json and Codex app-server transports without tool-killing steering.
- [x] 4.2 Integrate native receipts, exclusive delivery ownership, FIFO, attachment/reference preservation and ambiguous-write recovery.
- [x] 4.3 Update mission guidance and delivery labels while preserving MCP fallback and watch wakeups.
- [x] 4.4 Verify native protocol and real manager regressions, failure races, types and build; record evidence and limits.

## 5. Explicit pending-message controls

- [x] 5.1 Queue busy sends by default and add per-message Steer, delete and edit controls, retaining metadata and independent Send/Stop.
- [x] 5.2 Persist promotion/deletion idempotently and reject mutations after delivery owns an input.
- [x] 5.3 Verify UI actions, HTTP/WebSocket reconciliation and queue/native/MCP behavior, including delayed responses and other pending messages.

## 6. Message delivery checks

- [x] 6.1 Persist monotonic sent/received/read receipts with an additive migration and conservative legacy backfill.
- [x] 6.2 Confirm provider acceptance separately from reading, including scoped explicit native read acknowledgements and MCP revision acknowledgement.
- [x] 6.3 Replace visible delivery status text with gray single/double and green double checks, localized hover labels and accessibility labels.
- [x] 6.4 Verify provider and manager receipt boundaries, reload/event ordering, migration, tool authorization, UI rendering, types and build.
