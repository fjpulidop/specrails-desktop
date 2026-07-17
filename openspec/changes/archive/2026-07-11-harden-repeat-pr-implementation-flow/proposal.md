## Why

A successful implementation can currently be presented as an implementation failure when commit verification, branch reconciliation, or follow-up delivery fails after the loop has already completed. This is especially confusing on a second iteration of an existing pull request: the log says success while the only card action is to discard, hiding the real recovery path and eroding trust in the workflow.

## What Changes

- Preserve the implementation outcome independently from the post-run delivery outcome for every isolated launch.
- Classify successful runs with no new commit, unsafe/unverified local results, and follow-up push failures truthfully instead of collapsing them into `implementation_failed`.
- Persist a stable outcome/reason contract so refreshes, restarts, dashboard strips, and agent-chat cards render the same explanation and actions.
- Make an existing-PR follow-up retryable whenever delivery can safely be retried, while keeping unsafe branch/ref mismatches fail-closed.
- Give both implementation-card surfaces concise, actionable states with access to the existing PR and run logs, including partial success and no-change outcomes.
- Give fresh no-change results separate Mark done and Refine outcomes, using a truthful terminal completion state rather than overloading merged/discarded.
- Reconcile stranded `building` rows from durable run outcomes without overwriting successful implementations with a false failure.
- Enforce one active delivery generation per rail and supersede the prior generation atomically when an existing PR is iterated again.
- Make snapshot convergence monotonic by lineage/`createdAt`, with terminal/superseded tombstones, one durable rollback lineage exception for a failed replacement, and a hydration ABA guard that cannot resurrect any other older generation.
- Serialize decision-side Git/GitHub effects before they start, make draft-PR creation discover an already-created PR, and represent a PR closed without merge explicitly.
- Validate exact PR identity, head/base, and `delivery_sha` on admission, retry, reopen, and polling; terminalize exact merged evidence immediately and detach stale or missing-SHA terminal PRs without losing the immutable commit.
- Require every continuation worktree to start at the exact live remote PR SHA; infer external PRs only from an explicit PR number or authoritative Jira key, and freeze their head through an authoritative GitHub view before allocation.
- Require the recorded run marker in a legacy candidate's commit subject before freezing it as recovered `delivery_sha`.
- Preserve dirty or unverifiable worktrees for explicit recovery, revalidate tracked/untracked/ignored data plus exact HEAD/ref immediately before non-force release, atomically quarantine authenticated overlay roots instead of deleting mutable paths, durably disclose those safety archives, preserve advanced or borrowed branches, and report cleanup warnings honestly.
- Return the authoritative post-action snapshot so a dropped WebSocket event cannot leave either card stale.
- Key confirmation dialogs and success feedback to the exact generation, and make same-id/different-generation snapshot convergence monotonic across live events and hydration.
- Keep blocked fresh-delivery discard semantics distinct from ownership-safe continuation local-result discard, including when a PR is already attached.
- Preserve a dismissed continuation as strict historical PR authority for the next local-only iteration, while preventing newer overlapping ticket generations, stale refs, dirty retained worktrees, or fuzzy Jira matches from resurrecting an older PR.
- Recover uniquely run-marked commits that survive only as unreachable Git objects, and give an explicitly confirmed blocked continuation a lossless `Commit & retry push` path that operates only on its delivery-owned worktree/branch.
- Replace misleading Checkout controls on unproven blocked results with inspectable local-recovery controls; keep main-checkout dirtiness a localized no-op that never releases the preserved worktree.
- Authenticate recovery paths against Git's live worktree registry, make never-commit pathspecs authoritative at commit time, reject cross-repository PR heads and mismatched `origin` targets, and fail Checkout closed when cleanliness cannot be read.
- Make explicit recovery reuse the same bounded refs/reflogs/unreachable causal scan as startup, protect a recovered orphan with an internal ref before persistence/network work, and distinguish already-delivered, proven no-change, and no-evidence-on-this-computer outcomes without repeatedly offering an impossible Commit action.
- Update the Safe PR lifecycle documentation and add backend/client regression coverage for repeated implementation and recovery corner cases.

## Capabilities

### New Capabilities

- `implementation-delivery-lifecycle`: Truthful, durable classification and premium recovery UX for implementation results and their subsequent PR delivery, including repeated work on an existing PR.

### Modified Capabilities

- `rail-parallel-isolation`: Isolated-run settlement must preserve the actual loop outcome separately from commit/ref/push delivery checks and recover it safely after interruption.

## Impact

- Server: isolated launch settlement, PR-delivery ledger and migration, restart reconciliation, WebSocket/card payloads, and PR retry behavior.
- Client: shared delivery types, dashboard PR strip, agent-chat implementation card, pinning/status presentation, and localized copy.
- Tests/docs: state-machine, persistence/recovery, repeated-PR, accessibility/action, localization, and internal Safe PR workflow documentation.
- No external API endpoint is removed; additive snapshot fields are backward-compatible for existing clients.
