## Why

Desktop and Core currently maintain separate graph runners, splitting recovery,
verification and accounting rules. A durable Core graph engine lets Desktop own
workflow design and delivery while one runtime owns execution and evidence.

## What Changes

- Prepare additive runtime catalog discovery, definition validation and arbitrary
  run step controls with strict legacy fallbacks (D0, the first implementation PR).
- Add a Core definition editor/compiler and CLI launcher; project events into
  existing loop logs, accounting and delivery gates (D1–D2).
- Add human pauses, forks and durable restart continuation (D3–D4); progressively
  port factory graphs and role authoring (D5–D6), then steering and traces (D7).
- **BREAKING, gated future phase:** migrate saved loops and retire Desktop's runner
  only after parity and two releases of zero legacy launches (D8/Core C10).
- Track the paired Core change and the supplied plan/contract as versioned artifacts.
  This proposal does not authorize describing unimplemented features as released.

## Capabilities

### New Capabilities

- `runtime-catalog-controls`: capability discovery, definition validation, dynamic
  step and role validation with retained-runtime and legacy compatibility.
- `core-workflow-definitions`: graph editing, publishing, compilation and Core-only
  execution of new definitions, including factory graphs and role libraries.
- `core-workflow-observation`: event projection, honest accounting, verification
  delivery gates, steering and traces.
- `durable-definition-loops`: human pauses, forks, restart recovery and idempotent
  isolated settlement for Core definition runs.
- `core-engine-rollout`: paired release, parity, documentation and retirement gates.

### Modified Capabilities

None in D0. Existing legacy loop contracts remain in force. The D8 implementation
must supply reviewed deltas to `loop-execution` and `rail-loop-execution` before
removing their legacy requirements.

## Impact

Paired with `specrails-core/openspec/changes/core-agent-engine`. Desktop changes are
scoped to agent-runtime, loops, delivery, accounting, related client features and
append-only persistence migrations. Core stays out of process (CLI/JSONL). Core,
Desktop and Web documentation will describe only validated shipped behavior.
The complete source documents are retained in `reference/`; the authoritative
technical contract is Core's paired `contracts.md`.
