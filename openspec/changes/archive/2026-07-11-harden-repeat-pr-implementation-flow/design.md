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
- `safety_archives`: deduplicated persistent quarantine-batch roots, disclosed separately from failures so preserving recoverable bytes never falsely labels cleanup incomplete. Pointers are never evicted while their bytes remain on disk.

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

Automatic cleanup removes only clean, durably referenced worktrees. Dirty, unknown, or ref-mismatched worktrees move to `needs-review` and remain mounted for explicit manual recovery; workflow Discard/Dismiss terminalizes honestly but never force-deletes changed bytes. Retryable push failures release the clean worktree while retaining its branch and exact SHA.

### 3. Existing-PR continuation is an owned generation, not a second root

Admission is rechecked inside the per-repository lock. Creating generation B and moving generation A to `superseded` is one SQLite transaction, protected by a partial unique index that allows only one non-terminal delivery per rail. Concurrent launches therefore produce one accepted run and one conflict, never two writers sharing the ticket-keyed worktree.

If allocation of B fails, B becomes terminal and A is restored atomically. That transaction records `restored_from_delivery_id=B` on A. This is the sole permitted terminal-tombstone override: a consumer may restore A only when B explicitly superseded A (when that lineage is locally available) and A's snapshot names that exact failed B. Ordinary delayed A snapshots remain rejected. The durable marker remains available for clients that reconnect after the rollback, while each consumer accepts a given A←B pair only once; superseding A again clears the old marker. Client terminal events remove a card only when the event's delivery id matches the currently displayed generation, so a late unrelated event from A cannot erase B.

Snapshot convergence follows that same lineage rather than arrival order. Every server snapshot carries `createdAt` and `updatedAt`; every write to one delivery advances `updatedAt` through a strictly monotonic millisecond UTC logical clock even when claim, transition, and release occur inside one wall-clock second. Clients replace a different delivery id only when it explicitly supersedes the current id, has a strictly later valid creation time, or satisfies the exact durable rollback proof above, and advance the same id only with newer update evidence under a deterministic fail-closed tie policy. Terminal and superseded ids become tombstones, so their non-terminal replays cannot produce an ABA resurrection outside that narrowly paired rollback. Dashboard hydration captures an accepted-mutation version per rail and merges its delayed GET around any live replacement or deletion; ignored old-generation events do not advance that version and therefore cannot erase an unrelated valid seed. Agent-card ingestion applies the same terminal/superseded rejection before dedupe or rendering. Confirmation state is keyed to the exact delivery id/decision that opened it and is invalidated on replacement, so a stale A dialog cannot submit an action against B; rejected stale responses never emit a success toast.

Continuation ownership also changes destructive semantics. “Dismiss” clears a follow-up card and its Specrails-owned worktree without closing the pre-existing PR, deleting its head branch, or returning its tickets to the backlog. Only an explicitly described “Discard local result” may remove a blocked follow-up's uncommitted iteration; it still preserves the external PR and branch. Fresh deliveries retain the existing discard semantics.

Dismissing the visible generation does not erase its continuation authority. For a later local-only relaunch with no active delivery, discovery consults the newest terminal generation touching any requested ticket. It may reuse history only when that single newest row is an explicitly discarded continuation for the exact complete ticket set and still carries one PR URL/number, head, base, and immutable SHA. A newer subset, superset, fresh, malformed, merged, completed, or superseded row shadows all older history. The recorded PR is then re-observed directly and must be exact `OPEN` with `headRefOid = delivery_sha`; every available local/remote ref must equal that SHA, and any retained/unsettled worktree blocks reuse. Once such durable history owns the target, failed validation is authoritative negative evidence and external PR/Jira inference is forbidden. The newly allocated continuation immediately persists that frozen baseline SHA and its terminal predecessor in `supersedes_delivery_id`, so an allocation crash can repeat the same proof and same-timestamp clients can still elect the new generation deterministically.

