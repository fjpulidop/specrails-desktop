# Historical isolated settlement reconstruction

27 September 2026. New v2 admissions already freeze complete settlement snapshots.
For an older v2 row missing that snapshot, explicit resume may reconstruct only
from mutually consistent persisted Core request/context, execution manifest,
delivery branch records and worktree ledger. This is not a startup write or a
read-only status side effect.

All repository legs must be proven before any snapshot is inserted. Require the
original run/project/repository/worktree/branch identities and a captured initial
SHA. Never derive that SHA from today's checkout. Existing continuation/borrowed
PR allocations without their exact frozen continuation contract remain rejected.
Reject conflicting, incomplete, already closed or actively operated deliveries.

Reconstructed snapshots preserve recorded never-commit exclusions but grant no
automatic cleanup ownership: worktrees are treated as preexisting, cleanup and
warm-link evidence are empty, and missing provenance baselines remain null. No
current project settings, provider defaults or live ticket content reconstruct
historical values. Snapshot insertion is immutable and transactional across legs.
Original run markers remain in deterministic recovery commit messages.

Before Git settlement, verify the recovered worktree belongs to the frozen Git
common directory as well as the frozen branch and Core mount. Missing proof is
an actionable recovery error; it must not silently settle as a standalone job.
