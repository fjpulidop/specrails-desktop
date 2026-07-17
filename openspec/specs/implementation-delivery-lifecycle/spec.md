# implementation-delivery-lifecycle Specification

## Purpose

TBD - created by syncing change harden-repeat-pr-implementation-flow. Update Purpose after archive.

## Requirements

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

The platform SHALL remove a worktree only after proving, immediately before removal, that all deliverable changes are clean and durably referenced by the recorded commit. That live proof SHALL include tracked, untracked, and ignored paths, while excluding only the trusted overlay paths durably recorded by Specrails for that worktree. Cleanup SHALL NOT unlink or recursively delete a mutable overlay pathname after a separate check. It SHALL atomically rename each authenticated overlay root beneath a persistent same-filesystem quarantine batch root, revalidate it after the rename, explicitly preserve any raced content there, and retain the quarantine from automatic deletion or automatic restoration over a possibly recreated source path. The batch root SHALL be durably recorded before the first child move, SHALL disclose every contained quarantine path through one inspectable root, and SHALL NOT be evicted from delivery state while its bytes remain on disk. Both implementation-card surfaces SHALL disclose safety archives independently from cleanup failures. Dirty, unknown, ref-mismatched, concurrently changed, or unauthenticated ignored worktrees SHALL remain recoverable even when the user dismisses or discards the card: the card MAY become terminal with an honest cleanup warning, but Specrails SHALL NOT interpret that workflow action as permission for forced byte deletion. Worktree release SHALL use non-force removal.

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

#### Scenario: Ignored user data exists beside a trusted overlay

- **WHEN** a worktree contains ignored or untracked paths that are not among its durably recorded Specrails overlay paths
- **THEN** automatic release SHALL preserve the worktree even when ordinary porcelain status appears clean
- **AND** SHALL NOT trust a writable worktree manifest to classify those user paths as disposable

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
- **AND** A SHALL carry durable `restoredFromDeliveryId=B` rollback evidence
- **AND** the existing PR SHALL remain unchanged

### Requirement: Delivery snapshots converge monotonically by lineage

Every delivery snapshot SHALL carry its immutable generation identity, `createdAt`, `updatedAt`, lineage link when one generation supersedes another, and exact rollback lineage when a failed replacement restores its predecessor. Dashboard, Agent Chat, HTTP-response reconciliation, WebSocket ingestion, and hydration SHALL accept a different generation for a rail only when it explicitly supersedes the current generation, has a strictly later valid `createdAt` and is not known terminal or superseded, or proves the exact paired rollback described below. Snapshots for the same delivery id SHALL advance only by a strictly newer `updatedAt`, with a deterministic fail-closed tie policy that cannot replace a terminal or more advanced decision with stale data. Once a delivery id is observed terminal or superseded, a later non-terminal replay of that id SHALL be rejected except for the one predecessor snapshot whose `restoredFromDeliveryId` names the exact failed replacement that superseded it.

Hydration SHALL guard each rail with the accepted-mutation generation captured when its request starts. Only a snapshot that actually changes accepted state SHALL advance that guard. A response that crossed a live replacement or accepted terminal deletion SHALL preserve the live state or tombstone instead of restoring its stale seed.

#### Scenario: Superseded generation replays after its replacement

- **WHEN** generation B explicitly supersedes generation A on a rail
- **AND** a delayed non-terminal HTTP, WebSocket, or persisted-card snapshot for A arrives later
- **THEN** every surface SHALL keep B
- **AND** SHALL reject A even if A's delayed snapshot is received after a refresh

#### Scenario: Failed replacement explicitly restores its predecessor

- **WHEN** B explicitly supersedes A, clients tombstone A, and B then fails before allocating a verified implementation worktree
- **AND** B becomes terminal while A is atomically restored with `restoredFromDeliveryId=B`
- **THEN** dashboard, Agent Chat, persisted-card hydration, and pinning SHALL accept that exact A restoration
- **AND** each consumer SHALL accept that exact rollback pair at most once while the durable marker remains available to reconnecting clients
- **AND** superseding A with any later generation SHALL clear the old rollback marker
- **AND** a delayed A without that exact paired evidence SHALL remain rejected

#### Scenario: Hydration crosses a terminal transition

