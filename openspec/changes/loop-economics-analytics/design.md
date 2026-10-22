## Context

Inputs already exist per project in `jobs.sqlite`: `rail_pr_deliveries` (decision,
`loop_id`, `loop_name`, `run_ids`, lifecycle instants from migration 72),
`ai_invocations` (cost, `total_cost_usd_estimated`, `loop_run_id`,
`surface_ref_id`) and `events` (`loop_step` payloads with `nodeId`). The
`scripts/metrics-baseline.mjs` export (PR #786) joins the same tables offline.
Tickets live in the YAML/JSON ticket store. Saved loops live in the global
desktop DB.

## Goals / Non-Goals

**Goals:** one per-loop table over a period; honest unknowns; reuse existing
attribution (`sumInvocationCostForRuns` rule) and decision-time statistics;
a human-entered escaped-defect link.

**Non-Goals:** requirements demonstrated and triage accuracy values (their
producers do not exist yet — fields are nullable placeholders); revert-commit
detection; cross-project rollups; new migrations.

## Decisions

1. **Delivered** = a parent delivery (`parent_delivery_id IS NULL`) that reached
   review: `on_review_at`/`merged_at` set, or decision in `on_review`, `pr_draft`,
   `pr_ready`, `pr_closed`, `merged`, `superseded`, or (legacy rows without
   instants) `discarded` with a succeeded/partially-succeeded implementation.
   Repository children count once through their parent. Window =
   `COALESCE(on_review_at, created_at)` like decision times.
2. **Cost** per delivery = attributed invocations (`loop_run_id ∈ run_ids`,
   `surface_ref_id ∈ run_ids`, or `<runId>:merge:%`). Priced rows split into
   authoritative (`estimated = 0`) and estimated (`estimated = 1`). A delivery
   with no priced row is *unpriced* and excluded from the average; one with some
   unpriced rows is *incomplete* (counted, flagged). `avgCostUsd = totalUsd /
   pricedDeliveries`, null when no priced delivery. `estimatedShare =
   estimatedUsd / totalUsd`, null when total is null or zero.
3. **Rounds**: `loop_step` events of the delivery's runs whose `nodeId` is
   `reviewer`/`review` (review) or `fixer`/`fix` (fixer); automatic stall
   retries (`attempt >= 2`) are not new rounds. A delivery whose runs have no
   `loop_step` events at all has unknown rounds and is excluded from the
   averages (null when no delivery is measured). No `loop_phase_*` events exist
   in Desktop today; the node ids come from Core's workflow graph.
4. **Escaped defects**: tickets whose `metadata.regressionOf` names a delivery
   in the window (child ids map to their parent). If no ticket in the project
   carries `regressionOf`, the metric is *untracked* and every loop reports
   `null` ("no data"), not 0.
5. **Placeholders**: `requirementsDemonstrated: {demonstrated,total} | null` and
   `triageAccuracy: {matched,total} | null` are always null for now; the response
   carries `sources` explaining why.
6. **Shared logic**: pure helpers (`summarizeInvocationCost`, `countLoopRounds`,
   `isDelivered`, `aggregateLoopEconomics`) live in the accounting module so the
   PR #786 baseline script can later import them instead of duplicating.
7. **Loop list**: published saved loops are read from the desktop DB by the
   router (composition), passed in as `knownLoops`; loops without deliveries get
   `hasData: false`.
8. **`regressionOf` storage**: `ticket.metadata.regressionOf` (string ≤ 200
   chars). Metadata is already free-form and ignored by Core, so no schema bump
   is needed, avoiding conflicts with a parallel 1.5 bump.

## Risks / Trade-offs

- Rounds depend on node naming; custom loops naming nodes differently report 0
  rounds when they have steps (honest: no reviewer ran) — documented.
- Per-delivery invocation queries are O(deliveries); acceptable for per-project
  windows (bounded by the period).
