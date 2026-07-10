## ADDED Requirements

### Requirement: Implementation truth is independent from delivery truth

The platform SHALL persist the actual implementation outcome independently from commit, worktree, branch verification, push, and pull-request outcomes. A post-run delivery failure MUST NOT rewrite a successful loop/job outcome as an implementation failure.

#### Scenario: Successful loop hits a commit hook failure

- **WHEN** the loop completes successfully but the resulting worktree cannot be committed cleanly
- **THEN** the run and implementation outcome SHALL remain successful
- **AND** the delivery SHALL become blocked at the commit stage
- **AND** the card SHALL NOT claim that the agent run failed

#### Scenario: Loop actually fails

- **WHEN** every loop unit completes with a failed terminal outcome
- **THEN** the implementation outcome and card SHALL be `implementation_failed`
- **AND** the run logs SHALL remain available

#### Scenario: Mixed implementation result

- **WHEN** at least one unit succeeds and at least one unit fails
- **THEN** the durable outcome SHALL be partial
- **AND** both surfaces SHALL show the successful and failed unit counts
- **AND** any offered delivery action SHALL state that it delivers only successful units

### Requirement: Recoverable work is never removed automatically

The platform SHALL remove a worktree automatically only after proving that all deliverable changes are clean and durably referenced by a commit. Dirty, unknown, or ref-mismatched worktrees SHALL remain recoverable until an explicit consequence-specific destructive action.

#### Scenario: Commit fails with dirty changes

- **WHEN** commit or status verification fails and deliverable changes remain in the worktree
- **THEN** automatic settlement and startup recovery SHALL NOT run `git worktree remove --force` on that worktree
- **AND** the worktree ledger SHALL record `needs-review`
- **AND** the card SHALL explain that the local result is preserved

#### Scenario: Retryable push failure

- **WHEN** an exact clean commit is verified but pushing it fails
- **THEN** the linked worktree MAY be released while its branch and verified SHA remain durable
- **AND** retry SHALL push that exact SHA

### Requirement: No-change runs are explicit and non-deliverable

The platform SHALL distinguish a successful run that produced no branch delta from a changed implementation. It SHALL NOT offer Create PR for a fresh branch with no diff. A fresh no-change result SHALL offer two truthful outcomes: acknowledge it as complete, or return it for refinement. Acknowledgement SHALL use its own terminal `completed` decision rather than pretending that a PR was merged or work was discarded.

#### Scenario: Fresh run needs no changes

- **WHEN** a successful run finishes on a newly-created branch whose verified final SHA/diff is unchanged from its initial base
- **THEN** the decision SHALL become `no_changes`
- **AND** the card SHALL say that no changes were needed
- **AND** it SHALL offer logs and an acknowledgement/refinement path, not Create PR

#### Scenario: Existing PR iteration needs no changes

- **WHEN** a successful continuation finishes without changing the verified existing-PR head
- **THEN** the existing PR SHALL remain untouched and linked
- **AND** the card SHALL report that the PR is unchanged rather than reporting failure or performing a redundant push

#### Scenario: User accepts a fresh no-change result

- **WHEN** a fresh no-change card is acknowledged as complete
- **THEN** the decision SHALL become terminal `completed`
- **AND** its review tickets SHALL move to Done without claiming that a PR was created or merged
- **AND** both surfaces SHALL use explicit no-change completion copy

#### Scenario: User refines a fresh no-change result

- **WHEN** the user chooses Refine on a fresh no-change card
- **THEN** the confirmation SHALL state that the specs return to the backlog
- **AND** the result SHALL be discarded without presenting that action as successful acknowledgement

### Requirement: Existing PR iterations have one active lineage

The platform SHALL maintain at most one active delivery generation per rail. Starting a verified continuation SHALL atomically supersede its prior active generation and link the new generation to it.

#### Scenario: Second implementation supersedes first card

