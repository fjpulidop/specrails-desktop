## Context

An isolated implementation currently reduces several independent facts to one boolean named `succeeded`: whether the loop engine succeeded, whether changes were committed and the worktree is clean, whether the checked-out PR ref is still the verified ref, and whether the resulting commit was pushed. The aggregate then maps zero `succeeded` units to `implementation_failed`. This makes the durable card contradict a successful run log and also drives destructive cleanup of the only worktree that may still contain recoverable changes.

The delivery ledger is shared by the dashboard and agent chat, but it stores only a coarse decision and PR state. It cannot explain no-op, partial, commit/ref, or retryable push outcomes after refresh. A continuation also inserts a second active row without terminalizing the first, so an older card can become active again. Decision actions perform Git/GitHub effects before their compare-and-set, allowing two surfaces to both mutate external state even though only one later wins SQLite. Startup recovery handles only the all-failed subset of `building` rows and force-removes worktrees before it knows whether a successful run left recoverable work.

The application is a local desktop product, but its state must remain truthful across two surfaces, multiple windows, process crashes, missing WebSocket events, Git hooks, GitHub CLI degradation, and users modifying refs concurrently.

## Goals / Non-Goals

**Goals:**

- Make the engine outcome immutable truth and model delivery readiness independently.
- Preserve every successful or potentially recoverable result until it is durably committed or explicitly discarded.
- Give repeated work on an existing PR a single lineage with exactly one active generation.
- Represent changed, partial, no-change, retryable delivery failure, blocked delivery, closed PR, and terminal outcomes with accurate actions.
- Make Git/GitHub decisions single-winner and draft-PR creation/recovery idempotent.
- Recover every stale `building` shape to an actionable state after restart.
- Keep dashboard and agent cards converged through durable snapshots, direct action responses, refresh, and focus/reconnect hydration.

**Non-Goals:**

- Automatically resolve a branch-ref mismatch or bypass Git safety checks.
- Force-push, rewrite an existing PR, merge a GitHub PR, or silently drop a dirty worktree.
- Add a user-configurable alternative to isolated Safe PR delivery.
- Infer that an implementation failed merely because it produced no diff.

## Decisions

### 1. Keep decision state, execution outcome, and delivery outcome orthogonal

The ledger gains additive, durable fields:

- `implementation_outcome`: `running | succeeded | partially_succeeded | failed | unknown`.
- `delivery_outcome`: `pending | ready | delivered | partial | no_changes | retryable_failure | blocked | not_started | unknown`.
- `status_code`: a stable, localized-by-the-client reason such as `ready_for_review`, `partial_success`, `existing_pr_updated`, `no_changes`, `commit_failed`, `branch_verification_failed`, `push_failed`, or `settlement_interrupted`.
- `status_detail`: a bounded single-line diagnostic for logs/disclosure, never the primary UI copy.
- `delivery_sha`: the exact verified object used by an existing-PR push/retry.
- `is_continuation` and `supersedes_delivery_id`: ownership and lineage.
- `operation`, `operation_token`, and `operation_started_at_ms`: a lease for decision-side external effects.
- `cleanup_warnings`: bounded JSON warnings from best-effort cleanup.

Per-unit branch records retain the legacy `succeeded` field for compatibility and add run id, implementation/delivery outcomes, initial/final SHA, whether the iteration changed the branch, and an optional failure code. These records let both cards say “1 of 2 completed” instead of counting every requested ticket as delivered.

They also persist branch ownership (`created | preexisting | borrowed-pr`). Cleanup consumes only recorded ownership: it never recomputes a preferred batch name, and it never deletes a pre-existing unit ref. A multi-unit `row.branch` distinct from every unit is the delivery-owned assembled head.

Alternative considered: add a large number of top-level decision states. Rejected because a PR can simultaneously be open, an implementation can be partial, and a push can be retryable; one enum cannot express those facts without another combinatorial state explosion. Three narrow decision additions remain useful: `no_changes` is an explicit user-acknowledgeable state, terminal `completed` records acceptance of a fresh no-change result without lying about a merge/discard, and terminal `superseded` prevents an older generation from resurfacing.