PR/ticket ownership and branch ownership are deliberately separate. `is_continuation=true` means the generation borrows the existing PR and review tickets, so its presentation and discard/dismiss semantics preserve both; startup repairs that bit on legacy recoveries before actions are exposed. Per-unit `branchOwnership=borrowed-pr | preexisting` independently prevents local or GitHub branch deletion. Therefore a fresh replacement PR may be closed and its tickets refined while its borrowed/pre-existing head is still preserved. Generic failure codes never infer either kind of ownership.

Startup also revisits those migrated `pr_failed + settlement_interrupted` rows. When the recorded successful run and its own worktree/branch ledger prove one clean exact commit, recovery freezes that SHA into `delivery_sha` and promotes the card from blocked to retryable. Legacy settlement commonly marked its removed worktree `failed`, so both `released` and `failed` terminal ledger rows may authorize lookup of their exact recorded branch; if the worktree path still exists it must additionally pass clean HEAD/ref inspection. `needs-review`, dirty, missing and mismatched worktrees never authorize retry. Retry push then uses the existing PR URL/head and that immutable object. If evidence is missing, ambiguous, or spans different SHAs, the card remains blocked, preserves the local result, and explains why exact recovery was refused; recovery never substitutes another ticket branch.

Legacy recovery must also prove that a proposed retry represents causally owned progress. Specrails settlement commit subjects contain the durable run id, so every refs/reflogs or recorded-branch candidate must carry that exact marker in its **commit subject**; association through a branch name, worktree, reflog entry, or commit body is insufficient. Recovery accepts only one uniquely subject-marked commit. Before promotion it observes the recorded PR. A causally proven run commit already exposed as the open PR head is classified as already delivered, not offered as a no-op retry. A branch tip without that subject marker or ambiguous run commits remain blocked with an explicit diagnostic. Once a unique causal commit is frozen, a transient GitHub observation failure instead remains retryable: it preserves the exact SHA/PR/branch and Retry push revalidates before mutation. Startup applies the same audit to legacy-recovered rows that already reached draft/ready, replacing a previously frozen wrong SHA with the uniquely proven run commit or downgrading safely when no such proof exists. Every such existing-PR recovery also repairs `is_continuation=true`; that borrowed-ownership invariant survives retry/delivery. This deliberately prefers preserving branch/object evidence over manufacturing delivery success from an old PR head.

Refs and reflogs are not the final read-only recovery surface: old cleanup may have detached the settlement commit while its object still survives before Git garbage collection. Startup therefore also inspects only `unreachable commit <sha>` records from `git fsck --unreachable --no-reflogs --no-progress`, applies the same exact run marker check to each subject, and accepts the result only when every successful run still resolves to one common unique commit. Malformed output, command failure, zero candidates, or multiple marked objects remains blocked; unreachable-object discovery never authorizes an unmarked branch tip.

A separate explicitly confirmed `recover-and-retry` decision handles a preserved result that cannot be promoted automatically. It is legal only for an active successful/partially-successful blocked continuation with exactly one run and one or more exact matching per-unit branch records. Under the ordinary decision lease and repository lock it re-observes an exact same-repository `OPEN` PR, freezes its live head as the baseline, and uses only this delivery's recorded branch/worktree. A worktree path must be absolute, non-symlink, distinct from the main checkout, and uniquely registered by this repository with the expected branch/HEAD; that proof is repeated immediately before staging. Before declaring the branch/worktree empty, the action reuses startup's bounded, fail-closed refs + reflogs + unreachable-object scan. The combined candidate set is capped, every candidate subject must be readable, and exactly one commit carrying `(run <id>)` is required; enumeration or subject-read failure cannot manufacture uniqueness. If that isolated worktree contains deliverable changes on an owned baseline, Specrails stages them with the same never-commit exclusions, audits and safely unstages any prohibited pre-staged paths, and commits with an explicit allow/exclude pathspec and hooks disabled so neither a concurrent index writer nor a hook can add private files after the audit. An already-committed candidate is adoptable only when it equals every consistent durable unit `finalSha` or the unique run-marked commit; a later arbitrary branch tip is preserved but never bundled or pushed. Every matching unit for the run/branch is updated together.

