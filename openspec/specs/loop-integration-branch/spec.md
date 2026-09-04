# loop-integration-branch Specification

## Purpose
TBD - created by archiving change safe-pr-workflow. Update Purpose after archive.
## Requirements
### Requirement: Each project has a designated integration branch
The platform SHALL provide a per-project designated integration branch that mutating loops branch from and target their pull requests at. When unset, it SHALL default to the repository's default branch (`git symbolic-ref refs/remotes/origin/HEAD`), falling back to the currently checked-out `HEAD` only when no default remote branch can be resolved.

#### Scenario: Default resolves to the repo default branch
- **WHEN** a project has no explicit integration branch configured
- **THEN** the integration branch resolves to the repository's default branch
- **AND** the current working-tree `HEAD` is used only if no default remote branch exists

#### Scenario: Explicit project setting wins
- **WHEN** a project has an integration branch configured in its settings
- **THEN** that branch is used as the base and PR target for mutating loops

### Requirement: The resolved base branch is shown before launch
The platform SHALL resolve the integration branch and display it to the user before launching a mutating loop, so the base is a certainty rather than an implicit surprise.

#### Scenario: Base is displayed pre-launch
- **WHEN** a user is about to launch a mutating loop
- **THEN** the resolved integration branch is displayed before the launch is confirmed

### Requirement: Worktrees branch from the resolved integration branch
The platform SHALL create each mutating loop's worktree branched from the resolved integration branch (not the ambient `HEAD`), passing the resolved branch as the worktree base.

#### Scenario: Worktree base is the integration branch
- **WHEN** a mutating loop's worktree is created
- **THEN** the worktree branch is created off the resolved integration branch
- **AND** not off whatever branch happens to be checked out in the main working tree
