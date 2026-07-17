## ADDED Requirements

### Requirement: Isolated settlement preserves execution truth

Each isolated unit SHALL settle into separate implementation and delivery results. The implementation result SHALL be derived only from the loop engine's terminal outcome; commit cleanliness, ref verification, and push SHALL govern delivery only. The aggregate SHALL retain every allocated unit, including unexpected rejected promises, and SHALL fail closed without deleting uncertain work.

#### Scenario: Ref moves after a successful run

- **WHEN** a continuation loop succeeds but the worktree HEAD no longer matches the expected PR branch ref at settlement
- **THEN** the unit's implementation SHALL remain successful
- **AND** delivery SHALL be blocked with `branch_verification_failed`
- **AND** no push SHALL occur
- **AND** the worktree/commit SHALL remain recoverable

#### Scenario: Settlement promise rejects unexpectedly

- **WHEN** one unit rejects during post-run settlement
- **THEN** the aggregate SHALL retain an explicit result for that unit
- **AND** SHALL classify its known loop outcome independently from the settlement error
- **AND** SHALL not silently omit the unit from counts or cleanup

#### Scenario: Clean successful partial batch

- **WHEN** one unit succeeds with a verified deliverable branch and another loop unit fails without dirty uncommitted work
- **THEN** the aggregate MAY offer an explicitly partial delivery containing only the successful unit
- **AND** it SHALL preserve the failed unit's logs and outcome

### Requirement: Isolated launch admission is generation-safe

The per-repository allocation lock SHALL revalidate the expected active delivery generation before creating or reusing any worktree. Ticket/worktree ownership SHALL NOT be overwritten by a concurrent launch that did not win admission.

#### Scenario: Stale pre-lock guard

- **WHEN** a request passed its outer guard but another launch created the active generation before it acquired the repository lock
- **THEN** the stale request SHALL fail with a conflict before allocating, claiming, or spawning

### Requirement: Startup worktree reconciliation is non-destructive and serialized

Startup worktree reconciliation SHALL finish under the repository lock before new isolated launches are admitted. It SHALL use delivery/run generation ownership and SHALL preserve a worktree associated with a successful or uncertain unfinished settlement.

#### Scenario: Successful stale run owns dirty worktree

- **WHEN** a stale worktree belongs to a run whose durable engine outcome is success but settlement is incomplete
- **THEN** reconciliation SHALL mark it needs-review and preserve it
- **AND** SHALL not force-remove it

#### Scenario: New launch waits for sweep

- **WHEN** project startup is still reconciling an older worktree path
- **THEN** a new launch SHALL not reuse that path until reconciliation has completed