- **WHEN** hydration starts while generation B is active
- **AND** an accepted terminal snapshot removes B before the hydration response returns
- **AND** that response still contains non-terminal B
- **THEN** the accepted per-rail mutation guard and terminal tombstone SHALL prevent B from being resurrected

#### Scenario: Ignored old terminal arrives during initial hydration

- **WHEN** an in-flight hydration will return active generation B
- **AND** a delayed terminal snapshot for unrelated older generation A arrives while no generation is displayed on that rail
- **THEN** A SHALL be ignored without advancing the rail's accepted-mutation guard
- **AND** hydration SHALL still accept B rather than deleting it as an ABA-conflicted seed

#### Scenario: Different generation lacks ordering proof

- **WHEN** a snapshot for another delivery id neither explicitly supersedes the current generation nor has a strictly later valid `createdAt`
- **THEN** the client SHALL fail closed and retain the current generation

#### Scenario: Same delivery snapshots arrive out of order

- **WHEN** an older HTTP, persisted-card, or WebSocket snapshot for delivery B arrives after a newer B snapshot
- **THEN** every surface SHALL retain the newer `updatedAt` state
- **AND** an equal-time ambiguity SHALL fail closed without resurrecting an earlier decision or action set

#### Scenario: Confirmation outlives its rendered delivery

- **WHEN** the user opens a confirmation for generation A and a live update replaces it with B before confirmation
- **THEN** the confirmation SHALL be invalidated or bound to A so it cannot submit a destructive action for B
- **AND** stale rejected action responses SHALL NOT emit success feedback for the current generation

#### Scenario: Checkout click races a generation replacement

- **WHEN** a dashboard or agent card captures checkout for A but generation B becomes active before the request executes
- **THEN** the client and server SHALL reject A as stale before changing the user's checkout
- **AND** SHALL NOT substitute B's branch merely because it now occupies the same rail

### Requirement: Existing PR ownership controls cleanup

The platform SHALL treat a continuation's PR and head branch as borrowed user-owned review state. Dismissing or discarding a follow-up card SHALL NOT close that PR, delete that head branch, or return its tickets from review unless the user explicitly performs a separately described destructive PR action. PR/ticket ownership SHALL derive from the durable continuation marker repaired before actions are exposed; branch deletion SHALL independently honor each unit's `created | preexisting | borrowed-pr` ownership. A generic failure code SHALL infer neither.

#### Scenario: Dismiss successful follow-up

- **WHEN** a continuation has updated an existing PR and the user dismisses its implementation card
- **THEN** Specrails SHALL clear only the follow-up generation and its owned worktree
- **AND** SHALL leave the PR, branch, and review ticket state intact

#### Scenario: Relaunch after dismissing a local-only continuation

- **WHEN** the latest terminal generation touching the requested tickets is an explicitly discarded continuation for that exact complete ticket set
- **AND** its recorded PR is still exact `OPEN` at the recorded head/base and `headRefOid = delivery_sha`
- **AND** every available local or fetched head ref equals that SHA with no retained or unsettled worktree
- **THEN** the next implementation SHALL continue that same PR branch even without Jira or an explicit PR reference in the local spec
- **AND** the new generation SHALL persist the frozen baseline SHA before allocation completes
- **AND** it SHALL link `supersedesDeliveryId` to that exact terminal predecessor so equal-time clients deterministically elect the replacement

#### Scenario: Newer overlapping history shadows an older continuation

- **WHEN** a newer terminal generation contains any requested ticket but its ticket set, ownership, lifecycle, refs, or worktree evidence does not satisfy the exact historical-continuation contract
- **THEN** no older continuation SHALL be resurrected
- **AND** discovery SHALL NOT downgrade the authoritative failure into fuzzy Jira, title, branch-name, or external-PR inference
- **AND** this rule SHALL apply symmetrically when the newer generation is a subset or superset of the requested batch

#### Scenario: Discard blocked local follow-up

- **WHEN** a continuation has a dirty blocked local result and the user explicitly confirms discarding that local result
- **THEN** only resources that still pass the exact clean HEAD/ref/ignored-path preflight MAY be removed
- **AND** any changed local bytes and their checked-out branch SHALL remain preserved with a cleanup warning
- **AND** the pre-existing PR and its head branch SHALL remain intact

#### Scenario: Fresh blocked result still owns its attached PR