Legacy rows map to conservative `unknown` values and derive display fallbacks from their existing decision. No existing endpoint or field is removed.

### 2. Settlement returns a structured result and never rewrites engine truth

Each isolated unit records:

1. the loop result;
2. commit/cleanliness result;
3. verified final SHA/ref result;
4. delivery eligibility and failure stage.

`onLoopRunFinished` receives only the actual loop outcome. Commit, status, ref, provenance, ticket-effect, or push failures cannot turn an engine success into a failed run. Every promise resolves to a unit result; a last-resort rejection is retained as an explicit blocked unit rather than being dropped from `Promise.allSettled`.

A clean run with no new branch delta is `no_changes`, not a failed run and not “ready to create a PR”. A pre-existing/resumed branch that already contains deliverable commits remains reviewable even if the current iteration added no commit. A mixed batch persists both the successful and failed unit sets and labels the partial result before offering a partial PR.

Automatic cleanup removes only clean, durably referenced worktrees. Dirty, unknown, or ref-mismatched worktrees move to `needs-review` and remain mounted until an explicit destructive action. Retryable push failures release the clean worktree while retaining its branch and exact SHA.

### 3. Existing-PR continuation is an owned generation, not a second root

Admission is rechecked inside the per-repository lock. Creating generation B and moving generation A to `superseded` is one SQLite transaction, protected by a partial unique index that allows only one non-terminal delivery per rail. Concurrent launches therefore produce one accepted run and one conflict, never two writers sharing the ticket-keyed worktree.

If allocation of B fails, B becomes terminal and A is restored atomically. Client terminal events remove a card only when the event's delivery id matches the currently displayed generation, so a late event from A cannot erase B.

Continuation ownership also changes destructive semantics. “Dismiss” clears a follow-up card and its Specrails-owned worktree without closing the pre-existing PR, deleting its head branch, or returning its tickets to the backlog. Only an explicitly described “Discard local result” may remove a blocked follow-up's uncommitted iteration; it still preserves the external PR and branch. Fresh deliveries retain the existing discard semantics.

Legacy false-failure repair cannot always reconstruct the historical `is_continuation` bit. A blocked/recovered delivery that still carries a PR URL is therefore treated as external review state regardless of that bit: “Discard local result” may remove the explicitly confirmed local worktree, but it never closes the PR, deletes its head, or moves its review tickets. The visible consequence and server cleanup rule remain identical for migrated and newly-created cards.

Startup also revisits those migrated `pr_failed + settlement_interrupted` rows. When the recorded successful run and its own worktree/branch ledger prove one clean exact commit, recovery freezes that SHA into `delivery_sha` and promotes the card from blocked to retryable. Legacy settlement commonly marked its removed worktree `failed`, so both `released` and `failed` terminal ledger rows may authorize lookup of their exact recorded branch; if the worktree path still exists it must additionally pass clean HEAD/ref inspection. `needs-review`, dirty, missing and mismatched worktrees never authorize retry. Retry push then uses the existing PR URL/head and that immutable object. If evidence is missing, ambiguous, or spans different SHAs, the card remains blocked, preserves the local result, and explains why exact recovery was refused; recovery never substitutes another ticket branch.

### 4. Decision actions claim before effects and return authoritative state

Before running `git`, `gh`, ticket, or cleanup effects, an action atomically claims the row with a unique token. Another surface receives a conflict before it can perform an effect. A bounded stale lease is reclaimable after process death. Every exit releases its own token; successful transitions preserve the claim until the new durable snapshot is written.

The final transition also checks the operation token. A worker whose stale lease was reclaimed cannot overwrite the new owner after returning late. All mutations of the user's primary checkout, including review-branch checkout and local integration, share the repository lock.

