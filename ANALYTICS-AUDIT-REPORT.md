# specrails-desktop — Analytics Subsystem Bug Audit

> Lead-auditor synthesis of an adversarial fan-out audit of the **Project spending analytics** subsystem (capture → store → aggregate → REST → render). Every finding below was confirmed by ≥2 of 3 independent verifiers. Findings the verifiers refuted are in §4 (Disputed / needs-human-review). No code was changed — this is report-only and fix-ready (every anchor was re-verified against the live tree).

---

## 1. Executive summary

### Counts (corrected severity, confirmed bugs only)

| Severity | Confirmed count |
|----------|-----------------|
| **High** | 0 |
| **Medium** | 9 |
| **Low** | 16 |
| **Confirmed total** | **25** |

After dedup (several reporters filed the same root cause across different audit dimensions — e.g. the loop status-always-`success` bug arrived 3×, the raw-CSV export-parity gap 3×, the timeline/hero/scatter surface-coverage gap 2× each), the 33 raw confirmed entries collapse into **25 distinct bugs**. No High-severity bugs: the analytics subsystem produces *wrong numbers/labels*, never a security or data-loss break. But the wrong numbers are concentrated and systemic.

> **Round-2 completeness pass (see §7):** a second pass added **13 more confirmed bugs** (BUG-ANALYTICS-24…36 — 4 Medium, 8 Low, 1 Info), bringing the report total to **38**. They were missed in round 1 because round 1 never audited the **HOME / cross-project rollup** (`server/desktop-analytics.ts` → `DesktopAnalyticsPage` + the always-visible `StatusBar` + `/api/state`) — which re-derives cost from the `jobs` table with none of the estimated-vs-authoritative discipline `spending.ts` carries — plus a `byModel` provider-collapse, a loop `started_at` provenance bug, recency-capped outlier charts, and a multi-surface Top-Tickets title fan-out. The §1 counts table above still reflects round 1's 25; §7 carries the round-2 numbers.

### The single most important risk — the Codex/Gemini accounting story

**Symptom the user reported:** codex (and gemini) runs are *miscounted* and *mis-shown* on the Analytics dashboard. This is not one bug — it is a **chain of ~12 defects that compound end-to-end** along the capture → store → aggregate → render pipeline. The root causes, in pipeline order:

