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
