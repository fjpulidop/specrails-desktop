# Legacy graph compiler decisions

27 September 2026. This records constraints verified against the current engines;
it is not a migration-completion or legacy-retirement claim.

The compatibility adapter must be pure and feed the existing v2 compiler. It
must return an authored graph plus explicit role bindings and diagnostics before
any saved graph is changed. Publication still requires Core validation. Original
saved graphs remain available as immutable backups; a failed conversion becomes
an actionable draft and cannot silently run with different semantics.

## Invocation boundaries

- Preserve the effective rail provider/model/effort for legacy AI steps. Source
  inspection of loop-run-manager confirms that stored node overrides are
  deliberately ignored: the rail governs the run. The optional deciderEngine
  launch selection overrides that rail engine only for the decider. Bind its
  declared read-only role explicitly; inheriting the project reviewer engine
  would change the effective choice. This corrects the earlier checkpoint
  assumption that stored per-node overrides were active.
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

The bridge exposes explicit launch-owned custom-role bindings for conversion.
These are applied to the pure compiler's configuration and the frozen Core
configuration together, with provenance. Only declared custom roles are accepted;
normal Core validation still checks providers/models/policies. Resume cannot
replace them. This avoids mutating the callback's copied configuration and
incorrectly assuming those changes reached the runtime.

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

## Decision pauses and retained pass state

Further inspection on 27 September identified an additional prerequisite: the
legacy decider can return `LOOP_BLOCKED`, pause for a human, and then follow its
continue branch without evaluating the decider again. The current Core decider
accepts only structured continue/stop verdicts and routes malformed output to
failure after a bounded repair. A compatibility graph must preserve the human
pause explicitly; treating a blocked decision as malformed is not parity.

A failed pass forces a stop verdict to continue but does not suppress the
physical decider invocation. Iteration increments before that invocation. The
legacy one-shot recovery counters persist across iterations. Any state-expanded
conversion must carry these independent state dimensions, preserve the failed
phase's return address, and account for Core's per-node no-progress tracking;
renaming each visit cannot silently reset no-progress detection.

## Persisted conversion bindings and terminal evidence

Converted graphs keep the original execution IDs where Core permits them and
return an explicit mapping for remapped IDs. Generated controls use collision-free
IDs. A saved legacy decision binding identifies its declared custom role; launch
resolves that role from the legacy decider selection or rail engine and freezes
it through the explicit bridge port. It must survive visual edit/save round trips.

Shell conversion requires a selected repository binding when it cannot preserve
the original single-repository scope. No first-repository inference is permitted.
The converter returns diagnostics before mutation, feeds the existing definition
compiler, and leaves publication/backup ownership in the store transaction.
Core's verified terminal requirement remains mandatory for converted writers;
an AI sentinel cannot substitute for actual host checks. These are explicit v2
acceptance requirements, not a claim that arbitrary historical graphs are already
safe to migrate automatically.

## Reviewed draft conversion — 27 September

The HTTP/UI path now produces a structurally validated Core Draft and atomically
preserves its original. Catalog 5 is required for scoped archived OpenSpec
commands. Original node identifiers are retained where valid; generated controls
are ordinary Core pieces. Iteration counters and single-use repair budgets remain
checkpointed assignments. A failed-pass stop verdict is still evaluated and then
forced to continue. Blocked decisions resume without repeating that decision.

Actual CLI acceptance passed converted Implement and two-ticket Batch, Quick SDD
with pinned archive and with one artifact repair, sticky failed-pass continuation,
iteration exhaustion, pause/resume, single-use self-retry, and artifact-only repair.
All 48 factory/template entries also pass actual Core structural validation.
Publication concurrency, immutable backup/idempotence and visual role-binding
round trips are tested. These results do not claim full historical behavioral
parity or authorize automatic publication/removal of the legacy runner.

