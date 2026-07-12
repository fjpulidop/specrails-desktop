# implementation-delivery-lifecycle (delta)

## MODIFIED Requirements

### Requirement: Recoverable work is never removed automatically

The platform SHALL remove a worktree only after proving, immediately before removal, that all deliverable changes are clean and durably referenced by the recorded commit. That live proof SHALL include tracked and untracked paths, while excluding only the trusted overlay paths durably recorded by Specrails for that worktree. Gitignored paths SHALL be release-safe only when every live ignored path is covered by the immutable settlement snapshot of ignored paths captured at the moment the worktree was proven clean; an ignored path that appears after settlement, a missing snapshot, an oversized snapshot, or conflicting per-branch snapshots SHALL preserve the worktree. Cleanup SHALL NOT unlink or recursively delete a mutable overlay pathname after a separate check. It SHALL atomically rename each authenticated overlay root beneath a persistent same-filesystem quarantine batch root, revalidate it after the rename, explicitly preserve any raced content there, and retain the quarantine from automatic deletion or automatic restoration over a possibly recreated source path. The batch root SHALL be durably recorded before the first child move, SHALL disclose every contained quarantine path through one inspectable root, and SHALL NOT be evicted from delivery state while its bytes remain on disk. Both implementation-card surfaces SHALL disclose safety archives independently from cleanup failures. Dirty, unknown, ref-mismatched, concurrently changed, or unauthenticated ignored worktrees SHALL remain recoverable even when the user dismisses or discards the card: the card MAY become terminal with an honest cleanup warning, but Specrails SHALL NOT interpret that workflow action as permission for forced byte deletion. Worktree release SHALL use non-force removal.

#### Scenario: Commit fails with dirty changes

- **WHEN** commit or status verification fails and deliverable changes remain in the worktree
- **THEN** automatic settlement and startup recovery SHALL NOT run `git worktree remove --force` on that worktree
- **AND** the worktree ledger SHALL record `needs-review`
- **AND** the card SHALL explain that the local result is preserved

#### Scenario: Retryable push failure

- **WHEN** an exact clean commit is verified but pushing it fails
- **THEN** the linked worktree MAY be released while its branch and verified SHA remain durable
- **AND** retry SHALL push that exact SHA

#### Scenario: Worktree changes after settlement but before release

- **WHEN** a previously clean worktree becomes dirty, its HEAD changes, or its recorded branch ref moves before automatic release
- **THEN** the live release preflight SHALL preserve the mounted worktree and its branch
- **AND** SHALL record and disclose an actionable cleanup warning instead of running forced cleanup
- **AND** a later retry SHALL revalidate the worktree again so a user can safely resolve the condition

#### Scenario: Run-created ignored artifacts release cleanly

- **WHEN** a delivered worktree's only remaining status entries are gitignored paths that were all present in the immutable settlement snapshot (for example build caches created by the run's own test execution)
- **THEN** automatic release SHALL treat them as authorized run residue and proceed with non-force removal
- **AND** the delivery SHALL NOT report `cleanup_incomplete` for those paths

#### Scenario: Ignored user data appears after settlement

- **WHEN** a worktree contains an ignored or untracked path that is not covered by the immutable settlement snapshot or the durably recorded Specrails overlay evidence
- **THEN** automatic release SHALL preserve the worktree even when ordinary porcelain status appears clean
- **AND** SHALL NOT trust a writable worktree manifest or a live name-based classification to mark those paths disposable
- **AND** a delivery without a recorded settlement snapshot SHALL receive no ignored-path authorization at all

#### Scenario: An authenticated overlay changes during cleanup

- **WHEN** an external writer creates, replaces, or changes a leaf after the overlay was authenticated, including through an already-open file descriptor
- **THEN** atomic quarantine plus post-rename revalidation SHALL retain that content at the original or a disclosed quarantine path
- **AND** a concurrently recreated original path SHALL make final non-force removal preserve the worktree as `needs-review`
- **AND** automatic cleanup SHALL NOT unlink or recursively erase either copy

#### Scenario: Stable overlay quarantine does not manufacture a cleanup failure

- **WHEN** verified overlay roots move successfully into persistent quarantine and non-force worktree removal succeeds
- **THEN** their paths SHALL remain durable and inspectable after refresh in both card surfaces
- **AND** the delivery SHALL NOT become `cleanup_incomplete` solely because the safety archive exists

#### Scenario: One worktree contains more than eight overlay roots

- **WHEN** cleanup authenticates and quarantines more than eight independent overlay roots from one worktree
- **THEN** it SHALL persist one quarantine-batch root containing every moved child
- **AND** every quarantined byte SHALL remain discoverable through the disclosed root
- **AND** no older safety pointer SHALL be dropped merely to bound the snapshot array

#### Scenario: Terminal dashboard action creates a safety archive

- **WHEN** a dashboard-origin Discard, Mark done, or merge-verification action safely quarantines an authenticated overlay and terminalizes the card
- **THEN** the dashboard SHALL disclose the archive count and exact paths in a persistent notification before removing the terminal card
- **AND** SHALL provide a direct Copy paths action
- **AND** SHALL NOT mislabel the successful quarantine as a cleanup failure

#### Scenario: Discard finds new local files during final preflight

- **WHEN** Discard observes tracked, untracked, or ignored work that was not authorized by the immutable settlement evidence
- **THEN** it SHALL preserve the mounted worktree and its checked-out branch
- **AND** SHALL NOT attempt forced worktree or branch deletion
- **AND** the terminal result SHALL disclose `cleanup_incomplete` and the retained recovery location
- **AND** removing the terminal dashboard card SHALL leave a persistent localized notification containing that recovery detail
- **AND** the notification SHALL provide a direct action to copy the recovery details
