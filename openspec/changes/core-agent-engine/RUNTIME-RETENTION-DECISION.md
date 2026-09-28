# Runtime retention ownership

27 September 2026. D8 retention must not infer disposal from a UI dismissal.
`desktop-runtime-dismissed` only hides a rail card; the run may still be resumable.
Likewise the advisory history projection is not authority to delete a journal.

The implementation must separate policy (age and explicit settled/discarded
eligibility), host admission (execution/delivery/lineage claims), and filesystem
collection. A run with a live Core lease, unresolved human interrupt, recoverable
write, incomplete delivery or pending fork remains protected. The host must
reserve the selected run before final inspection and collection; concurrent
resume/fork/settlement must conflict, not race a recursive delete.

Package collection scans surviving original-runtime pins and preserves every
referenced digest, regardless of version or age. Unknown/corrupt pins or symlink
boundaries fail closed. Installing/retaining a new package and publishing its pin
must serialize with package collection. Empty telemetry is not disposal proof.

Retention is configurable and must expose a dry-run preview with explicit
protected reasons. Collection removes only proven owned runtime storage, never
repository/worktree content or a guessed parent path. Historical runs need an
explicit expired-history result after journal collection. Restart recovery must
handle interruption between reserving, moving to a scoped quarantine, recording
expiration, and deleting the quarantined storage. Tests must inject failures at
these boundaries and prove surviving references and active work remain intact.

This document records the required ownership decision before implementation; it
does not assert that collection is implemented or authorize running it on user
history during development. The existing retained-package integrity checks remain
in effect while this work is completed.

## Implementation decisions — 28 September 2026

Implemented in Desktop as a partial delivery of task 10.5 (run/package retention).
Paired Core7 compatibility and the other D8 tasks remain open.

- **Policy.** Per-project, stored in `runtime_retention_policy` (migration 69);
  `days: null` (indefinite) by default, otherwise an integer 1..3650. Collection
  never runs in the background: `POST …/agent-runtime/retention/collect` defaults
  to a preview (`dryRun: true`), and the UI offers deletion only from the preview
  of the currently saved policy. A new preview or collection attempt clears the
  previous report, so a failed inspection never leaves an old deletion offer.
- **Admission.** Each candidate is reserved with a `retention:` execution claim
  before Core status is read; resume/fork/settlement conflict while it is held.
  A parent with a pending or adopted fork child is refused at the claim layer
  (reported `busy`) until the child itself has expired; children are processed
  first, so one collection can expire a whole finished lineage. `fork_pending`
  evidence remains a second guard. Open deliveries (`building`, `on_review`,
  `pr_draft`, `pr_ready`, `pr_failed`, `implementation_failed`) or any delivery
  with an in-flight `operation_token` protect a run. A failed run expires only as
  `discarded` history when every delivery referencing it was discarded/superseded.
- **Fencing limit.** Host claims fence Desktop admission only. A Core CLI started
  outside Desktop against the same journal is detected only if it holds a live
  lease when status is read; there is no cross-process Core fence between that read
  and the quarantine move. We do not claim stronger protection. Mitigation: the move
  is a same-directory rename, restore is automatic until expiration commits, and
  retention is opt-in and explicit.
- **Quarantine protocol.** Intent is written and fsynced inside
  `.retention/.staging-<uuid>` and published by directory rename; only then is the
  journal renamed into `<uuid>/run`. Expiration requires the moved journal to
  keep its recorded inode identity. Deletion removes the journal first and the
  intent last; restoration moves the journal back and verifies the original's
  identity before removing the intent. Recovery handles each boundary (staging
  debris, empty directory, intent without move, moved journal, partial deletion,
  interrupted restore), never deletes a directory it cannot attribute and reports
  per-entry errors without blocking other entries or controller startup. Package
  collection refuses to run while any quarantine entry remains.
- **Evidence.** `agent-runtime-retention-quarantine.test.ts` injects every
  boundary; `agent-runtime-retention-integration.test.ts` covers deliveries,
  lineage and restart ownership; `agent-runtime-retention-paired.test.ts` runs two
  real Core executions, expires one while the recent run keeps the shared pinned
  package, then collects the package after both expire, preserving accounting and
  Core source. It is part of the required paired CI job on three platforms.
- **Paired timing.** Each paired run retains a full copy of Core's dependency
  closure and hashes it. On the Windows runner the test exceeded its original
  120 s budget (about 28 s on Linux); it now allows 480 s, in line with the other
  real-Core paired suites. No assertion or runtime timeout changed.
- **Identity limit.** Journal identity is `dev`+`ino`. A filesystem may reuse an
  inode after the original was deleted, so identity detects replacement of a live
  journal but cannot prove that a deleted journal was not recreated with the same
  number. Recovery still never deletes the original location's data; the only
  consequence is removing an intent file.
- **Not done.** No real user history was collected. Visual review of the settings
  panel has not been performed.