Once a candidate is proven, Specrails first pins it under a delivery-specific internal recovery ref, then persists the immutable SHA before any network mutation. That ref prevents Git GC or a branch race from deleting the only surviving orphan across a crash; it is removed only after exact remote delivery is proven or the user explicitly discards the local result. The candidate must be a fast-forward descendant of the observed PR head; push remains exact-SHA and non-force, followed by exact re-observation. Before that push, the configured `origin` push URL must identify the same GitHub repository as the attached PR; fork/cross-repository heads and ambiguous or mismatched remotes fail closed. If the unique run-owned commit already equals the PR head, delivery is already verified without a push. A no-change result is declared only when every matching unit durably agrees on `changed=false` and `initialSha=finalSha=live PR head`; baseline equality without that proof remains unresolved rather than erasing the expected implementation.

Discovery and pinning also run when a ledger path still exists but is dirty, recreated, or unsafe. If that worktree and the protected commit represent different results, recovery preserves both and refuses to choose or bundle them automatically. A crash after pinning but before `delivery_sha` persistence remains recoverable after restart; explicit discard may remove such a ref only after re-proving its exact run/final ownership, while substituted refs are retained with a cleanup warning. Successful successor delivery releases matching ancestor recovery refs from its discarded/superseded lineage, and startup retries exact ref cleanup after a crash between durable settlement and ref deletion.

The delivery-specific protection ref is stronger evidence than a later global marker scan for that same delivery. If recovery committed descendant B and atomically advanced the ref from A to B before crashing, startup uses protected B rather than treating marker-bearing ancestor A plus B as an unrelated ambiguity. A distinct authenticated worktree HEAD still blocks selection and preserves both results.

An attempted recovery that still cannot prove one deliverable local result persists `recovery_unavailable`, leaves every ref/worktree/object intact, and explains that Git object/worktree evidence is device-local. Both cards then replace the primary Commit action with a localized secondary Recheck action; Recheck remains legal so startup or a later original-machine restore can succeed, but the UI no longer loops on an impossible promise. Startup includes this state in causal reconciliation, restores the ordinary Commit action when an authenticated worktree becomes dirty, and promotes a newly found exact commit automatically. The user's main checkout and its uncommitted files are never touched.

### 4. Decision actions claim before effects and return authoritative state

Before running `git`, `gh`, ticket, or cleanup effects, an action atomically claims the row with a unique token. Another surface receives a conflict before it can perform an effect. A bounded stale lease is reclaimable after process death. Every exit releases its own token; successful transitions preserve the claim until the new durable snapshot is written.

The final transition also checks the operation token. A worker whose stale lease was reclaimed cannot overwrite the new owner after returning late. All mutations of the user's primary checkout, including review-branch checkout and local integration, share the repository lock.

Terminal ticket-file mutations use a SQLite outbox inserted atomically with the terminal decision. Applying `todo`/`done` is idempotent (only tickets still parked at `on_review` move); startup replays pending rows before process admission opens. This closes the crash window between the durable card transition and the external ticket JSON write.

Each outbox row snapshots the current non-null ticket outcome owner in the same transaction as the terminal decision. The JSON phase freezes only tickets whose owner still matches that snapshot; an older terminal generation therefore cannot mutate or enqueue Jira work for a newer iteration. JSON mutation, Jira handoff, and completion are separate durable phases. Startup retries unfinished phases in-process with bounded backoff and keeps project admission closed until they settle; the terminal card carries a localized cleanup warning while retry is pending.

A captured process-admission generation is revalidated after waiting for the repository lock, immediately before any action or checkout effect. Git/GitHub commands that may hold that lock have a bounded timeout, so a wedged credential helper cannot block every later operation indefinitely.

