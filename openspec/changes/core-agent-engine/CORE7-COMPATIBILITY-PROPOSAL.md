# Core 7 compatibility signal — proposal for decision

28 September 2026. Status: **approved by the owner on 28 September 2026 and
implemented** (see "Implementation" at the end). It is the design input for D8
task 10.5 ("paired Core7 compatibility").

## What the contract already fixes

Contract section 10: with Core 7.x only engine v2 exists. Saved runs resume
with their retained package (`resolveRetainedAgentRuntime`). Desktop ≤ 2.57 is
incompatible, and `SUPPORTED_CORE_MAJORS` excludes 7 until D8. What the contract
does not say is **how a running Desktop learns that the installed Core has no
engine 1**, so that it can refuse to launch an unconverted legacy loop through
it instead of failing mid-run.

## Proposed signal

`runtime api` adds an optional `engines: number[]` field, e.g. `[1, 2]` on 6.x
and `[2]` on 7.x. The rules:

- **Absent field:** Desktop treats it as `[1, 2]` when `engineV2 === 1`, else
  `[1]`. This keeps compatibility with every released Core 6.x without a
  release.
- **Legacy loops:** Desktop launches a legacy (non-definition) loop only when
  the active Core lists `1`. Otherwise launch fails before any provider call
  with `legacy_engine_unavailable`, and the UI points to **Convert to Core** and
  the migration check.
- **Saved runs:** their frozen request already names `engine: 1 | 2` and their
  retained package. Resume and fork keep using that package whatever the active
  Core lists; this is already implemented and tested.
- **Factory loops:** these already select Core definition graphs whenever
  `engineV2 === 1`, so they are unaffected.
- **Supported majors:** `SUPPORTED_CORE_MAJORS` gains 7 only in the paired D8
  release, together with the retirement of Desktop's legacy traversal (10.4).

## Alternatives considered

1. **Infer from the major version (`>= 7` means no engine 1).** It needs no new
   field, but couples behavior to version numbers and breaks for pre-release or
   patched builds.
2. **Probe by launching and mapping the error.** It needs no new field, but
   fails after admission and can leave partial state; it also contradicts
   "Core rejects incompatible scope before inference".
3. **Explicit `engines` field (proposed).** Additive, testable offline, and
   independent of versioning.

## Work once decided

- **Core:** advertise `engines` in `runtime api` (additive contract 5.x), plus a
  test.
- **Desktop:** tolerant parsing with the defaults above, a launch guard for
  legacy loops, localized UI copy, and paired tests with a Core that advertises
  `[2]` (fixture) and one that omits the field.
- **Neither side** changes `SUPPORTED_CORE_MAJORS` or removes legacy code before
  the two-release zero-use gate (10.1).

## Implementation — 28 September 2026

- **Core:** `runtime api` emits `engines: [1, 2]`, and `integration-contract.json`
  mirrors it as `agentRuntime.engines`, covered by the contract test. Core task
  11.3 switches it to `[2]` together with the engine-1 removal.
- **Desktop loader:** `RuntimeApi.engines` must be a non-empty array of unique
  positive integers, otherwise it is rejected as malformed.
  `supportedEngines(api)` applies the defaults above.
- **Launch guard:** `LoopRunManager.assertEngineSupport(graph)` checks legacy
  graphs through `LoopExecutors.assertLegacyEngineSupport`. `_run` calls it for
  every fresh launch, but never for a resume. The rails launch route calls it
  before allocating worktrees and answers
  `409 {error: 'legacy_engine_unavailable', loopId, detail}`. A missing or broken
  Core does not block a legacy traversal: it is not evidence that engine 1 is
  gone, and legacy traversal predates Core.
- **UI:** the Dashboard shows a localized toast (8 locales) that points to
  Loops ▸ Convert to Core.
- **Tests:**
  - `agent-runtime-loader.test.ts`: fixture Cores advertising `[2]`, omitting the
    field, and malformed values.
  - `loop-legacy-engine.test.ts`: refusal before persistence or provider calls,
    and the derived defaults.
  - `rails-router.test.ts`: the 409 before any run.
  - `loop-legacy-engine-paired.test.ts`: the real paired Core advertises `[1, 2]`
    and admits legacy loops. It is part of the CI paired job.
- `SUPPORTED_CORE_MAJORS` is unchanged (`[4, 5, 6]`).