Terminal ticket-file mutations use a SQLite outbox inserted atomically with the terminal decision. Applying `todo`/`done` is idempotent (only tickets still parked at `on_review` move); startup replays pending rows before process admission opens. This closes the crash window between the durable card transition and the external ticket JSON write.

Each outbox row snapshots the current non-null ticket outcome owner in the same transaction as the terminal decision. The JSON phase freezes only tickets whose owner still matches that snapshot; an older terminal generation therefore cannot mutate or enqueue Jira work for a newer iteration. JSON mutation, Jira handoff, and completion are separate durable phases. Startup retries unfinished phases in-process with bounded backoff and keeps project admission closed until they settle; the terminal card carries a localized cleanup warning while retry is pending.

A captured process-admission generation is revalidated after waiting for the repository lock, immediately before any action or checkout effect. Git/GitHub commands that may hold that lock have a bounded timeout, so a wedged credential helper cannot block every later operation indefinitely.

Every decision response includes the current authoritative snapshot. The dashboard applies that snapshot immediately; the agent card keeps it as a local authoritative override until the persisted message/broadcast arrives. A focus/reconnect hydration remains a second convergence path.

For local integration, all source branches are assembled in an isolated temporary worktree first. The user's clean integration checkout is advanced only after the complete assembly succeeds and its original HEAD is revalidated. A conflict therefore leaves the user's branch byte-identical.

### 5. PR creation and lifecycle observation are idempotent

After a successful push, draft creation attempts to parse the URL. If `gh pr create` exits without a URL, reports that a PR already exists, or a prior process could have died after creation, the publisher looks up the open PR by exact head/base and adopts its URL/state. A retry cannot create a duplicate or remain indefinitely URL-less when GitHub already has the PR.

Polling distinguishes `MERGED`, `OPEN`, and `CLOSED`. A closed-unmerged PR becomes `pr_closed`, with actions to reopen it or dismiss/discard according to continuation ownership. It is never reported as merely “not merged yet”.

An internal delivery row is only a continuation candidate after GitHub confirms
that its exact PR is still `OPEN` with the recorded head/base. Settlement checks
that lifecycle again immediately before and after pushing the verified
`delivery_sha`. If the PR closes or merges before it includes that object, the
new generation detaches from the stale PR, retains the exact SHA/branch, and
returns to `on_review` so the engineer can create a new draft PR. A transient
lifecycle-observation failure remains retryable and never guesses that the PR
is open.

`MERGED` alone is insufficient completion evidence for a continuation. Polling
may terminalize the delivery only when GitHub's observed PR commit/merge data
contains the exact `delivery_sha`. This distinguishes a merge that included the
follow-up from a merge racing just before the follow-up push. The latter keeps
the implementation deliverable through a new PR instead of falsely moving its
tickets to Done.

Existing-PR push retries use the persisted verified `delivery_sha`, not a mutable branch name.

Fresh-unit delivery likewise consumes each unit's persisted `finalSha`: a single-unit push uses an object-id refspec and batch assembly merges object ids. Legacy rows may capture the current recorded ref once, but never scan unrelated historical worktrees by ticket. A degraded multi-unit retry reuses its already-owned assembled batch head instead of deleting/recreating merge commits, preserving exact head/base PR identity.

### 6. Startup recovery preserves before it cleans

Project process admission remains closed while worktree and delivery recovery run under the repository lock. Recovery consults run rows, terminal intents, delivery lineage, and worktree ledger generations before removal.

Operation tokens are process capabilities, not durable cross-process ownership. Startup clears every prior-process token before projecting cards; a non-terminal delivery becomes `operation_interrupted` with its implementation, SHA, branch and PR evidence preserved. Pending terminal ticket effects are then retried until settled before admission opens.

Recovery is startup-owned, not hydration-owned. `GET /rails` is a read-only snapshot and never calls the stale-building reconciler: a durable loop outcome appears before the live commit/ref/push settlement finishes, so treating that normal window as a crash would steal the generation's `building` CAS and manufacture a false interrupted card.