- **WHEN** generation A is attached to an open PR and generation B starts on that same PR
- **THEN** A SHALL transition to terminal `superseded`
- **AND** only B SHALL be returned as active
- **AND** terminalizing B later SHALL NOT cause A to reappear

#### Scenario: Concurrent launches race

- **WHEN** two launch requests race for the same rail and generation
- **THEN** exactly one SHALL create a delivery and run
- **AND** the other SHALL fail with a conflict before sharing or writing the worktree

#### Scenario: New allocation fails

- **WHEN** B supersedes A but B cannot allocate a verified worktree
- **THEN** B SHALL become terminal and A SHALL be restored atomically
- **AND** the existing PR SHALL remain unchanged

### Requirement: Existing PR ownership controls cleanup

The platform SHALL treat a continuation's PR and head branch as borrowed user-owned review state. Dismissing or discarding a follow-up card SHALL NOT close that PR, delete that head branch, or return its tickets from review unless the user explicitly performs a separately described destructive PR action.

#### Scenario: Dismiss successful follow-up

- **WHEN** a continuation has updated an existing PR and the user dismisses its implementation card
- **THEN** Specrails SHALL clear only the follow-up generation and its owned worktree
- **AND** SHALL leave the PR, branch, and review ticket state intact

#### Scenario: Discard blocked local follow-up

- **WHEN** a continuation has a dirty blocked local result and the user explicitly confirms discarding that local result
- **THEN** the local iteration MAY be removed
- **AND** the pre-existing PR and its head branch SHALL remain intact

#### Scenario: Recovered legacy delivery lacks a continuation marker

- **WHEN** migration recovers a successful but delivery-blocked row with an existing PR URL and no trustworthy historical continuation bit
- **AND** the user confirms Discard local result
- **THEN** only the recoverable local iteration MAY be removed
- **AND** the existing PR, its head branch, and its review ticket state SHALL remain unchanged
- **AND** the server behavior SHALL match the consequence shown by the card

#### Scenario: Recovered legacy commit is missing from the PR

- **WHEN** a migrated successful row is delivery-blocked, its existing PR does not contain the implementation, and startup can prove one clean exact commit from that rows recorded run/worktree/branch evidence
- **THEN** recovery SHALL persist that immutable commit as `delivery_sha`
- **AND** the card SHALL offer Retry push against the existing PR rather than only destructive discard
- **AND** retry SHALL push exactly that SHA after revalidating the PR lifecycle
- **AND** a terminal legacy `failed` worktree ledger MAY provide its exact recorded branch only when its run succeeded and any still-existing worktree passes clean HEAD/ref inspection

#### Scenario: Legacy commit cannot be proven exactly

- **WHEN** the recorded worktree is dirty or its run/ref evidence is missing, mismatched, or resolves to multiple commits
- **THEN** recovery SHALL keep delivery blocked and preserve the local result
- **AND** SHALL NOT infer a retry SHA from an unrelated historical ticket branch
- **AND** the card detail SHALL explain that exact recovery could not be proven

### Requirement: Delivery reasons and evidence survive refresh

The delivery ledger and every snapshot SHALL include a stable implementation outcome, delivery outcome, status code, continuation ownership, cleanup warnings, exact verified delivery SHA when available, and per-unit outcomes. The client SHALL localize the status code and treat raw detail as secondary diagnostics.

#### Scenario: Refresh after branch verification failure

- **WHEN** a successful implementation is blocked because the PR branch ref changed
- **THEN** a refreshed dashboard and agent conversation SHALL both say that implementation succeeded but branch verification blocked delivery
- **AND** SHALL show the PR link and run logs
- **AND** SHALL NOT offer an unsafe push retry

#### Scenario: Partial result refresh

- **WHEN** a two-unit launch settles with one success and one failure
- **THEN** both surfaces SHALL still show `1 of 2` after restart or refresh

### Requirement: Decision effects are single-winner and authoritative

Before executing any Git, GitHub, local merge, cleanup, or ticket effect for a decision, the platform SHALL atomically claim an operation lease. A concurrent action SHALL lose before external effects. Every action response SHALL carry the current authoritative delivery snapshot.