Core admission fixes the change identity before execution; converted OpenSpec
commands use that frozen target rather than allowing subsequent AI prose to
switch it. Human blocks follow Core's durable pause/answer semantics. Malformed
decisions use Core's bounded structured repair; successful completion requires
host evidence. The reviewed Draft makes these stricter v2 requirements explicit.
The converter limits consecutive failed AI attempts to two (or a stricter saved
policy); controls do not reset that counter. Actual empty responses are rejected by Core’s executor registry and the paired
acceptance proves the same two-failure cap as provider exceptions. Three paired
cases also run the original LoopRunManager on the same scripted sequence and
compare outcomes/call order: forced continuation, iteration cap and one-shot
self-retry. Broader historical parity remains required before D8 is complete.

## Differential parity corpus — 28 September

`loop-compat-paired.test.ts` now runs seven more scripted sequences through both
the original `LoopRunManager` and the converted definition on the real Core CLI:
first-pass stop, continue-then-stop, a missing verification sentinel treated as a
failed pass, a decision cap exhausted by continue verdicts, the unlabeled decider
edge fallback, and two consecutive provider exceptions or empty replies. Both
harnesses assert the exact invocation order, so branch choice, decision count and
the absence of an extra expensive call are compared as well as the outcome
(`success`/`max-iterations`/`failed` against `succeeded`/`failed`). The legacy
harness now models a failed provider call as a hard failure with no output,
matching the manager's fail-fast rule. Three shell cases run the real command in
each engine's own repository: a passing check, a failed check that forces one more
pass before the stop is accepted, and a required (`stopOnFailure`) check that fails
the run without a decision. Thirteen paired cases now compare both engines.
Remaining for task 10.2: human pauses on the legacy side,
native implement/batch operations and saved user graphs beyond the factory and
template corpus.

## Windows shell lines and paired pin — 28 September

The paired Windows job had failed since #708 on "repairs only artifacts": Core's
shell piece runs `cmd /d /s /c <commandLine>`, and Node quoted that line with
backslash escapes cmd does not parse, so any line containing quotes exited
nonzero. Core `30e852e0` passes that exact form verbatim with one pair of outer
quotes (stripped by `/s`); structured argv is unchanged. The paired pin moves to
that commit (engine branch + C1 + fix) and the paired job timeout rises from 20
to 40 minutes because Windows runs every real-Core suite serially (~20 minutes).

## Human pauses, saved-graph shapes and native operations — 28 September

- **Human pauses.** The legacy harness now answers through `sendInteractiveTurn`,
  the same path the UI uses. Two paired cases match both engines: a blocked work
  step pauses and repeats with the answer, and a blocked decision resumes on the
  continue branch without re-deciding, keeping the failed-pass obligation. In both
  engines the answer reaches the next work invocation.
- **Saved-graph shapes.** A single-successor condition is a pass-through; a
  two-phase pass re-enters at its first phase after continue; an iteration cap of
  one accepts a successful first stop. A branching condition, which the legacy
  runtime refuses at run time, is refused by the converter instead of choosing a
  branch.
- **Native Implement/Batch.** The converted Implement factory now matches the
  original engine's role sequence exactly. Batch is an intentional divergence
  recorded here: the original engine runs one combined architect/developer/reviewer
  pipeline for all tickets, while the converted graph (D5) isolates one
  implementation per ticket before global verification. With two tickets that is
  twice the expensive invocations. The test pins both shapes. Choosing between
  isolation and the lower combined cost remains an owner decision; nothing was
  changed silently.
- Paired compatibility now has 18 cases across both engines. Remaining for 10.2:
  user-saved graphs from real projects (none are available in this environment)
  and the Batch cost decision above.

## Migration assessment (task 10.3) — 28 September

`GET /api/loops/migration` and the loop library's migration check classify every
saved loop against the installed Core (catalog 5+): `current`, `invalid` (a Core
definition, possibly published, that the installed Core rejects), `convertible`,
`needs_attention` (conversion issues such as a missing repository binding) or
`running` (not validated). The check is read-only by design. It never converts,
publishes, unpublishes or writes backups, so a Core upgrade that rejects a
published definition is surfaced for review instead of silently withdrawing it.
Conversion stays the explicit per-loop step with its atomic backup and returns
the loop to Draft. Bulk automatic migration is deliberately not provided; after
conversion a person reviews and publishes explicitly. Task 10.3 stays open until
this is validated against real saved user loops.