- **WHEN** a fresh non-continuation delivery is blocked after a PR has been attached
- **THEN** both cards SHALL offer ordinary `Discard`, not ownership-safe `Discard local result`
- **AND** its confirmation SHALL disclose that the PR will close and tickets return to the backlog
- **AND** the server's existing fresh discard semantics SHALL match that copy

#### Scenario: Recovered legacy delivery lacks a continuation marker

- **WHEN** migration recovers a successful but delivery-blocked row with an existing PR URL and no trustworthy historical continuation bit
- **AND** the user confirms Discard local result
- **THEN** only the recoverable local iteration MAY be removed
- **AND** the existing PR, its head branch, and its review ticket state SHALL remain unchanged
- **AND** the server behavior SHALL match the consequence shown by the card

#### Scenario: Recovered legacy commit is missing from the PR

- **WHEN** a migrated successful row is delivery-blocked, its existing PR does not contain the implementation, and startup can prove one clean exact commit whose subject carries that row's recorded run settlement marker
- **THEN** recovery SHALL persist that immutable commit as `delivery_sha`
- **AND** the card SHALL offer Retry push against the existing PR rather than only destructive discard
- **AND** retry SHALL push exactly that SHA after revalidating the PR lifecycle
- **AND** a terminal legacy `failed` worktree ledger MAY provide its exact recorded branch only when the candidate commit subject carries that same marker, its run succeeded, and any still-existing worktree passes clean HEAD/ref inspection

#### Scenario: Legacy candidate is already the PR head

- **WHEN** legacy recovery resolves the recorded branch to the same SHA already exposed as the open PR head
- **AND** that commit's subject does not carry the recorded run's unique settlement marker
- **THEN** it SHALL NOT present that SHA as newly recovered follow-up progress
- **AND** it SHALL NOT offer a no-op Retry push
- **AND** it SHALL preserve the branch/object and explain that durable evidence cannot prove a missing follow-up commit

#### Scenario: Run commit survives only in reflog

- **WHEN** the recorded branch tip no longer contains the follow-up but refs/reflogs contain exactly one commit whose subject carries the delivery run's unique settlement marker
- **THEN** recovery SHALL freeze that causally owned commit as `delivery_sha`
- **AND** SHALL offer Retry push when the recorded open PR does not expose it

#### Scenario: Earlier legacy recovery froze the wrong SHA

- **WHEN** startup finds a legacy-recovered draft/ready row whose stored `delivery_sha` differs from the unique commit whose subject carries the run marker
- **THEN** it SHALL replace the wrong SHA with the causally proven commit
- **AND** SHALL restore Retry push when that commit is absent from the recorded open PR
- **AND** SHALL keep the row blocked when causal evidence is absent or ambiguous

#### Scenario: Legacy recovery reaches PR ready

- **WHEN** an existing-PR legacy recovery becomes retryable or delivery-verified without a trustworthy historical continuation bit
- **THEN** recovery SHALL durably restore borrowed ownership before exposing later actions
- **AND** both surfaces SHALL offer ownership-safe Dismiss rather than destructive Discard
- **AND** a stale client that nevertheless submits Discard SHALL NOT close the PR, delete its head branch, or return its review tickets

#### Scenario: Legacy commit cannot be proven exactly

- **WHEN** the recorded worktree is dirty or its run/ref evidence is missing, mismatched, or resolves to multiple commits
- **THEN** recovery SHALL keep delivery blocked and preserve the local result
- **AND** SHALL NOT infer a retry SHA from an unrelated historical ticket branch
- **AND** the card detail SHALL explain that exact recovery could not be proven

#### Scenario: Legacy marker is absent from the commit subject

- **WHEN** a legacy candidate is associated by branch, worktree, reflog, or commit body but its commit subject does not carry the exact recorded run settlement marker
- **THEN** recovery SHALL reject that candidate as causal evidence
- **AND** SHALL preserve the branch/object without freezing it as `delivery_sha` or offering Retry push

#### Scenario: Run-owned commit survives only as an unreachable Git object

- **WHEN** refs and reflogs no longer expose the interrupted settlement commit
- **AND** `git fsck --unreachable --no-reflogs --no-progress` exposes exactly one commit whose subject carries the delivery run's exact settlement marker
- **THEN** startup recovery SHALL freeze that object as `delivery_sha` and continue the ordinary exact-PR retry classification
- **AND** malformed, failed, zero-result, or multiple marked-object discovery SHALL remain blocked without adopting an unmarked branch tip