Repository-mutating actions and checkouts SHALL revalidate their captured process-admission generation after waiting for the repository lock and immediately before effects. Git/GitHub subprocesses that hold this lock SHALL have a bounded execution timeout.

Terminal ticket effects SHALL snapshot each ticket's current non-null outcome owner atomically with the terminal decision. Replay SHALL mutate JSON and enqueue Jira work only for tickets still at `on_review` whose owner still exactly matches that snapshot. JSON mutation, Jira enqueue, and effect completion SHALL be independently durable and idempotent.

#### Scenario: Publish races discard

- **WHEN** publish and discard are submitted concurrently against the same draft snapshot
- **THEN** one action SHALL claim the row
- **AND** the losing action SHALL perform no GitHub, Git, cleanup, or ticket effect
- **AND** it SHALL receive the authoritative current snapshot

#### Scenario: WebSocket update is lost

- **WHEN** an action commits successfully but its WebSocket broadcast is not received
- **THEN** the initiating surface SHALL update from the authoritative HTTP response
- **AND** a later refresh/focus hydration SHALL converge every other surface

#### Scenario: Multi-branch local integration conflicts

- **WHEN** local integration of any source branch conflicts
- **THEN** the user's integration checkout and HEAD SHALL remain exactly as they were before the action
- **AND** the delivery SHALL remain actionable

#### Scenario: No-change acknowledgement races another action

- **WHEN** acknowledge-no-changes and refine/discard race for the same fresh no-change generation
- **THEN** exactly one action SHALL claim the delivery before ticket or cleanup effects
- **AND** the loser SHALL receive the authoritative winning snapshot without applying effects

#### Scenario: Checkout races local integration

- **WHEN** one action checks out a review branch while another attempts local integration in the same repository
- **THEN** both main-checkout mutations SHALL serialize on the repository lock
- **AND** local integration SHALL revalidate and advance only the integration branch the user authorized

#### Scenario: Process stops after a terminal decision commit

- **WHEN** a terminal discard, merge, local integration, or no-change acknowledgement commits before its ticket-file effect finishes
- **THEN** the ticket effect SHALL remain in a durable idempotent outbox
- **AND** startup SHALL replay it until the affected review tickets reach the intended status

#### Scenario: Recovery begins while a decision waits for the repository lock

- **WHEN** an action captured admission but recovery or shutdown invalidates that generation before the action acquires the repository lock
- **THEN** the action SHALL stop before any Git, GitHub, checkout, cleanup, or ticket effect
- **AND** any claimed decision operation SHALL be released without changing the delivery outcome

#### Scenario: Old terminal effect meets a newer ticket iteration

- **WHEN** a pending terminal effect captured owner A and the ticket is later claimed by owner B before replay
- **THEN** replay SHALL NOT change that ticket's JSON status or enqueue a Jira operation for it
- **AND** the stale effect SHALL complete idempotently as a causal no-op for that ticket

#### Scenario: Command wedges while holding repository serialization

- **WHEN** a Git or GitHub subprocess used by a decision does not terminate
- **THEN** the platform SHALL stop it after the bounded command timeout
- **AND** SHALL release the decision lease and repository lock so later actions can proceed

### Requirement: Pull-request creation is idempotent

After a branch push, the platform SHALL discover and adopt an existing open PR for the exact head/base when creation returns no parseable URL, reports an existing PR, or is retried after an ambiguous interruption.

#### Scenario: GitHub creates PR but returns no URL

- **WHEN** `gh pr create` exits successfully without a parseable URL and exact head/base lookup finds the PR
- **THEN** the ledger SHALL persist that PR URL and lifecycle
- **AND** the card SHALL not remain in a create-retry loop

#### Scenario: Retry sees already-existing PR

- **WHEN** a retry receives an already-exists error and exact lookup finds one open PR
- **THEN** it SHALL adopt that PR instead of attempting to create a duplicate

