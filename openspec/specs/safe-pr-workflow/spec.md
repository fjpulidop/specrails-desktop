# safe-pr-workflow Specification

## Purpose
TBD - created by archiving change safe-pr-workflow. Update Purpose after archive.
## Requirements
### Requirement: Every repo-mutating loop is isolated and delivered as a draft PR
The platform SHALL run every repo-mutating loop in an isolated git worktree branched from the project's designated integration branch, and SHALL deliver its result as a draft pull request from that branch. The platform SHALL NOT modify the user's working tree, SHALL NOT commit directly to the integration branch, and SHALL NOT merge or open a non-draft pull request. This behavior is predefined and is NOT configurable per loop.

#### Scenario: Mutating loop produces an isolated draft PR
- **WHEN** a loop that writes to the repository is launched
- **THEN** it runs in an isolated worktree branched from the designated integration branch
- **AND** on completion with changes, a draft pull request is opened from that branch
- **AND** the user's working tree and the integration branch are never modified directly

#### Scenario: Read-only loop produces no branch or PR
- **WHEN** a loop that only reads the repository is launched
- **THEN** no worktree, branch, or pull request is created
- **AND** the loop reports its findings only

#### Scenario: Custom loops cannot opt out of isolation
- **WHEN** a user-authored (custom) loop that writes to the repository is published and launched
- **THEN** it is subject to the same isolation + draft-PR law as built-in loops
- **AND** there is no per-loop setting that disables isolation for a mutating loop

### Requirement: Mutating vs read-only classification is derived, not user-selected
The platform SHALL derive whether a loop is mutating or read-only from the loop's own content (whether any node writes to the repository), enforced server-side, rather than from a user-facing toggle.

#### Scenario: Classification comes from loop content
- **WHEN** the platform evaluates a loop before launch
- **THEN** it classifies the loop as mutating if any node writes to the repository, otherwise read-only
- **AND** the classification is not overridable by a per-loop configuration field

### Requirement: specrails is a PR producer, never a merge authority
The platform SHALL stop at a verified draft pull request and SHALL leave the merge to a human via the team's existing GitHub review process. No platform code path SHALL merge into the integration branch or open a non-draft pull request.

#### Scenario: The human owns the merge
- **WHEN** a mutating loop completes and its draft PR is opened
- **THEN** the platform performs no merge
- **AND** the PR remains a draft until a human promotes and merges it

### Requirement: Product builder reviews in plain language and approves a handoff
The platform SHALL present the result of a mutating loop to the product builder as a plain-language "what changed + proof" bundle, with an Approve action that promotes the draft PR to ready-for-review and notifies the reviewer, and a Discard action that closes the PR and drops the branch/worktree. The builder-facing surface SHALL NOT expose raw git vocabulary (branch, worktree, merge, rebase, conflict).

#### Scenario: Approve hands off to the engineer
- **WHEN** the product builder approves a completed loop result
- **THEN** the draft PR is promoted to ready-for-review
- **AND** the configured reviewer is notified/assigned
- **AND** the merge is performed by the engineer in GitHub, not by the platform

#### Scenario: Discard cleans up without side effects
- **WHEN** the product builder discards a completed loop result
- **THEN** the draft PR is closed and its branch/worktree are removed
- **AND** the integration branch is unaffected

### Requirement: Hard git guardrails block unsafe operations
The platform SHALL technically block force-pushes and direct commits to the integration branch on the loop path, rather than relying on prompt-level etiquette.

#### Scenario: Force-push is blocked
- **WHEN** any loop-path operation attempts a force-push
- **THEN** the operation is blocked by the platform
