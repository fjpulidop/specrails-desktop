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

### Requirement: Delivery PR titles use Conventional Commits
Desktop SHALL generate new delivery PR titles as `type[!]: change (ref)` using feat, fix, chore or docs. Jira-linked tickets SHALL retain their authoritative Jira key; otherwise the reference SHALL be the local ticket number. Branch naming SHALL remain unchanged.

#### Scenario: Single feature ticket
- **WHEN** Create PR is requested for a ticket titled Dark mode with authoritative Jira key SKILLS-101 and no type override
- **THEN** its title is `feat: dark mode (SKILLS-101)`
- **AND** the existing draft publication and degradation behavior is preserved

#### Scenario: Bug or fix classification
- **WHEN** a ticket is labelled fix or bug
- **THEN** its new PR title and completed implementation commit use the fix type
- **AND** existing label-before-title precedence is retained for other supported types

#### Scenario: Batch delivery
- **WHEN** a new PR covers N tickets where N is greater than one
- **THEN** its title is `type[!]: <loop> batch of N tickets (<primary-ref> +<N-1>)`, omitting the loop prefix when unavailable
- **AND** its type is the common classified type when all tickets agree, otherwise feat

#### Scenario: Empty ticket list
- **WHEN** a defensive PR naming request contains no tickets
- **THEN** its title is exactly `chore: specrails delivery`

### Requirement: Explicit breaking labels mark completed changes
Desktop SHALL derive the breaking marker only from explicit breaking or breaking-change labels, matched case-insensitively after trimming. Completed implementation subjects and PR titles SHALL use `type!:` for such tickets; any breaking ticket SHALL mark a batch PR breaking. Housekeeping and partial or failed runs SHALL never inherit the marker.

#### Scenario: Breaking fix
- **WHEN** a completed ticket has labels bug and breaking-change
- **THEN** its PR title and implementation commit subject begin `fix!:`

#### Scenario: Batch includes a breaking ticket
- **WHEN** any ticket in a batch has the breaking label
- **THEN** the batch PR title contains the breaking marker

#### Scenario: Breaking word in prose
- **WHEN** the title mentions breaking but neither explicit label is present
- **THEN** the generated subject has no breaking marker

### Requirement: Generated subjects are bounded and safe
Desktop-generated subjects SHALL be single-line Conventional Commits of at most 100 characters. Ticket changes SHALL have colons and control characters sanitized and retain the existing lowercase-first/acronym behavior. Truncation SHALL shorten the change rather than the supported reference suffix. Unreadable ticket metadata SHALL NOT block PR creation.

#### Scenario: Empty or emoji-only title
- **WHEN** a ticket title is empty or contains only emoji or symbols
- **THEN** the title change is `implement <ref>` and the full subject remains conventional

#### Scenario: Long or injected title
- **WHEN** a ticket title exceeds the cap or contains colons, newlines, Unicode line separators or control characters
- **THEN** its generated title is one line of at most 100 characters with a nonempty sanitized change
- **AND** its complete reference suffix is retained

#### Scenario: Unreadable store
- **WHEN** Create PR cannot read the ticket store
- **THEN** the PR is still created with a conventional title and bare local reference fallback

#### Scenario: Corrupt reference metadata
- **WHEN** a ticket's Jira value contains control characters or cannot fit a nonempty conventional subject within the cap
- **THEN** subject generation falls back to its local ticket number without changing its branch convention

#### Scenario: Shared validation contract
- **WHEN** generated PR or commit subjects are checked for conformance
- **THEN** accepted subjects have one of feat, fix, chore or docs, an optional bang, colon-space and a nonempty description within the cap
- **AND** legacy bracket-prefix subjects, unsupported types, empty descriptions, overlong strings and multiline subjects are rejected
- **AND** suffix-free housekeeping and the empty-ticket fallback remain valid

