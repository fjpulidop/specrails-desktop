## 1. Durable delivery model and migration

- [x] 1.1 Add migration 48 with orthogonal outcome, reason, verified-SHA, continuation-lineage, operation-lease, and cleanup-warning columns; supersede duplicate active rows and enforce one active delivery per rail.
- [x] 1.2 Extend server/client delivery, WebSocket, agent-envelope, action, and decision types with normalized backward-compatible values, `no_changes`, `pr_closed`, `superseded`, per-unit outcomes, and authoritative snapshots.
- [x] 1.3 Add store primitives and tests for outcome patches, operation claims/releases, generation supersession/restoration, stale-building recovery, and legacy normalization.

## 2. Isolated implementation settlement and recovery

- [x] 2.1 Refactor per-unit settlement so the actual loop outcome is immutable, every allocated promise produces a structured result, and post-run failures are classified by delivery stage.
- [x] 2.2 Capture initial/final SHAs and changed/no-change evidence; aggregate full, partial, no-change, retryable, and blocked results without silently omitting units.
- [x] 2.3 Preserve dirty/unknown/ref-mismatched worktrees as needs-review; release only clean durable worktrees and persist exact SHAs for safe retry.
- [x] 2.4 Revalidate launch admission inside the repo lock, atomically supersede/restore continuation generations, and reject concurrent stale launches before worktree reuse or spawn.
- [x] 2.5 Make startup recovery/admission serialized, preserve successful interrupted work, recover every stale `building` shape to an actionable state, and keep the deferred loop callback consistent with the durable engine outcome.
- [x] 2.6 Add isolated-launch and restart tests for successful commit/status/ref failures, rejected settlement, no-op, partial batches, exact-SHA push, crash windows, concurrent launch, and non-destructive cleanup.

## 3. Idempotent and race-safe PR decisions

- [x] 3.1 Claim an operation lease before any Git/GitHub/ticket/cleanup effect, return conflicts before effects, reclaim stale leases, and include the authoritative snapshot in every response.
- [x] 3.2 Make existing-PR retry use the persisted verified SHA and make continuation dismiss/discard preserve the borrowed PR, head branch, and review ticket state.
- [x] 3.3 Make draft-PR creation adopt an exact existing head/base PR after no-URL, already-exists, or ambiguous interruption outcomes.
- [x] 3.4 Represent closed-without-merge as `pr_closed` and implement a safe reopen action.
- [x] 3.5 Assemble multi-branch local integration outside the user's checkout and advance the integration branch only after complete conflict-free assembly and HEAD revalidation.
- [x] 3.6 Persist bounded cleanup warnings and report incomplete cleanup honestly.
- [x] 3.7 Add decision/publisher tests for action races, stale leases, exact-SHA retry, idempotent discovery, CLOSED/reopen, atomic local integration, continuation ownership, and cleanup warnings.
- [x] 3.8 Add a lease-guarded `acknowledge-no-changes` action and terminal `completed` state that moves fresh no-change tickets to Done without claiming a merge; retain an explicit backlog-returning Refine path.
- [x] 3.9 Make final CAS token-owned, serialize every primary-checkout mutation, deliver persisted final SHAs, reuse degraded batch identity, and durably replay terminal ticket effects.
- [x] 3.10 Revalidate an existing PR before/after exact-SHA push and require merge evidence to contain that SHA; reroute stale/concurrent merges to a new-PR-ready state with deterministic tests.

## 4. Premium implementation-card UX

- [x] 4.1 Extend the agent API and both card surfaces to render shared outcome semantics for new/existing PR, no-change, partial, retryable push, blocked delivery, actual implementation failure, closed PR, superseded, and cleanup-warning states.
- [x] 4.2 Show per-unit success/failure evidence and persistent run-log access; label local-only, retry-push, and partial-delivery actions truthfully.
- [x] 4.3 Add consequence-specific confirmations for local integration, fresh discard, continuation dismiss, and blocked local-result discard; never offer an unsafe retry.
- [x] 4.4 Apply authoritative HTTP snapshots immediately, ignore stale terminal broadcasts from older generations, and rehydrate on focus/reconnect.
- [x] 4.5 Keep action-required new failures pinned/announced accessibly while terminal superseded cards unpin.
- [x] 4.6 Add/update agent-card, dashboard-strip, context, pinning, run-log, accessibility, and lost-WebSocket regression tests.
- [x] 4.7 Render fresh no-change Mark done/Refine choices and terminal completion copy consistently in both surfaces; keep continuation no-change ownership-safe.

## 5. Localization and documentation

- [x] 5.1 Add outcome/stage/action/confirmation/cleanup copy to every supported locale and fix the untranslated Spanish Resume/Stop execution strings.
- [x] 5.2 Update `docs/internals/safe-pr-review-flow.md` with the orthogonal state model, generation lineage, recovery, ownership, and action matrix.
- [x] 5.3 Update any stale code comments that still describe the old single-boolean or force-cleanup lifecycle.

## 6. Verification

- [x] 6.1 Run focused server and client suites for all modified modules and prove each new regression fails on the pre-fix mechanism.
- [x] 6.2 Run the full server/client test suites, locale parity, TypeScript checks, production build, Cargo check, and strict OpenSpec validation.
- [x] 6.3 Perform an in-app browser walkthrough of first implementation, second iteration, no-op, partial, push failure, closed PR, refresh, and concurrent-action states when a browser target is available; no in-app browser target was connected in this environment, so deterministic state/UI tests cover the matrix instead.

## 7. Legacy delivery truth and card convergence follow-up

