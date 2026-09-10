# Verification handoff and framework activation regression

The September 10, 2026 implementation incident ended with an agent reporting
success while Core reported `implementation=complete`, `validation=blocked`,
`archive=done`, and `delivery=pending-host`. The repository's 127 tests passed;
inspection rejected the receipt with `Verification environment changed: npm`.

A second Windows execution reproduced the same terminal contradiction after
the coordinator reported successful unit and browser checks, completed archive,
and skipped host-owned shipping/CI phases. It refreshed verification and moved
archive execution into the coordinator's session to avoid handoff drift, but
the host still reported blocked validation. This corroborates the cross-process
failure pattern; the transcript alone does not identify the differing variables
or establish a cloud-synced project path as the cause. Runtime diagnostics now
report added/removed environment key names without values. If only values differ,
the aggregate hash cannot identify the individual key.

Three independent problems made recovery unreliable:

1. The installed app bundled Core 5.2.2, but `framework/current` still resolved to
   5.2.1. Desktop materialized the providers in its project catalog, omitting Kimi
   already represented in `current`. Core correctly refused to activate the
   incomplete destination. The session-identity fix in 5.2.2 was never active.
2. Verification included agent-session metadata and automatically generated
   untracked memory in its evidence. A process handoff or a final memory write
   could invalidate verification after a successful check. Ignoring metadata in
   the fingerprint alone also left those unrecorded inputs visible to tests.
3. A successful provider process could become a successful implementation step
   without a final deterministic check of Core's state.

## Required invariants

- Framework materialization must satisfy the same provider union as Core's
  activation gate: requested providers, the shared registry, and provider
  directories or completion stamps represented in `current`. Failure leaves the
  previous version active.
- Core removes known session/launcher metadata from verification subprocesses
  as well as from their environment fingerprint. Explicit command overrides are
  retained and bound without storing their values. Application configuration,
  PATH, NODE_OPTIONS, custom variables and SPECRAILS configuration still count.
  Windows environment names are normalized without changing POSIX semantics.
- Only untracked files under known provider `agent-memory/` roots are excluded
  as generated notes. Tracked memory, settings, skills and other source inputs
  remain part of the candidate.
- Old environment-policy receipts require a fresh full verification. Do not
  edit receipts or phase records to turn an old failure into success.
- Desktop checks installed Core after Implement/Batch steps, for both interactive
  and one-shot execution. Blocked validation, incomplete phases, an invalid full
  receipt, a failed status call or mismatched run identity prevents success.
  `pending-host` describes delivery ownership and does not invalidate otherwise
  verified implementation work.

## Regression coverage and rollout

Core's `pipeline-state.test.ts` exercises real subprocess handoffs, archive
completion followed by a host inspection, explicit overrides, environment/input
changes, generated versus tracked memory and Windows environment normalization.
Desktop's `loop-core-completion.test.ts` runs the completion-status subprocess
through the loop engine and verifies the stored result. Framework tests cover
the omitted-provider activation failure and preservation of the previous version.
An offline test with the actual 5.2.1 and bundled 5.2.2 packages also validated
the provider-union update in an isolated home.

Activating the existing 5.2.2 bundle repairs the missed previous update. The
additional environment, memory, completion and materialization changes require
new Core and Desktop releases. These changes have been ported onto Core 5.2.2
and Desktop 2.44.1 for review. Never replace a newer installed runtime with an
older checkout build, and verify both
the selected package version and the actual `framework/current` target after
activation. Refresh copied workspace files through the normal reseed lifecycle.