- Completed successful runs remain successful even when their deferred callback had not yet been finalized.
- A stale `building` row with committed, clean, reconstructable branches becomes `on_review` or a retryable continuation state.
- A successful run with dirty/unknown work becomes `pr_failed + blocked + settlement_interrupted`, with the worktree preserved.
- All-failed runs become `implementation_failed`.
- Empty run-id and mixed-result stale rows become explicit actionable failures instead of remaining `building` forever.
- Older duplicate active rows are migrated/superseded before the unique index is installed.

This is safe recovery rather than automatic delivery: when the exact deliverable SHA cannot be proven, the system stops and explains rather than pushing.

### 7. The two cards derive the same premium presentation

Both surfaces render from the same durable axes and use the same semantic rules:

- changed/new: ready, evidence counts, Create draft PR;
- changed/existing: PR updated, exact PR link, next PR lifecycle action;
- no change: neutral-success “No changes were needed”, logs, explicit Mark done/Refine paths for fresh work, ownership-safe Dismiss for an existing-PR continuation, never Create PR;
- partial: warning with completed/failed counts and an explicit partial-delivery action;
- retryable push: “Implementation complete; changes are safe locally”, Retry push;
- blocked commit/ref: “Implementation complete; delivery needs attention”, exact stage, logs, no unsafe retry;
- implementation failure: failure copy only when the loop actually failed;
- closed PR: explicit closed-without-merge state;
- cleanup warnings: terminal card/toast says cleanup was incomplete instead of promising deletion.

Run-log access remains available in every non-building dashboard state. Local integration and destructive cleanup require consequence-specific confirmation in both surfaces. New failures use `aria-live` and remain pinned/actionable; completed and superseded cards are terminal and unpinned.

`acknowledge-no-changes` is legal only for a fresh `no_changes` generation. It claims the same decision-operation lease as every other action, terminalizes the row as `completed`, moves only tickets still parked in review to Done, and never invokes PR creation/merge. Refine continues to use the destructive discard path, but its UI label and confirmation explicitly say that tickets return to the backlog. Existing-PR no-change generations borrow review ownership and therefore retain only the ownership-safe Dismiss path.

## Risks / Trade-offs

- **[Migration meets pre-existing duplicate active rows]** → deterministically keep the newest row per rail and mark older rows `superseded` before creating the unique index.
- **[A retry pushes stale or substituted code]** → persist and use the exact verified SHA; refuse retry when it is absent for a newly classified failure.
- **[Dirty recovery consumes disk]** → preserve data over cleanup, surface the recovery state, and remove only after explicit confirmation.
- **[Legacy clients ignore new fields]** → retain existing decisions and fields; additive payloads degrade to their prior coarse presentation.
- **[Operation lease expires during a very slow CLI call]** → use a conservative lease and repository serialization; token ownership is checked again before transition.
- **[A Git credential/network child wedges while holding the repository lock]** → terminate decision-side Git/GitHub commands after a generous fixed timeout and release the lease/lock normally.
- **[An old terminal outbox row replays after a ticket was relaunched]** → require the exact captured non-null ticket owner before JSON or Jira effects; a mismatch completes as a causal no-op.
- **[GitHub lookup is unavailable]** → remain in a retryable pushed/local-only state with the original bounded diagnostic.
- **[Partial delivery surprises users]** → never present it as full success; show included/excluded units before the explicit action.

## Migration Plan

1. Add and backfill ledger columns; terminalize duplicate older rows; then install the active-per-rail partial unique index.
2. Ship server readers that normalize legacy values before emitting additive snapshots.
3. Ship structured settlement/recovery and action claims.
4. Ship client support for the additive fields and new decisions/actions.
5. Update internal lifecycle documentation and validate all translations.

Rollback may ignore the additive columns, but must not drop them; older binaries continue reading the retained legacy decision/pr-state fields. The partial unique index is compatible with the historical intended invariant.

## Open Questions

None. Unsafe or ambiguous recovery fails closed and preserves local work for an explicit user decision.