- [x] 7.1 Refuse legacy Retry-push promotion when the recovered branch SHA is already the recorded open PR head or live PR evidence is unavailable; preserve the local branch/object with an actionable diagnostic.
- [x] 7.2 Revalidate exact head/base and `delivery_sha` on every open-PR check, restore Retry push when the remote commit is missing, and return explicit verified/pushed SHA evidence on success.
- [x] 7.3 Make agent PR-card post/update idempotent and transactionally consolidate persisted duplicate rows by `(conversationId, prDeliveryId)`.
- [x] 7.4 Dedupe legacy PR-card envelopes during client hydration/rendering and add explicit localized verified-push/verified-PR feedback in both implementation-card surfaces.
- [x] 7.5 Add focused server/client regressions, run the relevant suites plus typecheck/locale parity/build, and validate OpenSpec strictly.

## 8. Final adversarial durability and convergence pass

- [x] 8.1 Require an internal continuation worktree to start at the exact frozen `delivery_sha`, and authorize inferred external-PR continuation only through an explicit PR number or authoritative Jira key.
- [x] 8.2 Reconcile post-push/reopen terminal races and transient legacy GitHub observation without losing the exact recovered commit or claiming a stale PR delivered it.
- [x] 8.3 Revalidate live worktree cleanliness, ignored-file safety, HEAD, and branch ref immediately before non-force release; preserve advanced owned refs and every borrowed/pre-existing PR head.
- [x] 8.4 Make dashboard and agent snapshot ordering monotonic for same-id and different-generation updates, key confirmations to the exact delivery, honor terminal tombstones during hydration, and reject stale-success feedback.
- [x] 8.5 Re-run focused/full server and client suites, all 8 locale parity checks, typecheck, production build, Cargo/core compatibility, diff checks, and strict OpenSpec validation after the final fixes.

## 9. Final rollback, continuation-baseline, and cleanup-race hardening

- [x] 9.1 Persist exact failed-replacement rollback lineage and allow only that restoration to override a predecessor tombstone across dashboard, Agent Chat, hydration, and pinning.
- [x] 9.2 Freeze inferred external PRs to an authoritative live remote head, require that SHA at allocation, allow a verified new post-run SHA, and push only the exact final object.
- [x] 9.3 Replace check-then-delete overlay cleanup with atomic persistent quarantine plus post-rename revalidation, preserving concurrent writes and open-descriptor changes.
- [x] 9.4 Run focused and complete verification after all three adversarial blockers are integrated; validate OpenSpec and the final remote PR SHA.
- [x] 9.5 Persist every successful overlay quarantine batch root as a separately rendered safety archive in both card surfaces and all eight locales, including a persistent terminal dashboard disclosure, without manufacturing cleanup warnings.
- [x] 9.6 Use full fresh-discard actions/copy for blocked non-continuation deliveries with an attached PR; reserve local-result discard for borrowed continuations.
- [x] 9.7 Make implementation-failed, retryable-push, and delivery-blocked presentations mutually exclusive in both renderers, including legacy `settlement_interrupted` recovery.
- [x] 9.8 Route every Discard/Dismiss worktree through the final live lossless preflight and preserve the checked-out branch whenever its worktree is retained.
- [x] 9.9 Recover a dismissed local-only continuation from the newest exact historical PR authority, shadow older overlap safely, persist its baseline before allocation, and cover single/batch/ref/worktree/lifecycle cases.
- [x] 9.10 Persist one safety-archive batch root before child moves and retain every durable archive pointer, including worktrees with more than eight independent overlay roots.
- [x] 9.11 Persist historical predecessor lineage so an immediate same-timestamp relaunch wins Agent-card root election over its discarded predecessor.
- [x] 9.12 Surface cleanup warnings and retained paths when Dismiss intentionally leaves an existing `needs-review` worktree mounted, including a persistent localized dashboard disclosure with a Copy recovery details action.

## 10. Preserved-result recovery and truthful Checkout follow-up

- [x] 10.1 Extend automatic legacy recovery to uniquely run-marked unreachable Git commits without accepting unmarked or ambiguous objects.
- [x] 10.2 Add a lease-guarded Commit & retry push action for one exact delivery-owned worktree/branch, with exact PR baseline, fast-forward, never-commit, immutable-SHA, same-repository/origin ownership, and non-force-push checks; apply the same origin proof to automatic continuation pushes.
- [x] 10.3 Project live recovery worktree paths, replace blocked Checkout with Inspect local result and recovery actions on both surfaces, and keep dirty-checkout feedback localized and lossless.
- [x] 10.4 Add server/client regression coverage, all eight locale keys, documentation, typecheck/build/full-suite verification, strict OpenSpec validation, and final remote PR SHA verification.

## 11. Removed-worktree orphan recovery and truthful recheck

- [x] 11.1 Extract one bounded fail-closed run-marker discovery helper shared by startup and explicit recovery, including refs, reflogs, unreachable objects, malformed output, subject-read failure, ambiguity, and combined candidate caps.
- [x] 11.2 Recover only exact durable/run-owned candidates, update every matching unit, protect orphan SHAs with delivery-specific internal refs across crashes, and never adopt or bundle a later unrelated branch tip.
- [x] 11.3 Classify already-delivered and durably proven no-change baselines, otherwise persist `recovery_unavailable` and keep startup/Recheck able to heal it without modifying the main checkout.
- [x] 11.4 Render localized premium Recheck/other-computer guidance on dashboard and Agent cards in all eight locales, with no repeated impossible Commit/Checkout action and no raw-English primary feedback.
- [ ] 11.5 Add server/client regression coverage, update lifecycle documentation, run focused/full suites, locale parity, typecheck/build/Cargo/core checks, strict OpenSpec validation, and verify the final PR #548 remote SHA/CI.
