## Why

Core now traces OpenSpec requirements to the tests that demonstrate them (Core `specTrace: 1`, contract 5.7) and writes `spec-trace.json` after each passing verification. Reviewers need to see that coverage in the packet, managers per loop, and teams in CI. This is Phase 3 task 3.3 (Desktop) of the feedback-2026-10 program.

## What Changes

- **Harvest.** At settle, read each unit's `spec-trace.json` (run dir, then the newest engine-2 implementation dir) into `settle_evidence.units[].specTrace`, gated on the capability.
- **Packet.** New section **Requirements demonstrated X/Y** with demonstrated, undemonstrated (touched first) and untagged lists.
- **Loop economics.** `requirementsDemonstrated { demonstrated, total, deliveries }` is filled per loop from the settle evidence; `sources.requirementsDemonstrated` becomes `measured`. The card shows `X/Y · NN%`.
- **CI template.** `docs/internals/openspec-workflow.md` documents the `spec:check` npm script (`specrails-core pipeline trace --check --tests-passed`).
- **Drift sweep.** A read-only loop template appears in the loop library when Core announces `specTrace: 1`.

## Capabilities

### New Capabilities
- `spec-trace-surfaces`: requirement traceability shown in the review packet, loop economics, CI guidance and an on-demand drift sweep.

## Impact

- **Server:** `delivery/runtime/run-records.ts`, `delivery-evidence.ts`, `phase3-harvest.ts`, `review-packet.ts`, `rail-isolated-launch.ts`, `accounting/runtime/loop-economics.ts`, `loops/runtime/loop-templates.ts`, `agent-runtime/runtime/core-capabilities.ts`, MCP analytics description.
- **Client:** `RequirementsDemonstrated`, `ReviewPacketPage`, `LoopEconomicsCard`, locales (packet, loops ×8).
