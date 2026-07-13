# rail-parallel-isolation (delta)

## ADDED Requirements

### Requirement: Explicit PR target resolves before allocation

When a launch carries an explicit target PR, the isolated launch SHALL resolve and verify that target under the same serialized allocation section as branch/worktree allocation, producing one continuation target applied to every ticket in the launch. Validation failure SHALL reject the launch before any delivery generation is created or worktree allocated; it SHALL NOT fall back to a fresh integration-branch allocation. The existing admission guards (`pr_decision_pending`, `tickets_in_flight`, generation safety) SHALL run before target resolution and keep their current semantics.

#### Scenario: Explicit target materializes the PR head as the worktree branch

- **WHEN** a launch with a valid explicit target reaches allocation
- **THEN** the worktree SHALL be created on the PR's head branch pinned to the observed `headRefOid`
- **AND** a multi-ticket launch SHALL collapse to one atomic batch run in that single checkout, exactly as automatic continuations do

#### Scenario: Undecided delivery still blocks an explicit-target relaunch

- **WHEN** the rail slot has an active non-terminal delivery and a new launch names an explicit target PR
- **THEN** the launch SHALL fail 409 `pr_decision_pending` without resolving the target

#### Scenario: Target validation failure allocates nothing

- **WHEN** explicit-target validation fails for any reason
- **THEN** no branch, worktree, overlay, or delivery row SHALL exist afterwards for that launch attempt
