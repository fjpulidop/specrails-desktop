## Context

Core's report: `{schemaVersion: 1, evidence, receiptId, requirements, demonstrated[{id, name, tests}], undemonstrated[{id, name, reason, tests}], untagged[...], touched, touchedUndemonstrated, ...}`. The packet already renders the reviewer brief and Flow derivation from `settle_evidence`.

## Goals / Non-Goals

**Goals:** show the trace honestly (app-verified, receipt-bound), aggregate it per loop, give teams a CI gate, offer the drift check on demand.

**Non-Goals:** gating any decision on the trace; re-harvesting deliveries settled before the capability; running the trace from Desktop.

## Decisions

- **Gated harvest.** Without `specTrace: 1` the evidence is byte-identical to before (tested).
- **Bounded parse.** Schema 1 only; lists capped at 200; `requirements` never below the listed entries; malformed files read as absent, never as zero.
- **Loop economics reads settle evidence** with a tolerant inline parser (accounting does not depend on delivery).
- **Drift sweep** is a Core definition graph: one read-only `prompt` with a verification sentinel; both verdicts end the run, so the report is the output.

## Risks / Trade-offs

- A trace without a receipt (CI-only) cannot show demonstrated requirements → the section says so.
