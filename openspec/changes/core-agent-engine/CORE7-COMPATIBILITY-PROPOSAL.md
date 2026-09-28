# Core 7 compatibility signal — proposal for decision

28 September 2026. Status: **proposal, awaiting the owner's decision.** Nothing
here is implemented. It is the remaining design input for D8 task 10.5
("paired Core7 compatibility").

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