#### Scenario: Multi-unit degraded delivery is retried

- **WHEN** a previously assembled batch branch was pushed but PR creation degraded
- **THEN** retry SHALL reuse that owned batch head and exact head/base identity
- **AND** SHALL NOT delete and recreate divergent merge commits before exact PR discovery

### Requirement: Delivery uses immutable settled objects

Every deliverable unit SHALL be identified by its verified final commit SHA. PR creation and batch assembly SHALL push or merge those exact objects, not whichever commit a mutable branch name or historical ticket worktree happens to reference later.

#### Scenario: Recorded branch is moved after settlement

- **WHEN** a unit branch moves after its final SHA was persisted
- **THEN** delivery SHALL still use the persisted final SHA or fail closed
- **AND** SHALL NOT deliver the moved ref

#### Scenario: Recorded branch is missing

- **WHEN** the recorded branch no longer exists but the persisted final commit object still exists
- **THEN** delivery MAY recreate/push the intended head from that exact object
- **AND** SHALL NOT substitute an arbitrary older worktree branch for the same ticket

### Requirement: Closed-without-merge is a first-class PR state

Polling an attached PR SHALL distinguish open, merged, and closed-without-merge. Closed-without-merge SHALL be actionable and SHALL never be presented as merely not merged yet.

#### Scenario: PR was closed without merge

- **WHEN** GitHub reports the attached PR state as `CLOSED` with no merge
- **THEN** the decision SHALL become `pr_closed`
- **AND** both cards SHALL say it was closed without merge
- **AND** SHALL offer reopen plus ownership-safe dismiss/discard actions
- **AND** a poll action SHALL NOT also announce that the PR is merely not merged yet

#### Scenario: Recorded PR was already merged before a second launch

- **WHEN** an active delivery row still says draft/ready but GitHub reports that its PR is no longer open
- **THEN** the platform SHALL NOT admit it as an existing-PR continuation
- **AND** SHALL NOT supersede the prior generation *as a continuation*, allocate its borrowed branch, or push implementation work under the stale lifecycle
- **AND** MAY terminalize/supersede that generation atomically while creating a fresh, non-continuation generation on a newly allocated branch

#### Scenario: PR merges concurrently with a follow-up push

- **WHEN** a continuation verifies an open PR, produces an exact delivery SHA, and the PR merges while that SHA is being pushed
- **THEN** the platform SHALL re-observe the PR after the push
- **AND** SHALL consider the old PR to have delivered the follow-up only when its observed commits or merge data contain that exact SHA
- **AND** otherwise SHALL preserve the exact SHA and offer creation of a new draft PR without claiming that the old PR delivered it

#### Scenario: Merge polling cannot prove the delivered SHA was included

- **WHEN** GitHub reports the attached PR as merged but its observed commits/merge data do not contain the delivery's exact verified SHA
- **THEN** the delivery SHALL NOT become terminal merged and its tickets SHALL NOT move to Done
- **AND** the delivery SHALL detach from the stale PR and remain actionable for a new draft PR from the preserved SHA

### Requirement: Cleanup results are honest

Cleanup SHALL collect bounded warnings for failures to close a PR, remove a worktree, or delete a branch. The terminal snapshot and user feedback SHALL disclose incomplete cleanup rather than promising that every resource was removed.

Cleanup SHALL also prove branch ownership. It SHALL delete only unit or assembled branches durably recorded as created by that delivery, never a recomputed preferred name or a pre-existing branch that merely collided with it.

#### Scenario: PR close fails during discard

- **WHEN** local cleanup completes but `gh pr close` fails
- **THEN** the delivery MAY become terminal discarded
- **AND** its snapshot SHALL retain a cleanup warning and PR link
- **AND** both surfaces SHALL tell the user that cleanup needs attention

#### Scenario: Preferred batch name belongs to the user

