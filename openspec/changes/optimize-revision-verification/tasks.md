## 1. Separate Revision responsibilities

- [x] 1.1 Add regression tests proving `fixLoopGraph` can retain node id `verify` while using a dedicated verification prompt, and proving non-Revision callers keep `{{cmd:verify}}`.
- [x] 1.2 Add command-catalog tests for mutation-only `revise` and read-only `revision-verify`, including full-gate ownership, reviewer fallback, sentinel, and `health-check` exclusion.
- [x] 1.3 Implement the configurable verification prompt, `revision-verify` command, and factory Revision wiring without changing other factory graphs.
- [x] 1.4 Prove at execution level that Revision review starts a fresh provider session with the complete durable briefing.
- [x] 1.5 Reconcile the reviewer's internal `Score`/`Verdict` finish contract with the outer verification sentinel and isolate the fix session from the read-only reviewer.

## 2. Harvest fresh reviewer evidence

- [x] 2.1 Add parser regression tests for the current Codex reviewer schema (`overall_score` and `issues`) while preserving the documented schema.
- [x] 2.2 Add harvest tests for ticket-matched agent-memory scores, latest-verify freshness, stale-score rejection after a fix, and deterministic candidate selection.
- [x] 2.3 Implement additive score normalization and Revision-specific fresh artifact discovery, passing loop identity into settle-time harvesting without a database migration or provider-protocol change.
- [x] 2.4 Persist a millisecond-precision verify boundary, fail closed for ambiguous legacy timestamps, and require the exact reviewer filename contract.
- [x] 2.5 Protect `.specrails/agent-memory` with the delivery never-stage exclusions and index audit.

## 3. Reconcile the governing contract

- [x] 3.1 Update the active `delivery-revisions` requirement and D11 design decision to describe mutation → dedicated review/verify → fix/re-review instead of reviewer-inside-mutation plus generic verify.

## 4. Verification

- [x] 4.1 Run focused server tests for loop templates, factory loops, command expansion, evidence harvesting, and rail launch behavior.
- [x] 4.2 Run the repository's full configured test, typecheck, lint, build, OpenSpec strict validation, and diff checks.
