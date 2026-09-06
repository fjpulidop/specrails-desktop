## 1. Native ownership and lifecycle

- [x] 1.1 Implement the native mission window registry, transfer revisions, acknowledgements, recovery and independent OS window controls.
- [x] 1.2 Restrict native commands to exact trusted app interfaces and classify main, mission and popup close policies.
- [x] 1.3 Scope browsers, events and popup cleanup to their owning app window and support safe browser/session transfer.

## 2. Conversation state and interface

- [x] 2.1 Implement the typed client window bridge and acknowledged state transfer with bounded snapshots and recoverable drafts.
- [x] 2.2 Render dedicated mission windows using shared conversation and workspace components with independent project scope.
- [x] 2.3 Add detach/reintegrate actions to mission and board headers, ownership placeholders, focus routing and translated states.
- [x] 2.4 Preserve composer references/attachments, scroll and workspace state while live execution and messages continue.

## 3. Verification

- [x] 3.1 Add lifecycle and UI regression tests for active handoff, repeated actions, failed hydration, close/retry and independent missions.
- [x] 3.2 Exercise native mission/browser windows locally and add the corresponding Windows CI fixture coverage.
- [x] 3.3 Run relevant complete suites, type checks, production builds and strict OpenSpec validation; document real-platform evidence and limitations.