#### Scenario: User commits and retries a preserved isolated result

- **WHEN** automatic recovery cannot prove a commit but the active blocked continuation still owns one exact recorded worktree/branch and successful run
- **AND** the user confirms Commit & retry push
- **THEN** Specrails SHALL revalidate the exact open PR head/base, stage only deliverable paths in that isolated worktree, and create a run-marked commit when changes are uncommitted
- **AND** it SHALL require an exact per-unit run/branch record and authenticate the non-symlink path as a uniquely registered worktree of this repository both before inspection and immediately before staging
- **AND** never-commit/private paths SHALL remain excluded even when previously staged, concurrently staged, or added by a repository hook
- **AND** before claiming no local change it SHALL apply the same bounded refs/reflogs/unreachable exact-subject scan as startup and fail closed if enumeration, subject inspection, or uniqueness cannot be proven
- **AND** an already-committed candidate MAY be adopted only when it is every matching unit's consistent durable `finalSha` or the unique exact-subject run-marked commit, and every matching unit SHALL be updated together
- **AND** it SHALL pin a proven candidate under a delivery-specific internal recovery ref before persisting or pushing it, retain that ref across interruption, and remove it only after exact remote delivery or explicit local-result discard
- **AND** a push SHALL require GitHub proof that the PR is not cross-repository plus exact equality between the PR repository and the local `origin` push URL
- **AND** it SHALL persist and push the exact candidate SHA without force, then re-observe delivery
- **AND** it SHALL NOT modify, stash, clean, or switch the user's main checkout

#### Scenario: Explicit recovery evidence is unsafe or absent

- **WHEN** the preserved worktree/branch is missing, ambiguous, divergent, on another ref, cannot commit cleanly, or the PR identity/lifecycle changed
- **THEN** Commit & retry push SHALL fail closed with an actionable explanation
- **AND** all remaining local evidence SHALL stay intact

#### Scenario: Removed worktree left a uniquely recoverable orphan commit

- **WHEN** the recorded worktree is gone and the local PR branch still equals the live PR head
- **AND** refs, reflogs, or bounded unreachable-object discovery proves exactly one fast-forward commit with the exact run marker
- **THEN** explicit recovery SHALL pin that object with an internal recovery ref, persist its SHA, and deliver exactly that object without moving the user's checkout or branch
- **AND** a crash before delivery verification SHALL leave the object reachable for ordinary retry

#### Scenario: Local branch advanced after the implementation run

- **WHEN** the recorded branch tip is ahead of the PR but differs from both the consistent durable unit `finalSha` and the unique run-marked commit
- **THEN** explicit recovery SHALL NOT adopt, bundle, commit on top of, or push that later branch tip
- **AND** the later local work SHALL remain intact with an actionable branch-drift explanation

#### Scenario: A live unsafe worktree coexists with a run-owned orphan

- **WHEN** the recorded worktree path is dirty, recreated, unauthenticated, or resolves to a different HEAD while causal discovery also finds one exact run-owned commit
- **THEN** Specrails SHALL pin the run-owned commit before depending on network state
- **AND** SHALL preserve the worktree and protected object as distinct results without committing, bundling, selecting, or pushing either automatically
- **AND** the card SHALL expose the authenticated path and protected SHA when available so the user can inspect or explicitly discard the local result

#### Scenario: Recovery is interrupted after pinning but before SHA persistence

- **WHEN** the process stops after creating the delivery-specific recovery ref but before writing `delivery_sha`
- **THEN** restart SHALL preserve the recovery-family status and rerun causal reconciliation rather than replacing it with a generic interrupted-operation dead end
- **AND** the exact delivery-specific recovery ref SHALL remain authoritative when its newer commit and an unreachable marker-bearing ancestor would otherwise make the global run-marker scan ambiguous
- **AND WHEN** the user explicitly discards the local result
- **THEN** Specrails MAY remove that internal ref only after its exact object is re-proven by the delivery's durable final SHA or run marker
- **AND** a substituted or unreadable ref SHALL be retained with a cleanup warning

#### Scenario: Recovery baseline has no proven deliverable result on this computer

- **WHEN** the worktree/branch equals the live PR head and bounded causal discovery finds no additional run-owned commit
- **AND** durable units do not consistently prove a no-change result or already-delivered final SHA
- **THEN** the delivery SHALL remain blocked with stable status `recovery_unavailable`
- **AND** both cards SHALL say that no single recoverable result could be proven on this computer, preserve every local object/path, hide Commit and Checkout, and offer localized Recheck plus ownership-safe Inspect/Dismiss or explicit local-result discard actions as applicable

