## Context

Delivery decisions flow through `executePrDecision`, which claims an operation
lease (`operation_started_at_ms`) before any Git/GitHub effect and finishes with a
compare-and-set UPDATE (`transitionDecision` / `transitionClaimedDecision`, the
latter also used by the ticket-effect transaction owner). Startup recovery and
settlement also transition rows outside the adapters.

## Goals / Non-Goals

**Goals:** exact, idempotent instants; null-safe statistics; no new transaction
owners; no change to existing contracts.

**Non-Goals:** backfilling history; app-wide (cross-project) aggregation;
GitHub-reported merge timestamps (we record when Desktop observed the merge).

## Decisions

1. **First write wins in SQL.** Each stamp is written as
   `column = COALESCE(column, ?)` inside the same CAS UPDATE that performs the
   transition. A double decision loses the CAS (no write); a replayed or
   reconciled transition cannot move an instant. No read-modify-write.
2. **Facts proved by a transition are derived centrally** (pure
   `lifecycleStamps(expected, next, patch, now)`): entering `on_review` →
   `on_review_at`; entering `pr_ready` → `published_at`; entering `merged` →
   `merged_at`. This also covers settlement, restart reconciliation, chains and
   grouped parents without touching every call site.
3. **A human decision is never inferred.** Startup recovery can leave
   `on_review`, so only the decision adapters pass `decidedAt`. The instant is
   the lease claim (click admission), so slow Git/GitHub effects do not inflate
   the measurement. A failed Create PR is still a decision. Adapters also pass
   explicit `publishedAt`/`mergedAt` where they observe them.
4. **Groups** take the earliest repository `decided_at` on the parent;
   aggregation excludes repository children so a group counts once.
5. **Statistics**: interpolated quantile (R type 7), rounded to ms. A row
   participates when it was reviewable (stamp present or a post-review state).
   `pending` = still awaiting the milestone with a known start; `unknown` = the
   milestone happened (or cannot be dated) without a measurable interval,
   including negative intervals. Discarded/completed rows never count toward
   merge. Statistics are `null`, never `0`, when nothing is measurable.
6. **Window** = `on_review_at` (or `created_at` for legacy rows) within the
   spending period resolution (`resolveRange`, now exported).

## Risks / Trade-offs

- Pre-migration deliveries report as unknown until they age out — honest by design.
- `merged_at` for GitHub merges is the observation instant (poll/publish), which
  can lag the actual merge; documented.
- Parallel branches appending migrations: ours is self-contained and idempotent.