- **WHEN** a user branch already owns the preferred batch name and delivery creates a suffixed batch branch
- **THEN** discard or post-merge cleanup SHALL delete only the recorded suffixed branch
- **AND** SHALL never delete the user's colliding branch

#### Scenario: Legacy branch ownership is unknown

- **WHEN** terminal cleanup reads a legacy delivered branch without durable ownership evidence
- **THEN** it SHALL preserve the branch
- **AND** SHALL report `cleanup_incomplete` with a bounded ownership warning rather than claiming full cleanup

### Requirement: Premium implementation cards share one semantic model

Dashboard and agent-chat surfaces SHALL derive titles, tones, evidence, links, log access, retry labels, confirmations, and destructive consequences from the same durable outcome axes. All action-required states SHALL be accessible and localized.

#### Scenario: Existing PR push fails

- **WHEN** implementation succeeds but its verified commit cannot be pushed to an existing PR
- **THEN** the card SHALL say that updating that PR failed
- **AND** the action SHALL be labelled Retry push, not Create PR
- **AND** it SHALL explain that the verified local changes are safe

#### Scenario: Dashboard implementation failure

- **WHEN** a delivery is `implementation_failed`
- **THEN** the dashboard SHALL provide direct access to every run log referenced by the delivery

#### Scenario: Integrate locally from agent chat

- **WHEN** the user chooses Integrate locally in agent chat
- **THEN** the card SHALL show the same consequence confirmation used by the dashboard before calling the server

#### Scenario: Local-only delivery

- **WHEN** a branch could not be pushed and `pr_state` is `local-only`
- **THEN** neither surface SHALL claim that the branch was pushed

### Requirement: Startup recovery makes every stale generation actionable

Project process admission SHALL remain closed while startup recovery reconciles stale deliveries and worktrees under repository serialization. Recovery SHALL use durable run outcomes and preserve uncertain work. Read-only hydration requests SHALL NOT run crash recovery against a live generation.

Startup SHALL clear prior-process decision tokens before card projection. It SHALL retry pending terminal ticket effects in-process with bounded backoff and SHALL keep admission closed while any such effect remains pending; both card surfaces SHALL disclose the pending cleanup state.

#### Scenario: Crash after successful engine completion

- **WHEN** startup finds a completed successful run, an unfinished terminal callback, a `building` delivery, and dirty worktree state
- **THEN** it SHALL preserve the successful implementation outcome
- **AND** SHALL preserve the worktree
- **AND** SHALL move the delivery to blocked `settlement_interrupted`, never `implementation_failed`

#### Scenario: Building row has no run ids

- **WHEN** startup finds a prior-process `building` row whose allocation never persisted run ids
- **THEN** it SHALL move the row to an explicit actionable interrupted state
- **AND** SHALL not let it block launches forever

#### Scenario: Startup sweep overlaps a new launch

- **WHEN** worktree reconciliation is still running
- **THEN** process admission SHALL reject or wait for a new launch
- **AND** the reconciler SHALL never remove a worktree owned by the new generation

#### Scenario: Client refreshes during live settlement

- **WHEN** the loop outcome is durable but the same live process is still committing or verifying its worktree
- **AND** a client requests the rail snapshot
- **THEN** the request SHALL return the current `building` generation without reclassifying it as interrupted
- **AND** the live settlement SHALL retain authority to publish its final delivery outcome

#### Scenario: Process dies while a decision operation is leased

- **WHEN** startup finds a non-terminal delivery with a prior-process operation token
- **THEN** it SHALL clear the token before admitting actions
- **AND** SHALL preserve all implementation and delivery evidence
- **AND** both cards SHALL explain that the prior operation was interrupted and can be retried safely

#### Scenario: Transient ticket-effect replay failure

- **WHEN** startup cannot initially finish a terminal JSON or Jira effect
- **THEN** it SHALL retain a cleanup warning and keep project process admission closed
- **AND** SHALL retry the effect in-process without requiring another restart
- **AND** SHALL clear the pending warning and open admission only after every phase is durably complete