#### Scenario: Manual recovery proves no changes or an already-delivered result

- **WHEN** every matching unit proves `changed=false` and `initialSha=finalSha=live PR head`
- **THEN** the continuation SHALL become `no_changes` without a commit, push, removal, or failure claim
- **OR WHEN** a consistent durable final SHA or unique run-owned commit already equals the exact live PR head
- **THEN** the attached PR SHALL be classified as already containing the implementation without a redundant push

#### Scenario: Recovery path or push ownership is substituted

- **WHEN** a recorded path is a symlink, the main checkout, an ordinary reused directory, absent from this repository's live worktree registry, or changes identity before staging
- **OR** the attached PR is cross-repository or local `origin` does not identify that PR's repository
- **THEN** recovery SHALL perform no commit or push from that evidence
- **AND** SHALL retain the local result with an actionable ownership diagnostic

#### Scenario: GitHub is unavailable after exact legacy recovery

- **WHEN** startup has uniquely proven and frozen the run-owned legacy commit but transiently cannot observe the recorded PR
- **THEN** it SHALL preserve the PR attachment, branch, and exact `delivery_sha`
- **AND** SHALL expose a retryable delivery state whose Retry push revalidates lifecycle before any mutation
- **AND** SHALL NOT downgrade the proven commit to an unrecoverable blocked result

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

### Requirement: Attached PR lifecycle is exact, causal, and actionable

Continuation admission, Retry push, reopen, and every poll/verification or post-push observation SHALL validate the recorded PR identity, exact head/base names, and the immutable `delivery_sha` against GitHub's `OPEN`, `CLOSED`, or `MERGED` evidence. Admission SHALL remain read-only and accept only exact `OPEN` evidence; otherwise it SHALL refuse to launch or supersede and direct the user to reconcile the existing card. An exact `MERGED` observation that contains `delivery_sha` SHALL terminalize the delivery immediately in the observing decision action. A definitively stale or retargeted PR, or a `CLOSED`/`MERGED` PR that does not contain `delivery_sha`, SHALL be detached by that decision action and return to `on_review` with the SHA and local branch preserved for a new PR. A transient observation failure SHALL fail closed without guessing or detaching.

Every continuation SHALL prove that the allocated local worktree and branch ref both start exactly at a frozen remote PR head. For an internal delivery that baseline is `delivery_sha`. For an inferred external PR, list/search data is discovery evidence only; an authoritative exact-PR observation SHALL prove the PR is `OPEN`, validate exact head/base, and provide a valid `headRefOid` that becomes the immutable allocation baseline. Local commits beyond either baseline are preserved but SHALL NOT be silently folded into the new run. After implementation, worktree HEAD and the local branch ref MAY advance together to the newly created commit, which SHALL be verified and frozen as the exact push SHA. Immediately before every automatic or user-triggered existing-PR push, the local `origin` SHALL resolve to exactly one push URL identifying the GitHub repository that owns the recorded same-repository PR; missing, multiple, ambiguous, fork, or mismatched targets SHALL fail closed without a push. Delivery SHALL reject credential-bearing userinfo, passwords, query strings, or fragments, authenticate through credential helpers, and push through the already-verified exact URL rather than resolving the mutable alias again. An external open PR may be inferred only from an explicit PR number in the ticket/spec or an authoritative Jira key match. A repository-local ticket number, title similarity, branch wording, or `Fixes #<local-id>` in an unrelated PR is not continuation authority.

#### Scenario: Exact PR was closed without merge

- **WHEN** GitHub reports the attached PR as `CLOSED`
- **AND** its recorded identity and exact head/base still match
- **AND** its commit evidence contains `delivery_sha`
- **THEN** the decision SHALL become `pr_closed`
- **AND** both cards SHALL say it was closed without merge
- **AND** SHALL offer reopen plus ownership-safe dismiss/discard actions
- **AND** a poll action SHALL NOT also announce that the PR is merely not merged yet

#### Scenario: Exact PR was already merged before a second launch