1. **Capture — wrong provider stamp on the force-fail path.** `server/queue-manager.ts:2083` (`_forceFailUnkillableJob`) writes the `ai_invocations` row with `provider: this._adapter.id` (the project's *primary* adapter), because the per-job provider override was already consumed-and-deleted in `_resolveJobAdapter`. On a claude-primary multi-provider project, an unkillable **codex** job is recorded as `provider='claude'` → codex run-count under-stated, claude over-stated in `byProvider`. *(BUG-ANALYTICS-01)*

2. **Capture — startup-failed jobs vanish entirely.** `server/queue-manager.ts:782-813` (`_failWedgedJob`) marks the job failed in `jobs.sqlite` but **never calls `recordInvocation`** — unlike its sibling `_forceFailUnkillableJob` which deliberately does. A codex/gemini project whose binary isn't on PATH (the most common new-project failure) produces a job that is *invisible* to `totalRuns`/`failureRate`. *(BUG-ANALYTICS-02)*

3. **Capture — loop steps are always `status='success'`.** `server/loop-run-manager.ts:341` hardcodes `status: 'success'` even though the executor hands it `r.failed`. Codex/gemini loop steps fail more often (quota/usage-limit), and every one is persisted green → `failureRate` under-counts, `avgCost`-on-success is polluted. *(BUG-ANALYTICS-03)*

4. **Capture — loop steps drop the token breakdown.** `server/loop-executors.ts:163,199` fold `tokens_in + tokens_out` into one scalar and discard cache tokens; `server/loop-run-manager.ts:345` writes it into `tokens_out` only. Total tokens under-count badly for cache-hit claude loops; for *all* providers the input/output split is corrupted. *(BUG-ANALYTICS-04)*

5. **Store — failed codex/gemini rows persist `$0 estimated` instead of `NULL`.** `server/result-event.ts:64-74` stamps `cloned.model = fallbackModel` then runs the estimator over all-zero usage; `server/pricing.ts:90-94` returns the number `0` (not `null`), so the row is `total_cost_usd=0, estimated=1`. The equivalent claude row is `NULL`. Asymmetry → codex/gemini failed rows leak into the scatter as `$0` dots and render `~$0.00` in the table. *(BUG-ANALYTICS-05)*

6. **Aggregate/REST — raw CSV export drops `provider` + `total_cost_usd_estimated`.** `server/project-router-spending.ts:270-275` emits a fixed 19-column header missing both fields (the JSON export includes them). A codex *estimated* cost exports byte-identical to a claude *authoritative* cost — the audit-grade financial export silently flattens the estimated/authoritative invariant. *(BUG-ANALYTICS-06)*

7. **Render — no live refresh during loop runs.** `server/loop-run-manager.ts:334-348` is the *only* `recordInvocation` callsite that never broadcasts `spending.invalidated`, so an open dashboard freezes during multi-hour loops (often codex/gemini). *(BUG-ANALYTICS-07)*

8. **Render — ModelBreakdown shows estimated cost as authoritative.** `client/.../ModelBreakdown.tsx:42` renders `$X.XX` with no `~`, unlike every other cost surface. The server `byModel` aggregation doesn't carry the estimated flag, so the client *can't* mark it even if it wanted to. *(BUG-ANALYTICS-08)*

9. **Render — ProviderBreakdownCard shows unpriced codex/gemini providers as `$0.0000`.** When a non-native-cost model has no pricing entry, cost persists `NULL`; the card shows `$0.0000` with no marker and `count>0`, presenting a working provider as free. *(BUG-ANALYTICS-09)*

10. **Render — ProviderBreakdownCard bar-segment tooltip drops the `~`.** `client/.../ProviderBreakdownCard.tsx:88` omits the estimated marker the legend row carries → the same codex value is labelled estimated in one place, authoritative in another. *(BUG-ANALYTICS-10)*

11. **Render — InvocationsTable has no provider column.** In a multi-provider project, the row-level audit surface can't tell codex from claude. *(BUG-ANALYTICS-11)*

12. **Render — per-ticket spending line renders fully-estimated codex/gemini cost as authoritative.** `server/ai-invocations.ts:131-184` doesn't split on the estimated flag; `TicketSpendingLine.tsx` shows a plain `$X.XX`. *(BUG-ANALYTICS-12)*

**Blast radius:** in a multi-provider project (the only place this matters), the per-provider run-count, the success/failure rate, the per-model and per-provider cost cards, the raw export, and the live-refresh are **each independently wrong or misleading for codex/gemini** — and a long codex loop run compounds all of them at once. Single-provider claude projects are largely unaffected (the provider-stamp and estimated-marker gaps are no-ops there), which is exactly why the symptom reads as "codex-specific."

### Secondary themes (provider-agnostic, but on the same surfaces)

- **Surface-coverage drift** — the Timeline, Hero, and Scatter all hardcode 5-surface lists that omit `loop` and/or `file-summary`, while the server `totalCostUsd` includes them → the headline never equals the visible breakdown, and a loop/smash-only project can render "No data." *(BUG-ANALYTICS-13/14/15)*
- **Export reconciliation gaps** — the Summary CSV omits `loopCostUsd` (Daily timeline) and 3 of 7 surface columns (Top tickets), so the per-surface columns never sum to the row total. *(BUG-ANALYTICS-16/17)*
- **Top Tickets mislabels every live ticket as "Deleted"** — the `/spending` route never enriches `ticketTitle` (unlike `/invocations`). *(BUG-ANALYTICS-18)*
- **Truncation invisibility** — the raw table caps at 100 rows with no "showing N of M" notice because the client sends `limit` not `cap`. *(BUG-ANALYTICS-19)*
- **Client refetch races** — uncleared debounce timer + missing seq-guard on `fetchInvocations` can clobber fresh data with stale-filter responses. *(BUG-ANALYTICS-20)*

---

## 2. Confirmed bugs

Ordered by corrected severity (High → Medium → Low), then by pipeline stage. Codex/Gemini-related bugs are marked **⊛ codex**. Shared-root-cause dedups are noted under each entry.

> There are **no High-severity bugs** in this subsystem.

### MEDIUM

#### BUG-ANALYTICS-03 ⊛ codex — Loop AI-step / Decider invocations are always recorded `status='success'`
- **Severity:** Medium · **Layer:** capture
- **File:** `server/loop-run-manager.ts:341` (status hardcoded in `record()` @ 334-348); callsites @ 432 (AI Step) / 491 (Decider)
- **What's wrong:** The `record()` closure hardcodes `status: 'success'` for every `ai_invocations` row it writes, even though the result object `r` carries a real `r.failed` flag (`AiStepResult.failed`, set in `loop-executors.ts:135` on spawn-fail / timeout / non-zero exit) — and the block one line above (`r.failed === true` cost-uncertainty branch) already reads it. The Decider similarly fails when `dec.parsed === false`.
- **Impact:** `summary.failed = SUM(status='failed')` (`spending.ts`) never counts a failed loop step, so `failureRate = failed/totalRuns` is under-stated while `totalRuns` still includes the row → the dashboard reports the loop subsystem as more reliable than it is. `avgCost = AVG(CASE WHEN status='success' THEN total_cost_usd)` absorbs failed/timed-out steps into the success-only average. `InvocationsTable` shows a green success dot for a crashed step.
- **Trigger:** Any loop whose AI step or Decider exits non-zero / times out — disproportionately codex/gemini (quota / usage-limit / sandbox `writable_roots`).
- **Fix:** Thread `r.failed` into `record()` and map `status: r.failed ? 'failed' : 'success'` (consider `'aborted'` for timeouts). The closure already receives `failed?: boolean` in its param type. For the Decider, add a parallel flag (`!dec.parsed → failed`).

#### BUG-ANALYTICS-04 ⊛ codex — Loop steps fold input into output and drop cache tokens
- **Severity:** Medium · **Layer:** capture
- **File:** `server/loop-executors.ts:163` (AI step) & `:199` (Decider); written in `server/loop-run-manager.ts:345`
- **What's wrong:** Both executors collapse the breakdown into `tokens: (result.tokens_in ?? 0) + (result.tokens_out ?? 0)`, dropping `tokens_cache_read` / `tokens_cache_create` entirely and discarding the in/out split. `record()` then writes the conflated scalar into `tokens_out` only, leaving `tokens_in`/`tokens_cache_read`/`tokens_cache_create` **NULL** on every `surface='loop'` row.
- **Impact:** For **claude** loop steps, cache tokens are a *separate* count from `input_tokens` (not a subset) — so `getSpending.totalTokens = SUM(tokens_in+tokens_out+cache_read+cache_create)` (`spending.ts:242-243`) under-counts by the entire cache volume (often the largest component on cache-hit runs — a worked example shows 2 500 counted vs 24 500 true, a ~90% under-count). For **all** providers the per-direction view is corrupted: loop input tokens read as 0, all loop tokens mislabeled as output (surfaces in the raw export's separate `tokens_in`/`tokens_out` columns). Cost is unaffected (computed upstream before the fold).
- **Trigger:** Any loop AI step / Decider; worst on cache-hit claude steps.
- **Fix:** Return structured fields from the executors (`tokensIn/tokensOut/tokensCacheRead/tokensCacheCreate`) and map them to the matching columns in `record()`. Keep `r.tokens` (or derive it) only for the in-memory running total / cost-uncertainty heuristic.

#### BUG-ANALYTICS-06 ⊛ codex — Raw CSV export omits `provider` and `total_cost_usd_estimated`
- **Severity:** Medium · **Layer:** aggregation/REST
- **File:** `server/project-router-spending.ts:270-275`
- **What's wrong:** The raw-mode CSV header is a fixed 19-column list (`id,surface,…,total_cost_usd,num_turns,session_id`) that deliberately excludes both `provider` and `total_cost_usd_estimated`, even though both are real columns on `InvocationRow` and the JSON raw export (`res.json(result)`, ~line 267) returns them. Only the CSV path strips them.
- **Impact:** A codex/gemini row whose cost is *estimated* (pricing-table-derived, `estimated=1`) exports byte-identical to a claude *authoritative* row. A user summing the `total_cost_usd` column mixes real and estimated dollars with no way to tell them apart, and has no `provider` column to segment by — the audit-grade financial export silently flattens the estimated/authoritative invariant the on-screen table (`InvocationsTable`'s `~` marker) preserves.
- **Trigger:** `GET /api/projects/:id/analytics/export?format=csv&mode=raw` on any project with codex/gemini rows.
- **Fix:** Add `provider` and `total_cost_usd_estimated` to the `headers` array (both already present on the row object, so the `csvEscape` map loop picks them up automatically).
- **Dedup:** Filed 3× across dimensions `export-parity`, `rest-endpoints`, `estimated-vs-authoritative` — one fix.

#### BUG-ANALYTICS-07 ⊛ codex — Loop invocations never broadcast `spending.invalidated`
- **Severity:** Medium · **Layer:** REST/WebSocket
- **File:** `server/loop-run-manager.ts:334-348` (`record()` helper); callers @ 432, 491
- **What's wrong:** Every other `recordInvocation` callsite broadcasts `{ type:'spending.invalidated', projectId }` right after the insert (queue-manager ×3, chat-manager ×2, agent-refine, project-router-tickets ×2, file-summary, contract-refine ×2, smash-runner). The loop path is the **sole exception** — `record()` writes a `surface='loop'` row for every AI step + Decider but its only broadcasts are `loop_step` / `loop.run_progress` / `job.finalized` / `log` / `event`.
- **Impact:** The client `AnalyticsPage` WS handler refetches only on `spending.invalidated`, so a dashboard left open during a (potentially multi-hour) loop run never refreshes — frozen Hero/timeline/byProvider, stale/empty `loop` surface segment — until a manual refresh or an unrelated invocation fires. Loop cost is frequently codex/gemini-estimated, so this specifically suppresses live refresh of estimated non-claude spend.
- **Trigger:** Open `/analytics`, launch a loop rail; totals don't move until Refresh.
- **Fix:** In `record()` (or immediately after each call), add `this.broadcast({ type:'spending.invalidated', projectId: req.projectId })`, wrapped so a broadcast failure can't break traversal (mirror the file-summary callsite).

#### BUG-ANALYTICS-13 ⊛ codex — SpendingTimeline drops smash + loop spend and mis-reports empty
- **Severity:** Medium · **Layer:** client
- **File:** `client/src/components/analytics/SpendingTimeline.tsx:11-19, 43-47` (verified: 5 `<Bar>` series, `isEmpty` sums 5 fields)
- **What's wrong:** The server populates per-day `smashCostUsd` (`spending.ts:323`) and `loopCostUsd` (`:325`), both included in `totalCostUsd` (`:326`). The client builds `chartData` from only 5 series (jobs/explore/quick/refine/fileSummaries) and renders only 5 `<Bar>` elements — **no smash bar, no loop bar**. Worse, the `isEmpty` check sums only `jobs+explore+quick+aiEdit+fileSummary`, omitting smash + loop.
- **Impact:** A project whose window spend is exclusively SMASH and/or Loop renders the **"No data" empty state despite real cost**; in mixed projects the stacked bars sum to *less* than the day's true total — directly contradicting the Hero on the same page. Loop is codex/gemini-capable, so this also hides multi-provider loop spend. (Locale keys `surfaces.smash`/`surfaces.loop` already exist, confirming the series were intended.)
- **Trigger:** Project with only loop-mode (or smash) invocations in the window.
- **Fix:** Add `labels.smash`/`labels.loop`, map `d.smashCostUsd`/`d.loopCostUsd` into `chartData`, add two `<Bar>` entries (smash → `accent-highlight`, loop → `accent-primary` per `SURFACE_ACCENT` — note smash/explore currently collide on `accent-highlight`, pick a distinct colour), and include both in the `isEmpty` sum. Also add `loopCostUsd` to client `types/spending.ts` `DailyEntry` (currently missing — see disputed note).
- **Dedup:** Filed 2× (dimensions `client-hero-timeline-scatter`, `surface-colour-coverage`).

#### BUG-ANALYTICS-14 ⊛ codex — SpendingHero segment bar/legend omits file-summary + loop
- **Severity:** Medium · **Layer:** client
- **File:** `client/src/components/analytics/SpendingHero.tsx:30` (`SURFACES = ['job','explore-spec','quick-spec','ai-edit','smash']`), 73-76, 138-161
- **What's wrong:** The Hero total (`data.summary.totalCostUsd`) includes every surface, but the segment bar + legend iterate only the 5-surface `SURFACES` list — `file-summary` and `loop` (both in server `ALL_SURFACES`) are never mapped. `pct = seg.costUsd / total` uses the full total as denominator.
- **Impact:** The coloured bar fills to **less than 100%** (the file-summary+loop fraction is an unexplained gap) and the legend itemisation does not sum to the headline number. Loop can be codex/gemini.
- **Trigger:** Any project with file-summary and/or loop spend.
- **Fix:** Add `'file-summary'` and `'loop'` to `SURFACES` (both already in `SURFACE_ACCENT`/`SURFACE_LABEL`).
- **Dedup:** Filed 2× (`client-hero-timeline-scatter`, `surface-colour-coverage`).

#### BUG-ANALYTICS-18 — Top Tickets labels every live ticket "Deleted ticket #N"
- **Severity:** Medium · **Layer:** aggregation
- **File:** `server/spending.ts:413-420` (topTickets build, `ticketTitle: null`, no `isDeleted`); `server/project-router-spending.ts:120` (`/spending` route returns `getSpending(...)` **with no title enrichment** — verified: unlike the `/invocations` route @ 143-153 which reads `readStore(ticketPath(req))`)
- **What's wrong:** `getSpending()` builds every `TopTicketEntry` with `ticketTitle: null` and never sets `isDeleted`; the `/spending` route returns it verbatim. `spending.ts` imports nothing for ticket titles.
- **Impact:** The client `TopTicketsCrossSurface` computes `label = ticketTitle ? '#id title' : deletedTicket{id}` with `opacity-50`. With `ticketTitle` always null, **every attributed, live ticket renders as "Deleted ticket #N", greyed out** — wrong label + wrong visual state for the entire Top Tickets list (only the unattributed bucket is correct). Untested because export/tests assert only `ticketId`.
- **Trigger:** Any ticket with spend; open `/analytics`.
- **Fix:** In the `/spending` route (or via an injected store reader in `getSpending`), after computing `topTickets`, read the YAML ticket store and for each `ticketId != null` set `ticketTitle = store.tickets[id]?.title ?? null` and `isDeleted = !store.tickets[id]`. Mirror the `/invocations` enrichment.

#### BUG-ANALYTICS-19 — Raw invocations table silently caps at 100 with no truncation notice
- **Severity:** Medium · **Layer:** REST + client
- **File:** `client/src/pages/AnalyticsPage.tsx:133` (`&limit=100`, never sends `cap`); `server/spending.ts:591` (`truncated = cap !== undefined && totalRow.total > cap`); `client/.../InvocationsTable.tsx:200-204`
- **What's wrong:** The page fetches `/invocations?...&limit=100` and never sends `cap`. `getInvocations` computes `truncated` only from `cap`, so on the `limit` path `truncated` is **always false** regardless of row count. `InvocationsTable` renders the "showing N of M" note only when `truncated` is true. No offset/pagination UI exists.
- **Impact:** A project with >100 invocations shows exactly 100 rows with **no signal that data is missing** — the user believes they see every invocation. `totalAvailable` is returned correctly but the gate that surfaces it can never fire on the only path the client uses.
- **Trigger:** >100 `ai_invocations` rows; open `/analytics`.
- **Fix:** Either send `cap=100` instead of/alongside `limit`, OR compute `truncated = totalRow.total > rows.length` independent of `cap` server-side, OR have the client render the footnote whenever `totalAvailable > rows.length`.
- **Dedup:** Filed 2× (`rest-endpoints`, `client-analyticspage`).

### LOW

#### BUG-ANALYTICS-01 ⊛ codex — Unkillable job stamps the PRIMARY provider, ignoring the per-job override
- **Severity:** Low · **Layer:** capture
- **File:** `server/queue-manager.ts:2083` (`_forceFailUnkillableJob`); contrast normal path @ ~1797 (`adapter.id` from `_onJobExit`)
- **What's wrong:** The SIGKILL-survived terminal path writes the row with `provider: this._adapter.id` (project primary). The per-job override (`_jobProviderSelection`) was already consumed-and-deleted in `_resolveJobAdapter` (~865-866) at job start, and there is no `_jobAdapter` map, so the actual provider the child ran on is unrecoverable here.
- **Impact:** A claude-primary, `[claude,codex]` project that launches a **codex** job whose child survives SIGKILL writes `surface='job', status='aborted'` with `provider='claude'`. `byProvider` (`COALESCE(provider,'claude') GROUP BY provider`) attributes the aborted run to the wrong provider → codex count −1, claude count +1. No cost/token impact (row carries none). Single-provider codex projects unaffected (`_adapter.id` is then correctly `'codex'`).
- **Trigger:** Multi-provider claude-primary project + codex rail + child ignores SIGTERM/SIGKILL (rare).
- **Fix:** Store the resolved adapter id per job in a Map at `_startJob` time (`this._jobResolvedProvider.set(jobId, adapter.id)`); read it in `_forceFailUnkillableJob` with `this._adapter.id` only as final fallback; clear it alongside the other per-job maps at teardown.
- **Dedup:** Filed 2× (`codex-accounting-e2e`, `provider-stamping`).

#### BUG-ANALYTICS-02 ⊛ codex — Pre-spawn failure (`_failWedgedJob`) writes NO invocation row
- **Severity:** Low · **Layer:** capture
- **File:** `server/queue-manager.ts:782-813` (`_failWedgedJob`); contrast `_forceFailUnkillableJob:2080-2092` which deliberately records
- **What's wrong:** When `_startJob` throws **before** establishing a child (spawn-arg build, plugin verify, profile snapshot, workspace resolution, sync spawn throw), the drain catch routes to `_failWedgedJob`, which calls `finishJob` (`jobs.sqlite`) + `onJobFinished` but **never `recordInvocation`**. `_onJobExit` never runs (no child). The sibling `_forceFailUnkillableJob` was given a `recordInvocation` for exactly this reason; `_failWedgedJob` was not.
- **Impact:** A job that failed at startup is **completely invisible** on Analytics — `totalRuns` and `failureRate` are computed only from `ai_invocations`, so it neither increments `totalRuns` nor `failed`; it vanishes. Disproportionately affects newly-added codex/gemini projects (binary not on PATH, MCP/profile setup throws) — exactly the failures an operator most wants counted.
- **Trigger:** Force `_startJob` to throw before spawn.
- **Fix:** Mirror `_forceFailUnkillableJob`: after `finishJob`, if `this._db && this._projectId`, `recordInvocation({ surface:'job', surface_ref_id:jobId, status:'failed', provider:this._adapter.id, started_at: job.startedAt ?? finishedAt, finished_at, ticket_id: extracted, duration_ms: wallClock, total_cost_usd_estimated:false })` and broadcast `spending.invalidated`. (Provider stamp here shares BUG-ANALYTICS-01's limitation — the override is also gone by this point — but recording the row at all is the primary fix.)

#### BUG-ANALYTICS-05 ⊛ codex — Failed codex/gemini rows persist `$0 estimated` instead of `NULL`
- **Severity:** Low (reporter: info) · **Layer:** store/aggregation
- **File:** `server/result-event.ts:64-74` (`finaliseInvocationResult`) + `server/pricing.ts:90-94`
- **What's wrong:** When a codex/gemini turn ends without a `turn.completed`/`result` usage block, `extractResult` returns no tokens but `finaliseInvocationResult` still stamps `cloned.model = fallbackModel`. `estimateCostUsd` then has a valid model + all-zero usage → `freshInput = max(0, 0-0) = 0` and returns the **number `0`** (it returns `null` only when `!model` or no pricing key). So `total_cost_usd=0, total_cost_usd_estimated=1`. The equivalent claude failure leaves `total_cost_usd` undefined → persisted `NULL`.
- **Impact:** Provider asymmetry: codex/gemini failed rows are non-NULL, so they pass the scatter filter (`WHERE total_cost_usd IS NOT NULL`) and render as `$0` dots, and they count as `$0` "estimated cost" rows in `byProvider`'s estimated branch; the equivalent claude rows are NULL and excluded. Cost totals/averages unaffected ($0 adds nothing). Cosmetic but confusing ("why does a failed run show an estimated cost") and renders `~$0.00` in the table.
- **Trigger:** Abort/crash a codex rail before `turn.completed`.
- **Fix:** In `finaliseInvocationResult`, skip the estimator (leave `total_cost_usd` undefined) when no usage token field is present — e.g. when `tokens_in/out/cache` are all undefined, treat as no-cost rather than estimating $0. OR make `estimateCostUsd` return `null` when the usage breakdown is entirely empty.
- **Dedup:** Filed 2× (`codex-accounting-e2e`, `cost-estimation`).

#### BUG-ANALYTICS-08 ⊛ codex — ModelBreakdown shows estimated cost as authoritative
- **Severity:** Low · **Layer:** client (+ server aggregation gap)
- **File:** `client/src/components/analytics/ModelBreakdown.tsx:42` (`${m.costUsd.toFixed(2)}`, verified no `~`); server `server/spending.ts:271` (`byModel` SUMs cost without carrying the estimated flag)
- **What's wrong:** Each model row renders `$X.XX` with zero awareness of whether the cost is authoritative (claude native) or server-estimated (codex/gemini pricing-table). A codex `gpt-5.5` and a claude model render identically. The `byModel` aggregation SUMs `total_cost_usd` across authoritative + estimated rows without the flag, so the client has **no signal to render even if it wanted to**.
- **Impact:** ModelBreakdown is the only per-model surface and it drops the estimated/authoritative distinction that `ProviderBreakdownCard` + `InvocationsTable` both carry via `~`.
- **Trigger:** Multi-provider project with codex/gemini model spend.
- **Fix:** Server: add an estimated split to `byModel` (e.g. `estimatedCostUsd`). Client: prefix `~` when a model's cost is wholly/partly estimated.

#### BUG-ANALYTICS-09 ⊛ codex — ProviderBreakdownCard shows unpriced codex/gemini provider as `$0.0000`
- **Severity:** Low · **Layer:** client (+ server pricing gap)
- **File:** `client/src/components/analytics/ProviderBreakdownCard.tsx:107-116`; root cause `server/result-event.ts:75-85` (NULL cost on missing pricing entry)
- **What's wrong:** When a non-native-cost provider ran with a model id absent from `PRICING`, cost persists `NULL` (estimated flag 0). Server `byProvider` yields `costUsd=0` AND `estimatedCostUsd=0` while `count` is the real run count. `allEstimated = costUsd===0 && estimatedCostUsd>0` is **false**, so the row shows `fmtUsd(0)` = `$0.0000` with no `~`, and its bar segment is dropped (`pct===0 → return null`).
- **Impact:** A codex provider with, say, 40 real runs displays "40 runs · $0.0000" as if free. The grand-total `noCost` guard only triggers when *every* provider is 0, so in a mixed claude+codex project the codex $0 row renders alongside real claude cost with no "cost unavailable" affordance.
- **Trigger:** Codex/gemini model with no `PRICING` entry (catalog/pricing drift).
- **Fix:** Add a `count>0 && sum===0` reconciliation in the card → render a "cost unavailable" affordance instead of `$0.0000`. (And keep the pricing table current per its quarterly contract.)

#### BUG-ANALYTICS-10 ⊛ codex — ProviderBreakdownCard bar-segment tooltip omits the `~` marker
- **Severity:** Low · **Layer:** client
- **File:** `client/src/components/analytics/ProviderBreakdownCard.tsx:88` (segment `title` uses `fmtUsd(sum)`, no `~`; verified the legend row @ ~116 prefixes `~` when `allEstimated`)
- **What's wrong:** The segment hover title uses `t('providerCard.segmentTitle', { value: fmtUsd(sum) })` — no `~` — even for an estimated-only provider, while the matching legend row correctly shows `~$X`.
- **Impact:** Inconsistent estimated-vs-authoritative signalling within the same card: the i18n string explicitly tells users `~` marks estimates, but the tooltip drops it. Cosmetic, undermines the trust signal.
- **Trigger:** Hover a codex/gemini bar segment.
- **Fix:** Prefix `~` in the segment title when the provider is estimated-only, mirroring the legend row.

#### BUG-ANALYTICS-11 ⊛ codex — InvocationsTable has no provider column
- **Severity:** Low · **Layer:** client
- **File:** `client/src/components/analytics/InvocationsTable.tsx:110-121, 178-181`
- **What's wrong:** `InvocationRow` carries `provider` (server `COALESCE(provider,'claude')`), but the table renders no provider column (Surface/Ticket/Cost/Turns/Tokens/Model/Status/Started). The estimated `~` on cost is the only indirect hint, and only when `estimated===1`.
- **Impact:** In a multi-provider project the row-level audit surface can't tell which engine produced each invocation; a claude row and a codex row look identical.
- **Trigger:** Multi-provider project; open the raw table.
- **Fix:** Add a Provider column rendering `providerLabel(r.provider ?? 'claude')`; optionally gate visibility on `multiProvider` to avoid single-provider clutter.

#### BUG-ANALYTICS-12 ⊛ codex — Per-ticket spending line renders estimated cost as authoritative
- **Severity:** Low · **Layer:** aggregation + client
- **File:** `server/ai-invocations.ts:131-184` (`getTicketSpendingSummary`, no estimated split); `client/src/components/TicketSpendingLine.tsx:64` (plain `$X.XX`)
- **What's wrong:** `getTicketSpendingSummary` SUMs `total_cost_usd` with no awareness of `total_cost_usd_estimated`, and `TicketSpendingLine` renders it plainly. For a ticket implemented entirely via codex/gemini, this number is 100% estimated yet displayed identically to authoritative claude cost. The numeric value is correct; only the provenance is lost.
- **Trigger:** Implement a ticket via a codex rail; open its `TicketDetailModal`.
- **Fix:** Have `getTicketSpendingSummary` also return `estimatedCostUsd` (`SUM(CASE WHEN total_cost_usd_estimated=1 THEN total_cost_usd ELSE 0 END)`); prefix `~` in `TicketSpendingLine` when wholly/partly estimated (mirror `ProviderBreakdownCard.allEstimated`).

#### BUG-ANALYTICS-15 ⊛ codex — CostScatter omits file-summary + loop points (and legend)
- **Severity:** Low · **Layer:** client
- **File:** `client/src/components/analytics/CostScatter.tsx:22-28` (`COLOR` map) & `:37` (`surfaces` array) — verified both list only job/quick-spec/explore-spec/ai-edit/smash
- **What's wrong:** The server scatter query returns up to 500 points across **all** surfaces (`spending.ts:380-401`, no surface filter). The client hardcodes 5 surfaces and filters per-surface, so every `file-summary` and `loop` point is silently excluded from the plot and legend — while still consuming slots in the 500-cap (potentially pushing out points that would have shown). `isEmpty` only checks `scatter.length===0`, so the user is never told points were dropped.
- **Trigger:** Project with file-summary or loop invocations carrying cost.
- **Fix:** Extend `COLOR` + `surfaces` to include `'file-summary'` (`accent-warning`) and `'loop'` (`accent-primary`); prefer importing `SURFACE_ACCENT`/`SURFACE_LABEL` over a local map to avoid drift.
- **Dedup:** Filed 2× (`client-hero-timeline-scatter`, `surface-colour-coverage`).

#### BUG-ANALYTICS-16 ⊛ codex — Summary CSV "Daily timeline" drops `loopCostUsd`
- **Severity:** Low · **Layer:** aggregation/REST
- **File:** `server/project-router-spending.ts:226-228` (header ends `…fileSummaryCostUsd,totalCostUsd`; row emits matching 8 — verified)
- **What's wrong:** `DailyEntry` carries `loopCostUsd` (`spending.ts:35`, populated @ 325) included in `totalCostUsd`, but the CSV omits it from header and row.
- **Impact:** On any day with loop activity, the per-surface columns sum to **less** than `totalCostUsd` — a silent reconciliation gap in a financial export exactly equal to the loop cost. Loop is frequently codex/gemini, so this disproportionately hides non-claude spend.
- **Trigger:** Run a loop rail; export summary CSV.
- **Fix:** Add `loopCostUsd` to the header and the interpolated row.
- **Dedup:** Filed 2× (`export-parity`, `rest-endpoints`).

#### BUG-ANALYTICS-17 — Summary CSV "Top tickets" emits only 4 of 7 surface cost columns
- **Severity:** Low · **Layer:** aggregation/REST
- **File:** `server/project-router-spending.ts:240-250` (header `ticketId,totalCostUsd,totalRuns,jobCost,quickCost,exploreCost,aiEditCost`; row emits only job/quick-spec/explore-spec/ai-edit — verified)
- **What's wrong:** Each `TopTicketEntry.bySurface` carries `smash`, `file-summary`, and `loop` cost, and `totalCostUsd` sums all of them, but the CSV emits only 4.
- **Impact:** For any ticket with smash/file-summary/loop cost, the 4 emitted columns don't add up to `totalCostUsd` — unexplained shortfall.
- **Trigger:** Attribute a smash/loop invocation to a ticket; export summary CSV.
- **Fix:** Add `smashCost`/`fileSummaryCost`/`loopCost` columns reading `t.bySurface.smash.costUsd`, `t.bySurface['file-summary'].costUsd`, `t.bySurface.loop.costUsd`.

#### BUG-ANALYTICS-20 — Debounced invalidation timer never cleared; stale-filter refetch can clobber fresh data
- **Severity:** Low · **Layer:** client
- **File:** `client/src/pages/AnalyticsPage.tsx:144-161` (WS effect + `debounceRef`, cleanup @ 160)
- **What's wrong:** The WS effect arms a 500ms debounce that calls `fetchSpending()`+`fetchInvocations()`. Its cleanup is `() => { ws.unregisterHandler(handlerId) }` — it does **not** `clearTimeout(debounceRef.current)`. With deps `[ws, activeProjectId, fetchSpending, fetchInvocations]` (recreated on filter change), a pending timer fires the OLD closures (OLD filters via `buildQuery(filters)`) after a period/surface/project change. `fetchSpending` has a `refetchSeqRef` guard but the stale fetch increments seq *after* the period-change fetch, so the later-landing stale response can win; `fetchInvocations` has **no seq guard at all** (lines 126-139).
- **Impact:** After a rapid invalidate+filter-change interleave (or a project switch within 500ms), the dashboard — especially the raw table — can render the previous period/surface/project's data with no error surfaced.
- **Trigger:** Trigger `spending.invalidated` (finish a job), then within 500ms click a different period chip.
- **Fix:** In cleanup also `if (debounceRef.current) clearTimeout(debounceRef.current)`. Give `fetchInvocations` the same `refetchSeqRef`-style guard `fetchSpending` has.

#### BUG-ANALYTICS-21 — dailyTimeline buckets are UTC days; client renders the label verbatim (off-by-one for non-UTC users)
- **Severity:** Low · **Layer:** aggregation + client
- **File:** `server/spending.ts:294-308` (`substr(started_at,1,10)` + `eachDay`), `:150-159` (resolveRange); `client/.../SpendingTimeline.tsx:26-37`
- **What's wrong:** `started_at` is stored as `new Date().toISOString()` (UTC, trailing Z) at every capture site. `dailyTimeline` groups by the UTC calendar day and `range.to`/`eachDay` walk UTC midnights. The client displays `d.date.slice(5)` (MM-DD) with no local-tz conversion.
- **Impact:** For a user east of UTC (e.g. UTC+10), at local 09:00 Jun 28 the UTC instant is Jun 27 23:00 — so "today" has no bar until ~10:00 local, and a 09:30-local run lands in the UTC Jun-27 bucket labeled `06-27` while the user thinks it's the 28th. Cost totals are correct; only day attribution/labels shift by one and the expected "today" column can be absent.
- **Trigger:** Machine timezone UTC+10, run an invocation at ~09:30 local.
- **Fix:** Bucket by local day (compute the offset client-side from `startedAt`, or pass a tz offset to `getSpending` and apply it in the substr/eachDay math); or document the timeline as UTC and label the axis accordingly.

#### BUG-ANALYTICS-22 — Model filter has no header chip or clear control
- **Severity:** Low · **Layer:** client
- **File:** `client/src/pages/AnalyticsPage.tsx:91-97 (URL-sync), 317-322`
- **What's wrong:** Clicking a model in ModelBreakdown calls `setFilters({ model: [m] })`, a dep of `fetchSpending`/`fetchInvocations`, so it re-filters **every** block (hero, timeline, scatter, top tickets, table). But `filters.model` is not URL-synced (only period/surface/provider/ticketId are), and the only on-screen indication is the highlighted ModelBreakdown row — unlike `ticketId` which gets a removable header chip.
- **Impact:** Silent global filtering: all headline numbers scoped to one model while the header reads as the full-period view, with no discoverable "clear model" affordance outside ModelBreakdown.
- **Trigger:** Click a model bar, scroll past ModelBreakdown.
- **Fix:** Render a removable header chip for `filters.model[0]` (mirror the ticketId chip); make the model row a toggle so re-clicking clears; optionally URL-sync model.

#### BUG-ANALYTICS-23 — Spending blocks show the previous project's data on switch to a never-visited project
- **Severity:** Low · **Layer:** client
- **File:** `client/src/pages/AnalyticsPage.tsx:99-124, 306-340`
- **What's wrong:** `fetchSpending` keys `cacheRef` by `${activeProjectId}:${query}`. On a cache **miss** it sets `loading=true` but does NOT clear `data`. Since `data` is never reset on project switch, switching to a never-opened project leaves the previous project's `data` rendered in all blocks until the new fetch resolves (skeletons require `loading && !data`).
- **Impact:** Brief cross-project leak of aggregate numbers (totals, per-model, per-ticket) into the wrong project's view during the in-flight window. Self-corrects (project-scoped key) but shows wrong-project data meanwhile.
- **Trigger:** Open project A, then switch to a brand-new project B.
- **Fix:** On cache miss, `setData(null)` (or clear `data` in a `useEffect` keyed on `activeProjectId`) so the skeleton shows.

---

## 3. Codex / Gemini accounting — consolidated fix plan

This is the user's reported symptom, read as **one coherent pipeline** (capture → store → aggregate → REST → render). Fix in this order and the codex/gemini numbers become correct *and* honestly labelled.

| # | Stage | Bug | File:line | One-line fix |
|---|-------|-----|-----------|--------------|
| 1 | **capture** | BUG-ANALYTICS-01 — codex job stamped `provider='claude'` on force-fail | `queue-manager.ts:2083` | Store resolved adapter id per-job; read it instead of `_adapter.id` |
| 2 | **capture** | BUG-ANALYTICS-02 — startup-failed codex job writes no row (vanishes) | `queue-manager.ts:782-813` | Mirror `_forceFailUnkillableJob`'s `recordInvocation` + `spending.invalidated` |
| 3 | **capture** | BUG-ANALYTICS-03 — loop steps always `success` | `loop-run-manager.ts:341` | `status: r.failed ? 'failed' : 'success'` |
| 4 | **capture** | BUG-ANALYTICS-04 — loop token breakdown folded/dropped | `loop-executors.ts:163,199` + `loop-run-manager.ts:345` | Return + write `tokensIn/Out/CacheRead/CacheCreate` to matching columns |
| 5 | **store** | BUG-ANALYTICS-05 — failed codex/gemini → `$0 estimated` not `NULL` | `result-event.ts:64-74` + `pricing.ts:90-94` | Skip estimator when usage entirely empty → leave cost undefined |
| 6 | **store/agg** | BUG-ANALYTICS-09 — unpriced codex model → silent `$0` | `result-event.ts:75-85` + `ProviderBreakdownCard.tsx:107` | Keep pricing current; render "cost unavailable" when `count>0 && sum===0` |
| 7 | **aggregate** | BUG-ANALYTICS-08 — `byModel` carries no estimated flag | `spending.ts:271` | Add `estimatedCostUsd` split to `byModel` |
| 8 | **aggregate** | BUG-ANALYTICS-12 — per-ticket summary no estimated split | `ai-invocations.ts:131-184` | Add `estimatedCostUsd` to `getTicketSpendingSummary` |
| 9 | **REST** | BUG-ANALYTICS-06 — raw CSV drops `provider`+`estimated` | `project-router-spending.ts:270-275` | Add both to the headers array |
| 10 | **REST** | BUG-ANALYTICS-16 — summary CSV drops `loopCostUsd` (codex loops) | `project-router-spending.ts:226-228` | Add `loopCostUsd` column |
| 11 | **WS** | BUG-ANALYTICS-07 — loop never broadcasts `spending.invalidated` | `loop-run-manager.ts:334-348` | Broadcast after each `record()` |
| 12 | **render** | BUG-ANALYTICS-08 — ModelBreakdown shows estimate as authoritative | `ModelBreakdown.tsx:42` | Prefix `~` when estimated |
| 13 | **render** | BUG-ANALYTICS-10 — Provider bar tooltip drops `~` | `ProviderBreakdownCard.tsx:88` | Prefix `~` in segment title |
| 14 | **render** | BUG-ANALYTICS-11 — InvocationsTable no provider column | `InvocationsTable.tsx:110-121` | Add Provider column |
| 15 | **render** | BUG-ANALYTICS-12 — TicketSpendingLine no `~` | `TicketSpendingLine.tsx:64` | Prefix `~` when estimated |
| 16 | **render** | BUG-ANALYTICS-13/14/15 — loop spend missing from timeline/hero/scatter | timeline/hero/scatter | Add `loop` (+`file-summary`/`smash`) series everywhere |

**Why it reads as "codex-specific":** items 1, 5, 8, 10, 12, 13, 14, 15 are all **no-ops on a single-provider claude project** (no estimated rows, no provider divergence, loop is largely the same surface). They only manifest where codex/gemini participate — which is precisely the user's setup. Items 2, 3, 4, 7, 11, 16 are provider-agnostic but bite codex/gemini harder because those engines fail/retry/loop more and carry estimated cost.

---

## 4. Disputed / needs-human-review

These were filed but the verifiers (≥2 of 3) refuted them as confirmed *analytics bugs* — usually real code observations whose user-visible impact is hypothetical, unreachable, or working-as-designed. Listed for human adjudication; **none counted in §1**.

| Title | File | Verdict & reason |
|-------|------|------------------|
| Loop stuffs (in+out) tokens into `tokens_out`, leaves `tokens_in` NULL | `server/loop-run-manager.ts` | **Refuted → info.** Code claim true, but every aggregation (`spending.ts:242-243`, `InvocationsTable`) SUMs all four token columns, so totals stay correct; the only manifestation is a per-column misattribution in the **raw export** with no effect on any dashboard number or cost. *(NOTE: this is the storage-side root of the confirmed **BUG-ANALYTICS-04** — the cache-token DROP is the real defect; the in/out fold alone is benign. Fix them together.)* |
| Normal failed/crashed job persists `duration_ms=NULL` despite known wall-clock | `server/queue-manager.ts` | **Refuted → info.** Mechanism real (normal exit path takes duration only from `...normalised`; interactive/unkillable paths compute wall-clock fallback). But no analytics consumer turns it into a wrong number: `avgDurationMs` is scoped to `surface IN ('quick-spec','explore-spec') AND status='success'` (excludes failed jobs); scatter excludes NULL-cost rows. Only `getTicketSpendingSummary.activeDurationMs` reads it as `?? 0` (benign under-count of an additive sum). Latent capture-consistency nit. |
| scatter & cost aggregates silently drop codex/gemini runs whose cost estimates to NULL | `server/spending.ts` | **Split verdict (2 refute → info/low, 1 confirm → medium).** Mechanism real and end-to-end (unpriced `<provider>:<model>` → NULL cost → dropped from scatter, $0 in sums). Two verifiers refuted because the trigger is **currently unreachable**: every selectable codex (`gpt-5.5/5.4/5.4-mini/5.3-codex`) and gemini model has an exact `PRICING` key today, and `model` is drawn from a closed curated catalog, not free-form CLI text — so it only fires on future catalog/pricing drift, which the existing `console.warn` (`result-event.ts:81-84`) targets. One verifier kept it at medium as a conditional codex-miscount. **Human call:** treat as a guarded latent risk; the user-facing fix is the "cost unavailable" affordance already captured as BUG-ANALYTICS-09. |
| `InvocationsResponse.total` reports page size, not grand total (misnamed field) | `server/spending.ts:588-593` | **Refuted → info.** Field genuinely misnamed (`total` = page count; grand total is `totalAvailable`), but **no consumer reads `.total`** — client and export both read `totalAvailable`. Zero current wrong number; a latent naming trap only. Provider-agnostic. |
| Client `DailyEntry` type missing `loopCostUsd` (and `fileSummaryCostUsd` optional) | `client/src/types/spending.ts` | **Refuted → info.** Type drift is real (server `DailyEntry` declares both as required/present; client omits `loopCostUsd`, makes `fileSummaryCostUsd` optional). But a type omitting a field the only consumer never reads cannot drop data at runtime (TS is structural — the object still carries it). The *visible* defect lives in `SpendingTimeline.tsx` (no loop `<Bar>`) = confirmed **BUG-ANALYTICS-13**. Worth syncing the type as part of that fix, but not an independent medium bug; loop is Claude-only per CLAUDE.md so not codex-differential. |

---

## 5. Recommended fix order

**P0 — Codex/Gemini accounting (the reported symptom).** Land §3 as a single coherent change set, in the table's pipeline order. Capture fixes (1-4) first — they stop *new* bad rows; then store/aggregate (5-10); then render (11-16). Highest-leverage single fixes: BUG-ANALYTICS-03 (loop status) and BUG-ANALYTICS-04 (loop tokens), because loops compound every downstream wrongness; and BUG-ANALYTICS-06 (export parity), because it's the audit-grade surface.

**P1 — Correctness of headline numbers (provider-agnostic but visible to everyone):** BUG-ANALYTICS-18 (Top Tickets "Deleted" mislabel — affects *every* project), BUG-ANALYTICS-13/14 (timeline/hero under-report total vs Hero), BUG-ANALYTICS-19 (silent 100-row cap).

**P2 — Reconciliation & polish:** BUG-ANALYTICS-17 (top-tickets CSV columns), BUG-ANALYTICS-15 (scatter coverage), BUG-ANALYTICS-21 (UTC day labels), BUG-ANALYTICS-20 (refetch race), BUG-ANALYTICS-22/23 (filter chip / cross-project leak).

## 6. Suggested disjoint file-groups for a parallel fix workflow

Partitioned so each group owns a disjoint file set (no two groups edit the same file) — mirrors how `audit-fix-workflow.js` shards work. A follow-up fix workflow can be authored directly from this table.

| Group key | Files (owned) | Bug IDs |
|-----------|---------------|---------|
| `capture-queue` | `server/queue-manager.ts` | BUG-ANALYTICS-01, 02 |
| `capture-loop` | `server/loop-run-manager.ts`, `server/loop-executors.ts` | BUG-ANALYTICS-03, 04, 07, 32 (started_at provenance) |
| `store-pricing` | `server/result-event.ts`, `server/pricing.ts` | BUG-ANALYTICS-05, 09 (server half) |
| `agg-spending` | `server/spending.ts`, `server/ai-invocations.ts` | BUG-ANALYTICS-08 (server), 12 (server), 18 (server half), 21 (server half), 29, 30, 31, 33, 34, 35 (server half), 36 (agg+modal) |
| `rest-export` | `server/project-router-spending.ts` | BUG-ANALYTICS-06, 16, 17, 18 (route enrichment), 19 (server half), 36 (summary-CSV + modal route halves) |
| `home-analytics` | `server/desktop-analytics.ts` | BUG-ANALYTICS-24, 25, 26, 27, 28 |
| `client-cards` | `client/src/components/analytics/ModelBreakdown.tsx`, `ProviderBreakdownCard.tsx`, `InvocationsTable.tsx`, `client/src/components/TicketSpendingLine.tsx` | BUG-ANALYTICS-08 (client), 09 (client), 10, 11, 12 (client), 19 (table notice), 29 (ModelBreakdown render), 30 (model click) |
| `client-quickexplore` | `client/src/components/analytics/QuickVsExploreCard.tsx` | BUG-ANALYTICS-33 (client `~` marker) |
| `client-charts` | `client/src/components/analytics/SpendingTimeline.tsx`, `SpendingHero.tsx`, `CostScatter.tsx`, `client/src/types/spending.ts` | BUG-ANALYTICS-13, 14, 15, 21 (client label), 34 (scatter truncation notice + type) |
| `client-home` | `client/src/pages/DesktopAnalyticsPage.tsx`, `client/src/components/StatusBar.tsx` | BUG-ANALYTICS-24, 25, 26, 28 (client estimated badges/footnote) |
| `client-page` | `client/src/pages/AnalyticsPage.tsx` | BUG-ANALYTICS-19 (cap), 20, 22, 23, 30 (model filter provider qualifier), 35 (cost-sorted table + footer) |

> Cross-group note: BUG-ANALYTICS-08, 09, 11, 12, 18, 19, 21, and the round-2 additions 24/25/26/28 (`home-analytics` → `client-home`), 29/30 (`agg-spending` → `client-cards`/`client-page`), 33 (`agg-spending` → `client-quickexplore`), 34 (`agg-spending` → `client-charts`), 35 (`agg-spending` → `client-page`), and 36 (`agg-spending` → `rest-export`) each touch both a server and a client/REST file. Sequence the server group first (it defines the new estimated/provider fields + truncation signals the client renders), then the client/REST group consumes them — keeps each group's edits disjoint within a wave while preserving the data dependency. The new `home-analytics` group (`server/desktop-analytics.ts`) is fully disjoint from `agg-spending` (`server/spending.ts`/`ai-invocations.ts`) despite needing the *same* estimated-cost split, so they can land in parallel.

## 7. Completeness round 2 — gaps the first pass missed

A second adversarial completeness pass (same ≥2-of-3 confirmation bar, anchors re-verified against the live tree) surfaced **13 additional confirmed bugs** the first round did not cover, almost entirely because round 1 audited only the per-project `/analytics` pipeline (`spending.ts` → `project-router-spending.ts` → `client/.../analytics/*`) and never opened the **HOME / cross-project rollup** (`server/desktop-analytics.ts`, feeding `DesktopAnalyticsPage` + the always-visible `StatusBar` + `/api/state`). That whole surface re-derives cost from the `jobs` table with **none** of the estimated-vs-authoritative discipline `spending.ts` already carries — so the highest-visibility cost numbers in the app (today's spend in the status bar) silently present rate-card-estimated codex/gemini cost as billed fact. The round also found a provider-collapse in `byModel`, a `started_at` provenance bug in loop capture, recency-capped outlier charts, and a multi-surface Top-Tickets title gap with one shared server-side fix.

These continue the sequence as **BUG-ANALYTICS-24 … 36**. Codex/Gemini-related bugs are marked **⊛ codex**. The two highest-impact codex clusters — the `desktop-analytics.ts` cross-project rollup (24–28) and the `byModel` provider-collapse (29–31) — lead.

> Counts: +13 confirmed (4 Medium, 8 Low, 1 Info). Round-2 grand total across the report: **38 confirmed** (the §1 table's 25 + these 13). No new High-severity. The round-2 additions are concentrated on two never-before-audited surfaces (the HOME rollup and the `byModel` aggregation) plus three precision gaps (loop `started_at`, recency-capped outlier charts, Top-Tickets title fan-out).

### Cluster A — `server/desktop-analytics.ts` cross-project (HOME) rollup presents estimated codex/gemini cost as billed fact

> Root cause shared by 24–28: `desktop-analytics.ts` sums `COALESCE(SUM(total_cost_usd),0)` from the `jobs` table with **zero** awareness of `jobs.total_cost_usd_estimated` (db.ts migration 27; set to `1` at `db.ts:949` for non-native-cost providers). `grep total_cost_usd_estimated server/desktop-analytics.ts` → 0 hits. The per-project `spending.ts` already does this split correctly (`:241`, `:464-484`) and drives an "Includes estimated costs" footnote; the cross-project rollup loses it entirely. The `jobs` table also has no provider/engine column (engine lives on `rails.ai_engine`), so this surface cannot even attribute cost to an engine. **The single shared fix** is to add a `CASE WHEN total_cost_usd_estimated=1 THEN total_cost_usd ELSE 0 END` split to `queryProjectKpi`, `queryProjectTimeline`, and `getDesktopTodayStats`, thread an `estimatedCostUsd` through, and surface a badge/footnote on `DesktopAnalyticsPage` + `StatusBar`.

#### BUG-ANALYTICS-24 ⊛ codex — HOME grand-total KPIs (`totalCostUsd` / `costToday`) blend authoritative + estimated cost as fact
- **Severity:** Medium · **Layer:** aggregation
- **File:** `server/desktop-analytics.ts:93, 148, 151, 179, 183`
- **What's wrong:** `queryProjectKpi` sums `COALESCE(SUM(total_cost_usd),0)` (`:93`) with no split on `total_cost_usd_estimated`. The per-job `jobs.total_cost_usd_estimated` column (set to `1` at `db.ts:949` for codex/gemini rate-card estimates) is never read in this file. The summed `kpi.totalCostUsd` and `todayKpi.totalCostUsd` accumulate into the grand-total `totalCostUsd` (`:148`) and `costToday` (`:151`) returned in the `kpi` object (`:179, :183`).
- **Impact:** On any project that ran codex/gemini rails, the HOME `totalCostUsd` and `costToday` present a number that is part provider-billed (claude, authoritative) and part rate-card guess (codex/gemini) with no way to tell which. The single-project Analytics page splits `estimatedCostUsd`/`byProvider` and shows an "Includes estimated costs" footnote; the cross-project rollup loses that entirely. `DesktopAnalyticsPage.tsx:19-20` renders these as exact dollars (`$${kpi.totalCostUsd.toFixed(4)}`, `$${kpi.costToday.toFixed(4)}`) with no estimated badge — an estimate misrepresented as a billed fact.
- **Trigger:** Create a project with a codex (or gemini) provider, run an implement rail (writes a `jobs` row with `total_cost_usd` from `server/pricing.ts` and `total_cost_usd_estimated=1`), open the HOME / desktop analytics.
- **Fix:** Mirror `spending.ts`: compute `COALESCE(SUM(CASE WHEN total_cost_usd_estimated=1 THEN total_cost_usd ELSE 0 END),0)` alongside the authoritative sum in `queryProjectKpi`, thread an `estimatedCostUsd` total into the `kpi` response, and surface an "Includes estimated costs" footnote in `DesktopAnalyticsPage` when `estimatedCostUsd>0`. Same for `getDesktopTodayStats`.

#### BUG-ANALYTICS-25 ⊛ codex — Per-project breakdown rows present estimated cost as authoritative and rank projects by blended cost
- **Severity:** Low · **Layer:** aggregation
- **File:** `server/desktop-analytics.ts:154-161, 174`
- **What's wrong:** `projectBreakdown[].totalCostUsd` is set straight from `kpi.totalCostUsd` (`:157`) — the same unsplit `COALESCE(SUM(total_cost_usd))`, with no estimated/authoritative distinction and no provider field. Projects are then sorted by this blended `totalCostUsd` (`:174`). `DesktopAnalyticsPage.tsx:141` renders each as `$${p.totalCostUsd.toFixed(4)}` with no badge.
- **Impact:** A project that ran mostly codex/gemini (estimated cost) is compared head-to-head and ranked against a claude project (billed cost) as if both numbers were equally authoritative. The "top spending project" ordering and per-project dollar figures can be driven by rate-card estimates presented as fact. No provider segmentation is even available — the `jobs` table has no provider/`ai_engine` column.
- **Trigger:** Two projects, one claude-only and one codex-only with comparable token usage; the codex project's estimated cost competes for the top breakdown slot with an exact dollar figure.
- **Fix:** Add `estimatedCostUsd` (and ideally `authoritativeCostUsd`) to `DesktopProjectStats` + `queryProjectKpi` via the same CASE-WHEN split; render an estimated badge per project row in `DesktopAnalyticsPage`. Optionally rank on authoritative+estimated but mark estimate-heavy rows.

#### BUG-ANALYTICS-26 ⊛ codex — Cost timeline blends estimated + authoritative per-day cost with no split
- **Severity:** Medium · **Layer:** aggregation
- **File:** `server/desktop-analytics.ts:110, 164, 169-171`
- **What's wrong:** `queryProjectTimeline` sums `COALESCE(SUM(total_cost_usd),0)` per day (`:110`) with no `total_cost_usd_estimated` split; these per-day costs are merged across all projects into `timelineMap` (`:164`) and returned as `costTimeline` (`:169-171`). `DesktopAnalyticsPage` renders this as a `$`-denominated chart (`toFixed(2)`/`toFixed(4)`) with no estimated indication.
- **Impact:** Days on which codex/gemini rails ran show a cost silently mixing billed and rate-card-estimated dollars, charted as a single authoritative-looking series — consistent with the KPI/breakdown findings: the whole HOME surface treats an estimate as fact.
- **Trigger:** Run codex rails on a given day, view the HOME cost timeline; that day's bar includes the estimate as if billed.
- **Fix:** Stack the timeline into authoritative-vs-estimated series (preferred, mirrors the per-project Daily Timeline), or at minimum compute an estimated portion so the chart can annotate it.

#### BUG-ANALYTICS-27 ⊛ codex — `getDesktopTodayStats` (StatusBar + `/api/state costToday`) reports estimated cost as a billed figure
- **Severity:** Medium · **Layer:** aggregation
- **File:** `server/desktop-analytics.ts:250, 254`
- **What's wrong:** `getDesktopTodayStats` sums `COALESCE(SUM(total_cost_usd),0)` (`:250`) across every project with no `total_cost_usd_estimated` split, returning `costToday` (`:254`). This feeds the always-visible `StatusBar` (`client/src/components/StatusBar.tsx:9` `costToday`) and `/api/state` (`server/desktop-router.ts:555`) — the most prominent cost number in the app.
- **Impact:** The persistent header / today cost — the figure most likely to be read as "what I spent today" — silently includes rate-card estimates for codex/gemini as if provider-billed, with no badge anywhere on that surface. This is the **highest-visibility** instance of the codex-cost misrepresentation.
- **Trigger:** Run a codex rail today, observe the StatusBar `costToday`: it adds the estimated cost as an exact dollar amount alongside claude's billed cost.
- **Fix:** Add an `estimatedToday` field via the CASE-WHEN split and surface an estimate indicator on the StatusBar / `/api/state` consumer, or at minimum annotate that `costToday` may include estimates.

#### BUG-ANALYTICS-28 ⊛ codex — KPI cost averages/totals include failed/aborted jobs (no status filter), diverging from the per-project surface
- **Severity:** Low · **Layer:** aggregation
- **File:** `server/desktop-analytics.ts:91-98, 34` (consumer: `DesktopAnalyticsPage.tsx:34`)
- **What's wrong:** `queryProjectKpi` has no status filter — `SUM(total_cost_usd)` covers ALL rows including `status='failed'`/`'aborted'`. `DesktopAnalyticsPage.tsx:34` derives cost-per-job as `totalCostUsd / kpi.totalJobs` where `totalJobs = COUNT(*)` of all statuses. The per-project `spending.ts:246` deliberately excludes failed/aborted from cost averages (`AVG(CASE WHEN status='success' …)`) while still counting them in `totalRuns`.
- **Impact:** Failed jobs normally have NULL cost (→0) so the total is usually unaffected, but a failed **codex/gemini** job CAN carry an estimated rate-card cost (`total_cost_usd` populated, `total_cost_usd_estimated=1`) — inflating the grand total and the per-job average. The denominator (`COUNT(*)` including failures) also diverges from the per-project page's averaging convention, so HOME avg-cost-per-job and the single-project page disagree on the same data.
- **Trigger:** A codex rail that fails after emitting partial usage gets an estimated cost on a failed row; HOME `totalCostUsd` and avg-cost-per-job include it, while the single-project Analytics excludes it from averages.
- **Fix:** Align with `spending.ts`: exclude failed/aborted from the cost SUM/averages (`SUM(CASE WHEN status NOT IN ('failed','aborted') THEN total_cost_usd ELSE 0 END)`) while keeping `COUNT(*)` for run totals, so HOME and per-project averages agree.

### Cluster B — `byModel` collapses the provider + estimated dimensions into one ranking

> Root cause shared by 29–31: `getSpending`'s `byModel` aggregation (`spending.ts:271-286`) folds rows into `modelTotals` keyed on the **bare** `model` string alone, summing `total_cost_usd` with no `provider` column and no `total_cost_usd_estimated` split. The parallel `byProvider` query (`:464-484`) DOES carry `provider` and splits authoritative-vs-estimated, proving the schema supports it — `byModel` just discards both. **The single shared fix** is to key the `byModel` map (and the model filter) on `(provider, model)` and split the cost SUM.

#### BUG-ANALYTICS-29 ⊛ codex — `byModel` chart mixes codex/gemini estimated spend with claude authoritative spend in one ranking
- **Severity:** Low · **Layer:** aggregation
- **File:** `server/spending.ts:271-286`
- **What's wrong:** `getSpending` builds `modelRows` via `GROUP BY model, surface` (`:274`), then folds them into `modelTotals` keyed on `r.model` ALONE (`:276-282`), summing `total_cost_usd` with no provider column and no `total_cost_usd_estimated` split. The resulting `ByModelEntry { model, count, costUsd }` (`:26`) carries no provider field. Because codex/gemini rows are written `total_cost_usd_estimated=1` (pricing.ts fallback) while claude rows are `estimated=0` (native cost), the By Model bars silently rank a codex `gpt-5.5` bar (rate-card estimate) against a claude `sonnet` bar (authoritative) with no per-model "estimated" indicator and no provider attribution.
- **Impact:** `ModelBreakdown.tsx:18-42` renders each `m.model` with only `$cost · count` — no provider, no estimated footnote (unlike the Hero which surfaces `totalEstimatedCost`). A user reading the By Model chart cannot tell that a row's cost is an estimate vs a billed figure, and cannot distinguish two providers' usage. Always-on for any multi-provider project, not an edge case.
- **Trigger:** On a multi-provider project, run one claude job (model `sonnet`, authoritative cost) and one codex job (model `gpt-5.5`, estimated cost); `GET /spending` → `byModel` returns two entries with no provider/estimated fields; the By Model block shows them ranked together as comparable.
- **Fix:** Carry `provider` into the `byModel` map key and onto `ByModelEntry` (e.g. `{ provider, model, count, costUsd, estimatedCostUsd }`): key the merge on `` `${r.provider} ${r.model}` `` (select `COALESCE(provider,'claude')`), split SUM into authoritative-vs-estimated via `CASE WHEN total_cost_usd_estimated`. Update `ByModelEntry`, `ModelBreakdown.tsx` (provider prefix/badge + estimated indicator), and the click-to-filter to pass `provider` alongside `model`.

#### BUG-ANALYTICS-30 ⊛ codex — Cross-provider model-id collision double-attributes spend into one `byModel` bar and one filter bucket
- **Severity:** Low · **Layer:** aggregation
- **File:** `server/spending.ts:276-282` (+ filter at `:180-184`; client click at `client/src/pages/AnalyticsPage.tsx:320`)
- **What's wrong:** Because `modelTotals` is keyed on the bare `model` string, if two providers ever store the SAME model id (the column is free-form: claude `normaliseModel` falls through to `model || 'sonnet'` at `claude-adapter.ts:45-46` for unknown strings, and codex/gemini stamp whatever requested `--model` string was passed — neither is constrained to its catalog), their rows MERGE into a single `byModel` entry. Cost from both providers sums under one label with no disambiguation. The default catalogs (sonnet/opus/haiku vs gpt-5.x vs gemini-*) are value-disjoint, so this is NOT reachable with stock model selections — it requires a custom/free-form model string (per-agent profile override or an arbitrary `--model`) that matches across providers.
- **Impact:** A merged bar shows a single cost that is the sum of two providers' spend under one ambiguous label, and click-to-filter (`ModelBreakdown.tsx:35` → `filters.model` → `buildWhere` on model alone, `:180-184`, no provider constraint) pulls invocations from BOTH providers into the filtered table — a wrong, double-counted attribution with no way for the user to see it.
- **Trigger:** Configure (via profile/per-agent model or arbitrary `--model`) the same free-form model string for a claude and a codex/gemini invocation, run both, open By Model — both providers' cost collapses into one bar; clicking it filters the table to a mix of both providers.
- **Fix:** The same fix as BUG-ANALYTICS-29 resolves this completely: keying the `byModel` aggregation (and the model filter) on `(provider, model)` instead of model alone eliminates the cross-provider merge regardless of id collision.

#### BUG-ANALYTICS-31 ⊛ codex — Model filter + `byModel` aggregation are provider-blind (latent cross-provider blend, currently unreachable)
- **Severity:** Info · **Layer:** aggregation
- **File:** `server/spending.ts:180-184` (`buildWhere` model `IN`), `:272-284` (`byModel` `GROUP BY model`)
- **What's wrong:** `buildWhere` filters `filters.model` as `model IN (...)` with no provider column qualifier (`:180-184`), and the `byModel` breakdown groups by the bare `model` column alone (`GROUP BY model, surface`, `:272-284`). The client sets `filters.model=[m]` with that bare id (`AnalyticsPage.tsx:320`). If two providers ever shared a model id, (a) `byModel` would collapse both providers' rows into one, and (b) clicking that row would filter the WHOLE dashboard to BOTH providers' rows for that id. The provider clause (`:185-191`) is independent and would not save it (with no provider chip active, the model click selects both).
- **Impact:** Verified the collision is **NOT reachable today** (a defensive/latent finding, not an active bug): claude `normaliseModel` collapses to `sonnet`/`opus`/`haiku`/`claude-*`; codex stamps `gpt-*`; gemini stamps `gemini-*`. The three `modelCatalog()` id namespaces are disjoint, and `pricing.ts` is keyed `provider:model` (`pricing.ts:46-60`, e.g. `codex:gpt-5.5`, `gemini:gemini-3.5-flash`) confirming disjointness is the design intent. Every row's model is the provider's own spawned model (`result-event.ts:56-60` `fallbackModel`) drawn from that provider's catalog — no path stamps `sonnet` on a codex/gemini row. The defect is that the safety rests entirely on the accident of disjoint catalogs and is not enforced in SQL.
- **Trigger:** Hypothetical (not reachable today): seed `ai_invocations` with `model='X' provider='claude'` and `model='X' provider='codex'`; `GET /spending?model=X` returns both rows' cost in one `byModel` entry. No real catalog shares an id, so it cannot be reproduced with real provider output.
- **Fix:** Treat model identity as `(provider, model)` everywhere it is grouped or filtered — in `buildWhere` carry an aligned provider so the predicate becomes `(COALESCE(provider,'claude'), model) IN ((?,?),…)` (or a `provider:model` compound), and add `provider` to the `byModel` GROUP BY + `ByModelEntry` + the `ModelBreakdown` row/click payload. Makes the invariant explicit and codex/gemini-safe.

### Cluster C — precision / coverage gaps

#### BUG-ANALYTICS-32 ⊛ codex — Loop AI-step / Decider invocations stamp `started_at` at FINISH time, not start time
- **Severity:** Low · **Layer:** capture
- **File:** `server/loop-run-manager.ts:342` (`record()` helper, defined @ 310); called @ 432 (AI Step) / 491 (Decider) **after** the awaited step/decider resolve
- **What's wrong:** The `record()` helper writes `recordInvocation({ surface:'loop', started_at: new Date(this.now()).toISOString(), … })` using `this.now()` evaluated when `record()` runs. `record()` is invoked at `:432` (`record(\`loop:${runId}\`, res)`) AND `:491` (`record(\`loop:${runId}:decider\`, dec)`) AFTER `await this.executors.runAiStep(…)` / `await this.executors.runDecider(…)` have fully resolved — so `started_at` is captured at the step's FINISH instant, not when it began. The row sets no `finished_at`, so the real start is unrecoverable (only `durationMs` is consumed into totals, never persisted onto the row). Every `surface='loop'` row is stamped with the step's completion time.
- **Impact:** `spending.ts` buckets `dailyTimeline` by `substr(started_at,1,10)` and orders scatter/raw table `started_at DESC`. A loop AI step that genuinely starts near a day boundary (begins 23:58, a long `/specrails:implement` step finishes 00:03 next day) is bucketed into the wrong day, and because `started_at` is artificially the latest possible moment, the row jumps higher in the DESC ordering than its true start warrants. A multi-minute step is consistently mis-stamped by its whole duration. Applies to codex/gemini loop steps too (`provider: r.provider ?? req.provider`), so cross-provider loop spend is mis-bucketed/mis-ordered.
- **Trigger:** Run a loop whose AI step crosses local midnight or takes several minutes; the row's `started_at` equals the step's completion time (compare to `createJob`'s `started_at` at `:228`).
- **Fix:** Capture the start before the await: `const stepStart = new Date(this.now()).toISOString()` immediately before `await this.executors.runAiStep(…)` (and the decider await), thread it into `record()`, and set `started_at: stepStart` + `finished_at: new Date(this.now()).toISOString()`. Alternatively derive `started_at = finish - (r.durationMs ?? 0)` inside `record()` (since `r.durationMs` is already available) and set `finished_at` to the current now.

#### BUG-ANALYTICS-33 ⊛ codex — QuickVsExploreCard shows codex/gemini ESTIMATED per-spec cost as authoritative (no `~`, no footnote)
- **Severity:** Low · **Layer:** aggregation
- **File:** `server/spending.ts:339-377` (byMode query + mapping); consumed at `client/src/components/analytics/QuickVsExploreCard.tsx:59` (`fmtUsd(mode.avgCostPerSpec)`)
- **What's wrong:** The `byMode` aggregation sums `total_cost_usd` with no awareness of `total_cost_usd_estimated` and no provider split (unlike the Hero summary at `:241` which computes `totalEstimatedCost`, and `byProvider` at `:468-469` which splits authoritative-vs-estimated). `ByModeEntry` (`:56-65`) has no estimated/provider field. So when a quick-spec/explore-spec run is codex or gemini (`nativeCostUsd:false` → cost from the local pricing-table fallback, row flagged `total_cost_usd_estimated=1`), `avgCostPerSpec` and `totalCostUsd` in `byMode` are estimates, but the card renders them via `fmtUsd` exactly like an authoritative claude figure — "$0.123 per spec" with no `~`, no "estimated" label, no footnote.
- **Impact:** The user sees a precise dollar figure ("$X per spec") that is actually a synthetic pricing-table estimate, presented identically to provider-reported claude cost. The same data is correctly disclaimed elsewhere (Hero footnote, By Provider split), so this card is the lone surface that launders an estimate into an authoritative-looking number. The ratio line ("N× more per spec", `QuickVsExploreCard.tsx:109`) compounds it: if Quick runs are claude (authoritative) and Explore are codex (estimated), the headline ratio mixes a real cost with an estimated one and is presented as fact.
- **Trigger:** On a multi-provider project, author a spec via codex (or gemini) Quick mode and another via claude, open `/analytics`; the Quick column's "per spec" figure for the codex run is a pricing-table estimate shown as a plain "$X.XXX per spec".
- **Fix:** Extend `ByModeEntry` with `estimatedCostUsd` / `hasEstimated` (`SUM(CASE WHEN total_cost_usd_estimated=1 THEN total_cost_usd ELSE 0 END)` per surface, mirroring the summary at `:241`), then render a `~` prefix / estimated badge in `QuickVsExploreCard` when the mode's spec cost is estimate-derived, matching the Hero footnote treatment.

#### BUG-ANALYTICS-34 ⊛ codex — Cost-vs-turns scatter caps at 500 MOST-RECENT rows, silently dropping earlier high-cost outliers
- **Severity:** Medium · **Layer:** aggregation
- **File:** `server/spending.ts:380-401` (client: `client/src/types/spending.ts:91` `scatter`, `CostScatter.tsx:52` empty-state)
- **What's wrong:** The scatter query is `… WHERE … AND total_cost_usd IS NOT NULL ORDER BY started_at DESC LIMIT 500` (`:380-401`). The 500-row cap is applied purely by recency, not by cost. On a busy project whose window contains >500 priced invocations, only the 500 most-recent points reach the client; any expensive one-off run earlier in the window is excluded entirely. The whole purpose of the chart is to surface cost outliers (cost on Y), so the rows most worth seeing — the expensive ones — are exactly the ones dropped. There is NO truncation signal: `SpendingResponse.scatter` (`client/src/types/spending.ts:91`) is a bare `ScatterPoint[]` with no companion `truncated`/`totalAvailable`, and `CostScatter.tsx:52` only uses `data.scatter.length` for an empty-state check.
- **Impact:** A cost-outlier visualization that drops the highest-cost points without notice defeats its own purpose and actively misleads: a user scanning the scatter to find the run that blew their budget will not see it if it happened earlier than the last 500 invocations, and nothing on screen indicates the chart is incomplete.
- **Trigger:** On a project (especially multi-provider) with >500 priced `ai_invocations` in the period where the single most expensive run (e.g. a one-off codex/gemini job) is older than the 500th-most-recent row, open `/analytics`: the expensive point is absent and no truncation notice shows.
- **Fix:** Either (a) keep the recency cap but UNION-in the top-N-by-cost rows so the most expensive points always appear (or order/keep by `total_cost_usd DESC` for the outlier chart); and (b) return a scatter-truncation signal (`scatterTruncated: boolean` + count, mirroring `getInvocations`' `truncated`/`totalAvailable`) so `CostScatter` can render a "showing 500 of N — costliest may be hidden" notice.

#### BUG-ANALYTICS-35 ⊛ codex — Raw invocations table orders by recency under LIMIT, so the costliest rows can be off the first page with no truncation flag
- **Severity:** Low · **Layer:** aggregation
- **File:** `server/spending.ts:545-551` (truncation flag dead at `:591`)
- **What's wrong:** `getInvocations` computes `limit = cap ?? Math.min(filters.limit ?? 50, 200)` and runs `… ORDER BY started_at DESC LIMIT ? OFFSET ?` (`:548-551`). The table is sorted strictly by recency, so the default first page (50 rows) shows the most recent invocations, not the most expensive. Combined with the already-flagged truncation behaviour (`truncated: cap !== undefined && totalRow.total > cap`, `:591` — which only fires for the export `cap` path, NOT the paginated table where `cap` is undefined and `truncated` is therefore always false), a one-off expensive codex/gemini run earlier in the window never appears on the visible page and the paginated table shows no truncation flag at all.
- **Impact:** The raw table is the drill-down users reach for to find "what cost the most", but it is recency-ordered and its `truncated` flag is dead for the normal paginated path, so the most cost-relevant rows are neither shown nor signposted as missing. (Overlaps BUG-ANALYTICS-19's silent-cap finding but is the distinct *ordering* defect — even with a truncation notice the costliest row would still be off-page.)
- **Trigger:** On a project with >50 priced invocations where the most expensive run is older than the 50 most recent, open the raw table at default page size: the expensive row is not on page 1 and no truncation/total indication highlights it; `truncated` is false because `cap` is undefined.
- **Fix:** Offer a cost-sorted order (or default the raw table to `ORDER BY total_cost_usd DESC` for the outlier-hunting use case), and surface `totalAvailable` in the table footer even when `cap` is undefined so the user knows how many rows exist beyond the current page.

#### BUG-ANALYTICS-36 — Top-Tickets missing-title root cause compounds across card, summary-CSV export, and modal — one server-side enrichment fix covers all three
- **Severity:** Medium · **Layer:** aggregation
- **File:** `server/spending.ts:415` (card aggregation); `server/project-router-spending.ts:239-251` (summary-CSV Top-Tickets); `server/ai-invocations.ts:131-166` (modal endpoint)
- **What's wrong:** `getSpending()`'s `topTickets` aggregation hardcodes `ticketTitle: null` (`spending.ts:415`) and never reads the YAML ticket store to resolve titles — this is the root of BUG-ANALYTICS-18. The defect compounds in TWO downstream surfaces consuming the SAME data: (1) the CSV **summary** export "Top tickets" section (`project-router-spending.ts:239-251`) writes a header `ticketId,totalCostUsd,…` with NO `ticket_title` column and emits only `t.ticketId ?? '(unattributed)'` (`:243`) — a bare numeric id with no title; (2) the per-ticket modal endpoint `getTicketSpendingSummary` (`ai-invocations.ts:131-166`) selects only surface/status/cost/turns/duration/tokens and returns no title field. The asymmetry that proves the fix is known-good: the RAW export (`project-router-spending.ts:259-264`) and the `/invocations` table (`:143-151`) ALREADY enrich `ticket_title` from the YAML store (`store.tickets[String(r.ticket_id)]?.title`). Only the card aggregation, the summary-CSV Top-Tickets section, and the modal lack it.
- **Impact:** On the Analytics card the Top Tickets block shows numeric ids / blank titles instead of names; the same ids flow unlabeled into the summary-CSV "Top tickets" section (no title column whatsoever); and the modal's spending payload carries no title for cross-checking. A reviewer reconciling the summary CSV against the card hits both the BUG-ANALYTICS-18 missing label AND (per BUG-ANALYTICS-17) a partial column set, so the row is doubly unreconcilable to a human-readable ticket.
- **Trigger:** Create a ticket and run a job/quick-spec against it (so `ai_invocations` rows carry `ticket_id`). (2) `GET /spending` → `topTickets[].ticketTitle` is null. (3) `GET /analytics/export?mode=summary&format=csv` → the `# Top tickets` section has header `ticketId,…` with no title column. (4) `GET /tickets/:id/spending-summary` → response has no title field.
- **Fix:** Lift the existing store-read title enrichment (already in `project-router-spending.ts:144-150` for `/invocations` and `:260-263` for raw export) into a shared helper `enrichTicketTitles(store, rows|entries)`. Apply it at the `getSpending` aggregation boundary so `topTickets[].ticketTitle` is populated — that single change fixes the card AND, once `topTickets` carries the title, the summary-CSV consumer. Add a `ticketTitle` column to the CSV summary "Top tickets" header (`project-router-spending.ts:240`) and emit `csvEscape(t.ticketTitle ?? '')` per row. For the modal, resolve the title in the route handler (`project-router-spending.ts:160-171`) via the same `readStore(ticketPath(req))` call (since `getTicketSpendingSummary` takes only `db`+`ticketId` and can't read the store) and merge it onto the response. One store read, consistently applied = card + export + modal all show titles.
- **Note:** This is the cross-surface fan-out of BUG-ANALYTICS-18 (which captured only the card mislabel). Fix them together — the shared helper resolves both.

### Round-2 refuted

No round-2 findings were refuted. Every candidate in the completeness pass that cleared the ≥2-of-3 bar is recorded above as a confirmed bug; the pass produced no entries that the verifiers downgraded to disputed/needs-human-review.
