# Spec Delta

## ADDED Requirements

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