Every decision response includes the current authoritative snapshot. The dashboard applies that snapshot immediately; the agent card keeps it as a local authoritative override until the persisted message/broadcast arrives. A focus/reconnect hydration remains a second convergence path.

Ordinary Checkout is also immutable-SHA based. After the generation and main-checkout cleanliness guards, an existing local branch or newly fetched remote-tracking branch must equal `delivery_sha` before it is switched into the user's checkout, and branch plus `HEAD` are revalidated afterward. Checkout never hides a failed fast-forward pull or resets a divergent user branch to manufacture success.

For local integration, all source branches are assembled in an isolated temporary worktree first. The user's clean integration checkout is advanced only after the complete assembly succeeds and its original HEAD is revalidated. A conflict therefore leaves the user's branch byte-identical.

### 5. PR creation and lifecycle observation are idempotent

After a successful push, draft creation attempts to parse the URL. If `gh pr create` exits without a URL, reports that a PR already exists, or a prior process could have died after creation, the publisher looks up the open PR by exact head/base and adopts its URL/state. A retry cannot create a duplicate or remain indefinitely URL-less when GitHub already has the PR.

One causal PR-observation rule is shared by continuation admission, Retry push, post-push verification, poll/Verify PR, and Reopen. Every path validates the recorded PR identity, exact head/base, same-repository ownership, lifecycle (`OPEN | CLOSED | MERGED`), and inclusion of the immutable `delivery_sha`; a transient lookup failure never guesses. Cross-repository/fork PR heads are not supported by Safe PR delivery because its exact push target is the local `origin`; an absent `isCrossRepository=false` proof fails closed. Immediately before every existing-PR push—including the automatic post-run continuation settlement as well as later Retry/Recovery actions—the configured `origin` must resolve to exactly one push URL identifying the repository that owns the recorded PR. A missing, multiple, ambiguous, fork, or mismatched target performs no push; the push uses that already-verified raw URL rather than resolving the mutable `origin` alias again. Credential-bearing userinfo, passwords, query strings, and fragments are rejected so secrets never enter child-process arguments or durable diagnostics; authentication remains delegated to Git/`gh` credential helpers (with only the conventional non-secret `git` SSH username allowed). Every admission requires both the allocated worktree HEAD and local branch ref to equal the frozen remote baseline, preventing unreviewed local commits from being silently absorbed into a new run. For an inferred external PR, `gh pr list` is discovery only: an authoritative exact-PR view must prove `OPEN` head/base and provide a valid `headRefOid`, which becomes that run's immutable allocation baseline. External PR inference is authorized only by an explicit PR number in the spec/ticket or an authoritative Jira key; repository-local ids, title similarity, branch wording, and unrelated `Fixes #<id>` text are not proof. Post-run verification permits the run to advance that baseline to a new commit only while worktree HEAD and the local branch ref remain identical; pre-push verification then freezes and pushes that exact final SHA. Admission is read-only and accepts only exact `OPEN` evidence; when it sees another state it refuses the launch and directs the user to the existing card's Verify/Retry recovery rather than superseding or mutating that delivery. `OPEN` with exact identity but a missing remote SHA remains attached and retryable. Exact `CLOSED` containing the SHA becomes `pr_closed` and may be reopened only after the same evidence is revalidated before and after `gh pr reopen`.

An exact `MERGED` observation containing `delivery_sha` terminalizes immediately in whichever decision action observes it—Retry push, Reopen, or poll—so completion never waits for a second decision. Initial asynchronous settlement does not bypass the terminal ticket-effect outbox: exact post-push `CLOSED` becomes `pr_closed`, while exact post-push `MERGED` remains attached in a ready-to-Verify state and the explicit Verify action commits the terminal decision plus ticket intent atomically. Conversely, when a decision action definitively proves a stale/retargeted identity, or `CLOSED`/`MERGED` evidence that does not contain the SHA, the row clears stale PR identity, returns to `on_review`, and preserves `delivery_sha` plus its local branch so the engineer can create a new draft PR. Admission performs no such mutation: it refuses the launch and leaves that reconciliation to the visible card. This distinguishes a merge that included the follow-up from one racing before the follow-up push, without losing the still-deliverable implementation.