- **WHEN** continuation admission observes the recorded PR as `MERGED` with exact head/base and commit evidence containing `delivery_sha`
- **THEN** the platform SHALL NOT admit or supersede it as an existing-PR continuation
- **AND** SHALL direct the user to Verify PR without mutating or discarding the preserved delivery
- **AND** that decision action SHALL terminalize it as `merged`, including its terminal ticket effect
- **AND** a later implementation MAY begin only as a fresh generation after that terminal transition

#### Scenario: Attached PR is stale, retargeted, or terminal without the delivery SHA

- **WHEN** Retry push, reopen, post-push verification, or polling definitively observes a different head/base identity
- **OR** observes the recorded PR as `CLOSED` or `MERGED` without commit evidence containing `delivery_sha`
- **THEN** the delivery SHALL detach its stale PR URL/number and return to `on_review`
- **AND** SHALL preserve `delivery_sha` and its local branch for creation of a new draft PR
- **AND** SHALL NOT push to, reopen, or claim completion through the stale PR

#### Scenario: Admission sees stale or unverifiable attached PR evidence

- **WHEN** continuation admission cannot prove exact `OPEN` head/base and `delivery_sha` evidence
- **THEN** it SHALL refuse the new launch before worktree allocation or supersession
- **AND** SHALL preserve the existing generation for Retry push or Verify PR reconciliation

#### Scenario: Local continuation branch is ahead of the verified PR baseline

- **WHEN** GitHub still proves the recorded open PR at `delivery_sha` but the local branch/worktree HEAD is a different later commit
- **THEN** admission SHALL refuse before the implementation run starts
- **AND** SHALL preserve both generations and the local commits for explicit reconciliation
- **AND** SHALL NOT treat the later local object as part of the verified PR baseline

#### Scenario: Externally inferred PR has an unrelated local-ahead branch

- **WHEN** authoritative GitHub evidence freezes external PR head A but the same local branch already points at unrelated later commit B
- **THEN** admission SHALL refuse before the implementation run starts or any push occurs
- **AND** SHALL preserve B for explicit reconciliation

#### Scenario: Valid continuation creates a new commit

- **WHEN** a continuation worktree starts exactly at verified baseline A and the implementation cleanly advances both worktree HEAD and its branch ref to C
- **THEN** post-run verification SHALL accept C rather than incorrectly requiring the old A baseline
- **AND** pre-push settlement SHALL reverify and push exactly immutable C

#### Scenario: Automatic continuation push remote does not own the PR

- **WHEN** a continuation produces verified immutable commit C for a same-repository PR
- **AND** the local `origin` resolves to zero, multiple, ambiguous, or differently-owned push URLs
- **THEN** initial settlement SHALL perform no push
- **AND** SHALL preserve C in a retryable delivery state with an actionable ownership diagnostic

#### Scenario: Unrelated PR mentions a local ticket number

- **WHEN** an `on_review` local ticket has no explicit PR number or authoritative Jira link
- **AND** an open repository PR merely contains the same local number, title wording, or `Fixes #<id>` text
- **THEN** Specrails SHALL start the normal fresh-branch flow
- **AND** SHALL NOT allocate, push to, or claim ownership of that external PR head

#### Scenario: PR lifecycle cannot be observed reliably

- **WHEN** GitHub observation fails transiently before exact identity and SHA inclusion can be proven
- **THEN** the platform SHALL preserve the current attachment and immutable evidence
- **AND** SHALL return a retryable observation failure without guessing `OPEN`, `CLOSED`, or `MERGED`

#### Scenario: Recorded PR is no longer a valid continuation target

- **WHEN** an active delivery row still says draft/ready but exact lifecycle validation cannot prove an `OPEN` PR with the recorded head/base
- **THEN** the platform SHALL NOT admit it as an existing-PR continuation
- **AND** SHALL NOT supersede the prior generation *as a continuation*, allocate its borrowed branch, or push implementation work under the stale lifecycle
- **AND** SHALL first apply the exact merged-terminal or detach-to-`on_review` outcome described above

#### Scenario: PR merges concurrently with a follow-up push

- **WHEN** a continuation verifies an open PR, produces an exact delivery SHA, and the PR merges while that SHA is being pushed
- **THEN** the platform SHALL re-observe the PR after the push
- **AND** SHALL consider the old PR to have delivered the follow-up only when its observed commits or merge data contain that exact SHA
- **AND** an exact match SHALL terminalize immediately in that Retry action
- **AND** otherwise SHALL detach, preserve the exact SHA, and offer creation of a new draft PR without claiming that the old PR delivered it

