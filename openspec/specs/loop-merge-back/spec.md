# loop-merge-back Specification

## Purpose
TBD - created by archiving change parallel-implementation-worktrees. Update Purpose after archive.
## Requirements
### Requirement: Sequential validated merge-back

After an isolated rail's fan-out settles (every run reached a terminal outcome), the engine SHALL integrate the successful branches into the base repository **one at a time**, holding a process-local per-repository mutex for the duration of each merge-and-verify step. Only a clean, re-verified merge SHALL advance the base. Failed or aborted runs SHALL NOT be merged.

#### Scenario: Branches merge one at a time

- **WHEN** the fan-out for a multi-ticket isolated rail completes
- **THEN** the engine SHALL merge the successful branches into the base sequentially, never concurrently

#### Scenario: Failed run is not merged

- **WHEN** a ticket's loop run ended in a failed or aborted outcome
- **THEN** its branch SHALL NOT be merged into the base and SHALL be left for inspection

#### Scenario: Base only advances on a clean re-verified merge

- **WHEN** a branch is merged
- **THEN** the base SHALL be advanced ONLY after the merge is conflict-free (or resolved) AND the integrated tree re-verifies green

### Requirement: Integrated re-verification

After each branch is merged, the engine SHALL re-run the loop's verification against the **combined** tree before accepting the merge. If the integrated tree fails verification, the engine SHALL rebase the just-merged branch onto the new base and run exactly one additional "fix pass" of its loop, then retry the merge once; if it still fails, the ticket SHALL be marked `needs-review` and its branch left unmerged.

#### Scenario: Combination that breaks is caught

- **WHEN** two branches each pass alone but their merge fails the integrated verification
- **THEN** the engine SHALL NOT accept the breaking merge as-is

#### Scenario: One automatic fix-pass recovery

- **WHEN** the integrated tree fails verification after a merge
- **THEN** the engine SHALL rebase that branch onto the new base, run one fix pass of its loop, and retry the merge once

#### Scenario: Unrecoverable integration escalates

- **WHEN** the integrated tree still fails after the single rebase-and-fix retry
- **THEN** the ticket SHALL be marked `needs-review` and its branch SHALL be left unmerged, while previously merged tickets remain integrated and green

### Requirement: Conflict handling via the resolver

When a merge produces conflicts, the engine SHALL invoke the AI merge-resolver on the conflicted hunks only. A clean resolver result SHALL proceed to integrated re-verification; a non-clean result (or an explicit `needs-review` from the resolver) SHALL abort that merge and mark the ticket `needs-review`. The resolver SHALL never be the sole authority for advancing the base — only the integrated re-verification accepts a merge.

#### Scenario: Trivial add-add conflict is resolved

- **WHEN** two branches add different lines at the same location of a shared file (e.g. a registry entry)
- **THEN** the engine SHALL invoke the resolver, and on a clean resolution preserving both additions it SHALL proceed to re-verification

#### Scenario: Unresolvable conflict escalates

- **WHEN** the resolver cannot cleanly resolve a conflict
- **THEN** the engine SHALL abort that merge, mark the ticket `needs-review`, and leave the branch unmerged

### Requirement: Merge ordering

The engine SHALL order the merge-back by ascending Contract-Layer touch-list overlap between branches when touch-lists are available, and by ticket id otherwise. Ordering SHALL be an optimisation only and SHALL NOT change which branches are eligible to merge.

#### Scenario: Least-overlapping branch merges first

- **WHEN** Contract-Layer touch-lists are present for the rail's tickets
- **THEN** the engine SHALL merge the least-overlapping branches before the most-overlapping ones

#### Scenario: Fallback ordering without touch-lists

- **WHEN** touch-lists are absent
- **THEN** the engine SHALL merge in ascending ticket-id order

### Requirement: Merge-back progress events

The engine SHALL broadcast project-scoped progress as the fan-out and merge-back proceed, reporting each ticket's state (building, built, merging, merged, needs-review, failed) so a client can render integration status.

#### Scenario: Per-ticket state is broadcast

- **WHEN** a ticket transitions between fan-out/merge states
- **THEN** the engine SHALL broadcast a project-scoped event carrying the ticket and its new state

#### Scenario: Needs-review is surfaced with its branch

- **WHEN** a ticket is marked `needs-review`
- **THEN** the broadcast SHALL identify the ticket and its unmerged branch so the client can link to it