Existing-PR push retries use the persisted verified `delivery_sha`, not a mutable branch name.

Every later PR check revalidates that same evidence even while the PR remains open. An open PR is considered delivery-verified only when its head/base identity still matches and its `headRefOid` equals `delivery_sha`. A matching open PR returns explicit verified-SHA evidence; an exact head/base whose remote head no longer exposes the commit becomes retryable again, while a changed head/base detaches and an absent immutable SHA fails closed. “Not merged yet” is never allowed to hide a missing delivery commit.

Fresh-unit delivery likewise consumes each unit's persisted `finalSha`: a single-unit push uses an object-id refspec and batch assembly merges object ids. Legacy rows may capture the current recorded ref once, but never scan unrelated historical worktrees by ticket. A degraded multi-unit retry reuses its already-owned assembled batch head instead of deleting/recreating merge commits, preserving exact head/base PR identity.

### 6. Startup recovery preserves before it cleans

Project process admission remains closed while worktree and delivery recovery run under the repository lock. Recovery consults run rows, terminal intents, delivery lineage, and worktree ledger generations before removal.

Every automatic release performs a final live preflight immediately before non-force worktree removal: tracked/untracked/ignored status, worktree HEAD, and its local branch ref must still match the durably recorded settled SHA. Settlement persists fingerprinted trusted overlay evidence; cleanup revalidates it live, uses literal pathspecs, never trusts a manifest inside the writable worktree, and treats every other ignored path as user data. Cleanup never performs check-then-unlink on a mutable worktree pathname. Instead, each authenticated overlay root is atomically renamed on the same filesystem beneath one unique persistent sibling quarantine root per worktree release and re-fingerprinted there. That batch root is recorded before the first move, so one durable pointer covers every child even across a crash and no pointer is evicted while the directory remains on disk. A raced replacement remains there with a warning; automatic cleanup never moves it back over a possibly recreated original and never deletes the quarantine. Even a writer holding an open descriptor after the rename therefore cannot lose data. Safety archive roots are deduplicated and projected to both cards as a collapsed inspectable recovery section without setting `cleanup_incomplete`. The final plain status check plus non-force Git removal catches any entry concurrently recreated at the original path. Allocation-time overlay paths remain conservative never-commit exclusions, so a modified overlay copy is preserved rather than staged into the PR or deleted. A failed or transient preflight remains retryable—`needs-review` is revalidated on the next action instead of becoming a permanent skip. Post-merge/discard local branch deletion independently rereads the ref and preserves it when it advanced beyond the frozen SHA. Discard closes its PR without an unleased remote-head deletion; borrowed/pre-existing heads are never locally forced away.

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

An unproven blocked result never offers Checkout: that control changes the user's main project folder to the recorded PR branch and cannot recover the isolated implementation. Only a path currently authenticated against the repository's live Git worktree registry is exposed through Inspect local result; a stale, symlinked, reused, or other-device path is removed from projection. A continuation with no authenticated local path uses ownership-safe Dismiss instead of claiming that Discard local result will delete bytes on this computer; explicit discard remains available only with projected local recovery evidence. Ordinary Checkout remains available only with immutable delivered-commit evidence. It re-reads the same generation's current PR/branch under the repository lock and uses that snapshot, never a pre-lock branch. Dirty or unreadable main-checkout status is a localized protective refusal before worktree release or branch switch and says explicitly that nothing changed.

Run-log access remains available in every non-building dashboard state. Local integration and destructive cleanup require consequence-specific confirmation in both surfaces. New failures use `aria-live` and remain pinned/actionable; completed and superseded cards are terminal and unpinned.