#### Scenario: PR closes concurrently with initial follow-up delivery

- **WHEN** the initial continuation settlement pushes the exact SHA and post-push observation proves the recorded PR closed with that SHA
- **THEN** the durable decision SHALL become `pr_closed` with Reopen available
- **AND** SHALL NOT report a generic push failure or claim that the PR merged

#### Scenario: PR merges concurrently with initial follow-up delivery

- **WHEN** initial continuation settlement proves the recorded PR merged with the exact pushed SHA
- **THEN** it SHALL retain the exact attachment in an actionable PR-verification state
- **AND** the explicit Verify PR decision SHALL atomically terminalize the delivery and its ticket effect

#### Scenario: Merge polling cannot prove the delivered SHA was included

- **WHEN** GitHub reports the attached PR as merged but its observed commits/merge data do not contain the delivery's exact verified SHA
- **THEN** the delivery SHALL NOT become terminal merged and its tickets SHALL NOT move to Done
- **AND** the delivery SHALL detach from the stale PR and remain actionable for a new draft PR from the preserved SHA

#### Scenario: Reopen revalidates identity and delivery evidence

- **WHEN** the user requests Reopen for a `pr_closed` delivery
- **THEN** the platform SHALL first require the exact recorded PR head/base and commit evidence containing `delivery_sha`
- **AND** SHALL re-observe the reopened PR before returning to draft/ready
- **AND** a mismatch or missing SHA SHALL detach to `on_review` with `delivery_sha` preserved instead of reopening or retaining the stale attachment

#### Scenario: PR reaches a terminal state while reopen is in flight

- **WHEN** preflight proves an exact closed PR but post-effect observation reports `MERGED` or still `CLOSED`
- **THEN** an exact merged observation SHALL terminalize through the same claimed Reopen action
- **AND** stale identity or missing-SHA terminal evidence SHALL detach to `on_review` with the immutable commit preserved
- **AND** an exact still-closed observation SHALL remain closed and report the failed reopen without claiming success

#### Scenario: Open PR no longer exposes the delivered SHA

- **WHEN** a delivery check finds the recorded PR still open with the exact head/base names but its remote head is not `delivery_sha`
- **THEN** the delivery SHALL become retryable again with the immutable SHA preserved
- **AND** both surfaces SHALL explain that the commit is missing instead of only saying the PR is not merged

#### Scenario: Open PR delivery is verified

- **WHEN** a Retry push or later PR check observes the exact open head/base and `headRefOid = delivery_sha`
- **THEN** the response SHALL include explicit verified commit evidence
- **AND** both surfaces SHALL confirm the short SHA and PR immediately
- **AND** a Retry response SHALL distinguish a push that ran from a commit that was already present

### Requirement: Cleanup results are honest

Cleanup SHALL collect bounded warnings for failures to close a PR, remove a worktree, or delete a branch. The terminal snapshot and user feedback SHALL disclose incomplete cleanup rather than promising that every resource was removed. When a terminal dashboard action removes the card, retained recovery details SHALL remain visible in a persistent localized notification with a direct copy action.

Cleanup SHALL also prove branch ownership. It SHALL delete only unit or assembled branches durably recorded as created by that delivery, never a recomputed preferred name or a pre-existing branch that merely collided with it.

Fresh discard SHALL close its PR without an unleased remote-head deletion. Local deletion SHALL additionally require the current owned branch tip to equal its frozen delivery SHA; an advanced or unverifiable branch SHALL be preserved with a cleanup warning.

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

#### Scenario: Owned branch advances after delivery freezes its SHA

- **WHEN** terminal cleanup finds that a delivery-owned branch now points beyond its recorded frozen SHA
- **THEN** it SHALL preserve the advanced branch and report incomplete cleanup
- **AND** SHALL NOT use forced branch deletion to erase later user or process work

#### Scenario: Replacement PR borrows an existing head

- **WHEN** discard closes a Specrails-created replacement PR whose head branch ownership is `preexisting` or `borrowed-pr`
- **THEN** the GitHub close operation SHALL NOT request remote branch deletion
- **AND** local cleanup SHALL preserve that head ref
- **AND** if the replacement itself is fresh rather than a continuation, its PR MAY still close and its tickets MAY follow fresh discard semantics