### Requirement: Implementation commits preserve release classification and run provenance
New completed-run implementation commits SHALL use the same ticket type, breaking classification, sanitized change and reference convention as PR titles. Their run identity SHALL appear as `Run: <runId>` in the body, never the subject. New partial or failed-run commits SHALL use non-breaking chore subjects and a `(partial)` body marker.

#### Scenario: Successful isolated settlement
- **WHEN** Desktop commits a completed ticket run
- **THEN** its subject uses the ticket's conventional type/change/reference
- **AND** the body contains the Run line and retains the local ticket cross-reference when Jira is primary

#### Scenario: Failed or partial settlement
- **WHEN** Desktop preserves incomplete implementation changes in a commit
- **THEN** its subject begins `chore:` without a breaking marker
- **AND** the body contains both `Run: <runId>` and `(partial)`
- **AND** incomplete work is not classified as a feature

### Requirement: Housekeeping and recovery commits are conventional
Desktop-generated branch/base merge completion, follow-up recovery, runtime continuation recovery and local restore commits SHALL use non-breaking chore subjects. Standalone verified CI corrections SHALL use fix subjects. Available run identity SHALL be retained in the body. Existing ownership, verification, cancellation, transaction and idempotency behavior SHALL remain unchanged.

#### Scenario: Branch or base merge completion
- **WHEN** Desktop commits a fetched branch merge or CI sync completes an outstanding prepared merge
- **THEN** its subject is conventional and uses chore
- **AND** any run identity is in the body

#### Scenario: Batch and local assembly merge subjects
- **WHEN** Desktop assembles a batch PR branch, integrates a delivery locally or completes a retained legacy merge-back
- **THEN** any merge commit Desktop creates has an explicit conventional chore subject
- **AND** conflict-resolved merges follow the same subject convention
- **AND** immutable source selection, abort, cleanup and rollback behavior is unchanged

#### Scenario: Standalone CI correction
- **WHEN** verified CI fixes are committed without a pending merge
- **THEN** the sanitized summary is used in a conventional fix subject
- **AND** unverified candidates remain rejected without a commit or push

#### Scenario: Recovered follow-up or runtime continuation
- **WHEN** Desktop records a recovery commit
- **THEN** it uses a conventional chore subject and a Run body line
- **AND** stale verification or changed worktree ownership still blocks settlement
- **AND** repeated settlement does not duplicate an already-recorded commit

#### Scenario: Clean or resolver-assisted local restore
- **WHEN** Desktop commits restored local changes on its restore branch
- **THEN** both clean and resolver-assisted paths use a conventional chore subject with a bounded local reference/count when known
- **AND** unresolved conflict markers still prevent the commit

#### Scenario: Historical snapshot reconstruction
- **WHEN** Desktop reconstructs a missing isolated settlement snapshot from durable proof
- **THEN** newly generated full and partial recovery messages are conventional chore messages with Run body lines and the partial body marker as applicable
- **AND** failed multi-repository reconstruction still rolls back atomically

#### Scenario: Legacy frozen-message replay
- **WHEN** an old uncommitted allocation replays a frozen free-form message
- **THEN** Desktop creates the new commit with a conventional chore recovery subject and Run body line
- **AND** a partial replay includes the partial body marker
- **AND** allocation identity, persisted snapshot format and existing commit history remain unchanged
- **AND** already-conventional frozen messages retain their original content

### Requirement: Release automation can classify new deliveries
New Desktop-generated feature, fix and breaking delivery titles and implementation commits SHALL provide Conventional Commit metadata usable by release-please after a maintainer merges by squash, merge commit or rebase. Chore housekeeping SHALL remain release-neutral. This change SHALL NOT rewrite existing subjects or configure repository release automation.

#### Scenario: Releasable delivery reaches main
- **WHEN** a maintainer merges a new Desktop feature or fix delivery into a repository with functioning release-please automation
- **THEN** its conventional metadata allows release-please to create or update the Release PR and changelog entry according to that repository's release policy
- **AND** real Release PR creation is observed after delivery rather than required as a planning-time GitHub mutation