A successful Retry push returns explicit `deliveryVerified`, `verifiedSha`, remote-head, and whether a push actually ran. Both surfaces immediately confirm the verified short SHA and PR instead of silently changing buttons. The lifecycle action is labelled as a PR verification action because it checks both exact-commit presence and merge state.

Agent history has at most one rendered and persisted PR-decision card per `(conversationId, prDeliveryId)`. Server post/update paths consolidate legacy duplicate system rows in one transaction, keeping the newest history anchor and overwriting it from the durable delivery snapshot. Client ingestion and hydration independently collapse duplicates so an older blocked card can never render beside the current retry/PR-ready card, even before server-side healing completes.

`acknowledge-no-changes` is legal only for a fresh `no_changes` generation. It claims the same decision-operation lease as every other action, terminalizes the row as `completed`, moves only tickets still parked in review to Done, and never invokes PR creation/merge. Refine continues to use the destructive discard path, but its UI label and confirmation explicitly say that tickets return to the backlog. Existing-PR no-change generations borrow review ownership and therefore retain only the ownership-safe Dismiss path.

## Risks / Trade-offs

- **[Migration meets pre-existing duplicate active rows]** → deterministically keep the newest row per rail and mark older rows `superseded` before creating the unique index.
- **[A retry pushes stale or substituted code]** → persist and use the exact verified SHA; refuse retry when it is absent for a newly classified failure.
- **[Dirty recovery consumes disk]** → preserve data over cleanup, surface the recovery state, and leave removal to explicit manual recovery.
- **[Successful overlay quarantines accumulate]** → accept persistent framework-copy retention in favor of zero automatic data loss; any future inspection/GC flow must be explicit and must not reintroduce path check-then-delete.
- **[Legacy clients ignore new fields]** → retain existing decisions and fields; additive payloads degrade to their prior coarse presentation.
- **[Operation lease expires during a very slow CLI call]** → use a conservative lease and repository serialization; token ownership is checked again before transition.
- **[A Git credential/network child wedges while holding the repository lock]** → terminate decision-side Git/GitHub commands after a generous fixed timeout and release the lease/lock normally.
- **[An old terminal outbox row replays after a ticket was relaunched]** → require the exact captured non-null ticket owner before JSON or Jira effects; a mismatch completes as a causal no-op.
- **[A delayed snapshot resurrects generation A after B]** → order replacements by explicit lineage or strictly later `createdAt`, retain terminal/superseded tombstones, and merge hydration through an accepted-mutation ABA guard.
- **[A PR is retargeted or terminates without the delivery commit]** → validate identity plus `delivery_sha` on every lifecycle path and detach to `on_review` with the immutable SHA preserved; only exact merged evidence terminalizes.
- **[GitHub lookup is unavailable]** → remain in a retryable pushed/local-only state with the original bounded diagnostic.
- **[Partial delivery surprises users]** → never present it as full success; show included/excluded units before the explicit action.
- **[A legacy branch tip is merely the old PR head]** → compare the candidate with live PR evidence and refuse a no-op recovery promotion.
- **[Historical card rows were duplicated by replay/crash]** → consolidate by delivery id on both persistence and rendering boundaries.

## Migration Plan

1. Add and backfill ledger columns; terminalize duplicate older rows; then install the active-per-rail partial unique index.
2. Ship server readers that normalize legacy values before emitting additive snapshots.
3. Ship structured settlement/recovery and action claims.
4. Ship client support for the additive fields and new decisions/actions.
5. Update internal lifecycle documentation and validate all translations.

Rollback may ignore the additive columns, but must not drop them; older binaries continue reading the retained legacy decision/pr-state fields. The partial unique index is compatible with the historical intended invariant.

## Open Questions

None. Unsafe or ambiguous recovery fails closed and preserves local work for an explicit user decision.
