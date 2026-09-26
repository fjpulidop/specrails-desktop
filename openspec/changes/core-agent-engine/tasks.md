# Desktop core-agent-engine tasks

Source detail: [Desktop task document](reference/core-agent-engine-tasks-desktop.md).
All acceptance commands and evidence requirements there remain binding. A checked
implementation task does not satisfy an unchecked release or telemetry gate.
Initial delivery uses feat/core-engine-d0 paired with Core C0/C1 PRs.

## 1. D0 — Runtime catalog compatibility

- [x] 1.1 Parse optional engine/catalog/builtin descriptors and capability-gated CLI definition validation, including structured exit-1 errors.
- [x] 1.2 Normalize v2 status and validate safe resume paths against authoritative run step membership while preserving legacy behavior.
- [x] 1.3 Derive metrics step/role validation from run catalogs and frozen config; retain missing-value semantics and legacy fallbacks.
- [x] 1.4 Align compatibility metadata, retained-package tests, module README and runtime guide with inspected sources and paired C0.
- [x] 1.5 Run typecheck, affected runtime/compatibility suites, architecture audit, source-map generation and source-pair compatibility.
- [ ] 1.6 Complete published-package compatibility against released C0, record evidence/date/commit and close D0 release gate.

- [x] 1.7 Split independent CI coverage lanes, preserve the required aggregate and all platform/package gates, and validate workflow syntax.

## 2. D1 — Definition authoring and Core launcher (requires published C4)

- [ ] 2.1 Vendor definition schema with byte-parity test; add structural graph model and capability catalog.
- [ ] 2.2 Implement pure deterministic graph compiler, interpolation and Core-owned hash validation.
- [ ] 2.3 Validate publication via Core and expose node-scoped errors in builder.
- [ ] 2.4 Implement exclusive frozen inputs and Core-only launch with host-owned git, cancellation and existing settlement.
- [ ] 2.5 Implement verification-aware delivery gate; negative completion remains a successful runtime verdict.
- [ ] 2.6 Build palette and inspectors including components/map/join with eight-locale parity and client tests.
- [ ] 2.7 Update user guides and run loop/runtime/delivery/client validation.

## 3. D1b — Minimal role library (requires C2)

- [ ] 3.1 Vendor role config schema and validate open role descriptors.
- [ ] 3.2 Add settings role rows, engine selection and localized validation with schema-parity tests.

## 4. D2 — Event projection and accounting (requires D1)

- [ ] 4.1 Project graph/step/branch events into existing loop events and nested explorer models.
- [ ] 4.2 Persist one invocation per AI attempt with idempotent replay, shared integer allocation and null usage.
- [ ] 4.3 Read Core evidence via retained CLI and preserve review confidence projection.
- [ ] 4.4 Add event fixture, accounting parity, replay, evidence and client explorer tests; update log guide.

## 5. D3 — Human pauses and fork (requires D2 and C3)

- [ ] 5.1 Connect paused question/approval/gate states to job composer and single-writer resume.
- [ ] 5.2 Implement linked fork endpoint and explorer action including internal component nodes.
- [ ] 5.3 Test cancellation during pause, original-run preservation and isolated settlement.

## 6. D4 — Restart recovery (requires D2)

- [ ] 6.1 Append next available migration for durable request, engine version and fork linkage.
- [ ] 6.2 Reconcile resumable v2 runs to paused while preserving jobs and existing legacy recovery.
- [ ] 6.3 Reconstruct launch and isolated settlement from durable records, expose recovery choice.
- [ ] 6.4 Test crashes across read/write/pause boundaries and idempotent accounting/delivery.

## 7. D5 — Progressive factories (requires C4/C5/C6 respectively)

- [ ] 7.1 Port Quick SDD after C4 with sequence parity and capability fallback.
- [ ] 7.2 Port Freestyle and templates after C5 with sentinel/retry parity.
- [ ] 7.3 Port Implement and Batch after C6 with receipt/acceptance parity and stable factory aliases.
- [ ] 7.4 Update pipeline user documentation and run factory/template pairing tests.

## 8. D6 — Agents role library (requires D1b/C5)

- [ ] 8.1 Project custom agent frontmatter and prompts into runtime role descriptors.
- [ ] 8.2 Integrate role selection and builtin read-only display; mark legacy routing for later removal.
- [ ] 8.3 Test role permissions, profiles API and Agent Studio flows.

## 9. D7 — Steering and observation (requires C8)

- [ ] 9.1 Add retained-runtime signal endpoint and MCP action.
- [ ] 9.2 Show accepted/consumed steering receipts and attempt-boundary semantics in composer.
- [ ] 9.3 Expose run traces and validate routes, MCP, composer and documentation.

## 10. D8 — Migration and retirement (requires parity and two telemetry releases)

- [ ] 10.1 Record legacy launch/merge-back usage and collect two releases with zero legacy use.
- [ ] 10.2 Implement compatibility compiler and prove parity across saved/factory/template graphs.
- [ ] 10.3 Back up original loop graphs and migrate/revalidate published definitions.
- [ ] 10.4 Prepare reviewed deltas for existing loop specs, then remove obsolete traversal/profile paths and tests exclusive to proven-unused code.
- [ ] 10.5 Implement retained-package/run retention and paired Core7 compatibility.
- [ ] 10.6 Run full CI, source and architecture audits; update Core/Desktop/Web documentation and companion contract.
