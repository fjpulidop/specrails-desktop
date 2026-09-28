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
