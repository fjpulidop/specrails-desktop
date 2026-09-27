# Legacy graph compiler decisions

27 September 2026. This records constraints verified against the current engines;
it is not a migration-completion or legacy-retirement claim.

The compatibility adapter must be pure and feed the existing v2 compiler. It
must return an authored graph plus explicit role bindings and diagnostics before
any saved graph is changed. Publication still requires Core validation. Original
saved graphs remain available as immutable backups; a failed conversion becomes
an actionable draft and cannot silently run with different semantics.

## Invocation boundaries

- Preserve the effective provider/model/effort at each legacy AI node. A decider
  uses a declared read-only role with that effective engine; choosing the current
  reviewer engine without checking node overrides is not equivalent.
- Preserve the legacy 15-minute AI, 30-minute idle, 3-minute decider and
  10-minute shell limits. Explicit zero means untimed, not missing/default.
  Core commit `749a6133` includes additive per-piece timer support, with full
  local CI on the preceding timer commit and focused follow-up acceptance. Role
  repair and session fallback must carry the original timer overrides.
- Keep host verification receipts distinct from an AI `VERIFICATION: PASS`.
  Writing conversions must not authorize success from the sentinel alone.
- Preserve `LOOP_BLOCKED` questions even on a verification step. Core commit `749a6133` now pauses a verification prompt before accepting its
  sentinel and proves resume does not replay the blocked invocation. This is a
  prerequisite, not evidence of full converted-graph parity.

## Failure and repair

`$attempts[node]` is the physical attempt number within a visit, not a counter
of all visits. The original contracts table's suggested cross-node repair guard
cannot be implemented by comparing it to two: doing so can admit an unbounded
repair cycle. Use explicit one-shot repair nodes and retained output guards,
with failure routing to a failure end. A cross-phase artifact repair must return
to the failed validator without replaying successful implementation phases.

The legacy manager retains `passFailed` for a pass and rejects a decider's stop
while a required step failed. The converted graph must retain that obligation;
a positive later model reply cannot erase a failed prerequisite. Explicitly test
failed provider calls, missing verification sentinels and nonzero shell exits,
including a later iteration after a previous successful repair.

## Graph and frozen scope

- Current legacy validation permits one successor at a condition node. Its
  runtime is a pass-through; do not invent AND/OR branching from edge labels.
- Preserve explicit decider branches and the legacy unlabeled-edge fallback
  (continue to the first non-end successor, stop to the first end successor).
- Remap invalid/reserved node IDs deterministically without collisions; retain
  an original-to-Core mapping for migration diagnostics and historical UI.
- Resolve commands/spec/constants once through the existing compiler. Runtime
  variables stay runtime variables; guard required values before host commands.
- A shell in multiple repositories needs its explicit repository binding.
  Never select the first repository as an implicit substitute.
- Native implementation/batch operations become implementation composition,
  retaining frozen change identity and all ticket/repository obligations.
- Expand iteration/repair bounds conservatively within Core's transition ceiling;
  reject a graph that cannot fit instead of silently truncating its requested cap.

## Acceptance and rollout

Use real Core CLI execution for the factory/template corpus and saved-graph
fixtures. Compare branch choices, provider invocation counts, human pauses,
repairs and failure outcomes; test that the original graph is unchanged. Test
restart halfway through publication/migration and idempotent retry of backups.

This preparation does not authorize legacy deletion. The two-release measured
zero-use gate, paired Core 7 contract and release authorization remain separate.
No release evidence can be inferred from passing tests or telemetry with no rows.

## Atomic backup before first conversion

Desktop migration 30 adds nullable original-graph storage. The first save that
replaces legacy execution nodes with a Core graph captures the original stored
JSON in the same transaction as the edit and returns the loop to Draft. Later
edits never replace the backup. Existing Core definitions are not assigned a
fabricated predecessor. A read-only export makes the original graph recoverable
without reverting a running definition or implicitly publishing anything.

Publication also checks the validated content inside an immediate transaction.
If a graph/name/description changes while Core loads or validates, publication
returns a conflict and keeps the newer edit as Draft. This avoids validating one
definition and publishing another, without trusting second-resolution timestamps.