### Requirement: Premium implementation cards share one semantic model

Dashboard and agent-chat surfaces SHALL derive titles, tones, evidence, links, log access, retry labels, confirmations, and destructive consequences from the same durable outcome axes. All action-required states SHALL be accessible and localized.

#### Scenario: Existing PR push fails

- **WHEN** implementation succeeds but its verified commit cannot be pushed to an existing PR
- **THEN** the card SHALL say that updating that PR failed
- **AND** the action SHALL be labelled Retry push, not Create PR
- **AND** it SHALL explain that the verified local changes are safe

#### Scenario: Recovered retryable result retains a legacy blocked status code

- **WHEN** durable recovery sets `delivery_outcome=retryable_failure` while an older diagnostic still says `settlement_interrupted`
- **THEN** both cards SHALL render exactly one Retry push action
- **AND** SHALL NOT render the delivery-blocked action set

#### Scenario: Implementation failure carries delivery diagnostics

- **WHEN** `implementation_outcome=failed` is accompanied by a blocked delivery outcome or commit-stage status code
- **THEN** both cards SHALL render the implementation-failed state and its run-log evidence
- **AND** SHALL NOT claim that implementation succeeded or offer delivery retry actions

#### Scenario: Dashboard implementation failure

- **WHEN** a delivery is `implementation_failed`
- **THEN** the dashboard SHALL provide direct access to every run log referenced by the delivery

#### Scenario: Integrate locally from agent chat

- **WHEN** the user chooses Integrate locally in agent chat
- **THEN** the card SHALL show the same consequence confirmation used by the dashboard before calling the server

#### Scenario: Local-only delivery

- **WHEN** a branch could not be pushed and `pr_state` is `local-only`
- **THEN** neither surface SHALL claim that the branch was pushed

#### Scenario: Legacy duplicate agent cards disagree

- **WHEN** a conversation contains multiple PR-decision system rows for the same `prDeliveryId`
- **THEN** the server SHALL consolidate them to one durable authoritative row
- **AND** the client SHALL render at most one card and one action set before and after hydration
- **AND** an older blocked card SHALL NOT coexist with current Retry push or PR-verification controls

#### Scenario: Delivery state is rendered in every supported locale

- **WHEN** either implementation-card surface renders an action, confirmation, recovery explanation, verified-SHA result, or cleanup warning
- **THEN** equivalent keys SHALL exist in `de`, `en`, `es`, `fr`, `it`, `ja`, `pt`, and `zh`
- **AND** locale parity SHALL fail verification if any supported language falls back because a key is missing

#### Scenario: Blocked legacy result has local recovery evidence

- **WHEN** a successful legacy continuation is blocked without an immutable `delivery_sha`
- **THEN** neither card SHALL offer Checkout as though the old PR branch contained the implementation
- **AND** a live delivery-owned worktree SHALL be exposed through Inspect local result with its exact copyable/revealable path
- **AND** both cards SHALL offer the confirmed recovery action when the server-side recovery contract is eligible
- **AND** when no authenticated worktree path is available on this computer, the continuation SHALL offer ownership-safe Dismiss rather than claim that a local result will be discarded

#### Scenario: Main checkout is dirty

- **WHEN** the user requests ordinary Checkout for an otherwise deliverable PR while the main project folder has uncommitted changes
- **THEN** the server SHALL refuse before releasing any worktree or changing any ref
- **AND** both surfaces SHALL localize that protective refusal and state that nothing changed

#### Scenario: Main checkout cleanliness is unreadable or delivery changes while queued

- **WHEN** `git status` fails or times out before Checkout
- **OR** the same delivery loses or changes its attached PR branch while Checkout waits for the repository lock
- **THEN** the server SHALL fail closed before worktree release and use no pre-lock branch value
- **AND** both surfaces SHALL present a localized protective refusal

#### Scenario: A deliverable PR branch diverged locally before Checkout

- **WHEN** a delivery has immutable `delivery_sha=D` but the same-named local or fetched remote branch points to another commit `U`
- **THEN** Checkout SHALL preserve `U`, refuse before switching the main checkout, and explain that the branch does not match the verified delivery
- **AND** a successful Checkout SHALL revalidate after switching that both the checked-out branch and `HEAD` equal `D`
- **AND** a failed `pull --ff-only` or mutable branch-name match SHALL never be reported as successful delivery checkout

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
</content>
</invoke>
