## 1. Server

- [x] 1.1 `run-records.ts`: spec-trace parse + engine-2 fallback reader + packet builder
- [x] 1.2 Capability-gated harvest (`phase3-harvest.ts`, both settle paths, `recordsDir` for recovered settlements)
- [x] 1.3 Packet `requirementsDemonstrated`; loop economics `requirementsDemonstrated` and source
- [x] 1.4 Drift sweep template gated on `specTrace`

## 2. Client

- [x] 2.1 Packet section with touched-first list, expand/collapse, receipt caveat
- [x] 2.2 Loop economics `X/Y · NN%`; locales ×8 (packet, loops)

## 3. Verification and docs

- [x] 3.1 Server tests: parser, reader fallback, harvest gating, packet, economics, template graph compile
- [x] 3.2 Client tests: packet section, economics card
- [x] 3.3 Docs: CI snippet in openspec-workflow, review packet, existing-project anchoring, API reference, user guide ×8
