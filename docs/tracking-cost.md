# Tracking cost

The in-app guide covers the Analytics page screen by screen: [Analytics & cost tracking](guide/en/insights/1-analytics-and-cost-tracking.md). This page is the reference for what is recorded, how it is categorised and how the caps are enforced.

## What gets tracked

Every AI CLI call a project makes writes one `ai_invocations` row tagged with a **surface** (the closed list is `Surface` in `server/modules/accounting/runtime/ai-invocations.ts`). Mission (agent chat) and Intent turns, and their sub-agents, record to the app-level `agent_invocations` ledger instead and appear as the virtual surfaces `mission` and `intent`; a turn is never counted in both ledgers.

Every surface belongs to exactly one of five **categories** (`server/modules/accounting/runtime/spend-categories.ts`), so the breakdown always adds up to the total:

| Category | Surfaces |
|---|---|
| **Implementation** | `job` (queued jobs, including local merge-back AI steps), `loop` (every AI step of a loop run) |
| **Missions** | `mission`, `intent` (agent ledger turns), `flow` (the Intent spec rewrite) |
| **Specs** | `quick-spec`, `explore-spec`, `ai-edit`, `smash`, `spec-launcher`, `proposal`, `triage` |
| **Code** | `file-summary` (code-explorer summaries and file stories) |
| **Support** | `failure-analysis`, `setup`, `agent-studio`, `chat-sidebar` |

An unknown surface written by a newer build lands in Support, so it is never dropped. A mission pinned to a project counts in that project's Analytics and caps; unpinned (Home) missions and Blueprint / Builder chats count only app-wide, where they form the **Home & Blueprint** row. Core v1 calls are attributed to the engine that actually ran them, not the project's default.

Adding a project does not spend tokens: the background workspace assembly runs specrails-core `init` offline and makes no model call.

> Cost averages exclude `failed`/`aborted` rows, but those rows still count toward the total run count and the failure rate.

## Authoritative vs estimated cost

Whether a cost figure is exact depends on the provider's CLI, not on which provider you picked:

- **Claude cost is provider-billed and authoritative** — the figure comes straight from the CLI's own usage report.
- **Codex do not report cost natively**, so the app **estimates** their cost from a local rate-card (`server/modules/accounting/runtime/pricing.ts`) using the captured token counts. Estimated rows are flagged: they render with a `~` tilde in the raw table (hover for the tooltip — *"Estimated from local pricing table — this provider does not report cost natively"*) and feed an "includes ~$X estimated" footnote in the Hero.

On multi-provider projects, a **Provider breakdown** card splits spend across the project's installed engines so you can see authoritative vs estimated at a glance.

> **Fail-soft on unknown models.** The rate card lists specific models (the current Codex catalogs). If an invocation uses a model that isn't in the table, the app **does not fabricate a number** — it stores no cost (`total_cost_usd` is left empty), so that row simply shows a blank cost rather than a misleading estimate.

## The Analytics page

Open **Analytics** from the project right sidebar. The page reads top to bottom: the total for the period, *Where the money went* (one row per category, expandable to its surfaces), the daily timeline, spend limits, engines and models, top specs, the raw invocations table and a collapsed *More breakdowns* group. Period, category, engine and surface filters are kept in the URL. The [guide page](guide/en/insights/1-analytics-and-cost-tracking.md) walks through each block; the two analyses below need more precision than the guide gives.

### Time to decision

How long deliveries wait for you. From the moment a delivery becomes reviewable (`on_review`), the card shows the **median** and **p90** time to the first human decision (Create PR, Discard, Merge locally — including a Create PR that failed) and to the merge (in-app local merge or the merge observed on GitHub), for the project and per loop, in the selected period.

Every instant is recorded once and never moved by a retry, a second click or a restart (first write wins). A delivery still waiting counts as **pending**; one without recorded instants — for example created before this metric existed — counts as **unknown**. Neither is ever counted as zero. Discarded deliveries count toward time to decision but never toward time to merge. The same data is available through `specrails_analytics` (`decision_times`).

### Loop economics

Compares your loops over the selected period. One row per loop (saved published loops with nothing delivered show **No data**):

| Column | Meaning |
| --- | --- |
| Delivered | Deliveries that reached review or beyond (on review, PR draft/ready/closed, merged, superseded, or discarded after review). Failed or still-building runs do not count. A multi-repository delivery counts once. |
| Merged / Discarded | Delivered changes that were merged / discarded; the discard rate is discarded ÷ delivered. |
| Cost / delivery | Average AI cost of delivered changes, attributed exactly like the delivery cost footer (the delivery's runs and their merge-resolver calls). Provider-reported cost is used as is; the share that comes from the pricing table is shown as *estimated*. Deliveries without any recorded cost are listed as *unpriced* and left out of the average — never counted as $0. |
| Decision / Merge | Median · p90, as in [Time to decision](#time-to-decision). |
| Reviews / Fixer rounds per delivery | Reviewer and fixer steps of the delivery's loop runs (automatic stall retries are not new rounds). Deliveries whose runs have no step log are unknown and do not lower the average. |
| Escaped defects | Bug tickets linked to the delivery that introduced them. Label a ticket `bug` and pick the delivery under **Regression of** when you create or edit it. Until any ticket in the project carries a link the column shows **No data**. |
| Requirements demonstrated / Triage accuracy | Reserved: they show **No data** until spec traceability and loop triage ship. |

**—** always means unknown. Revert commits on delivered branches are not detected automatically; link the regression ticket instead. The same data is available through `specrails_analytics` (`loop_economics`).

### Other blocks, per-spec cost and exports

Quick vs Explore, top models, the cost-vs-turns scatter, top specs, the raw table, the per-spec spending line and the four exports (summary and raw, CSV and JSON; raw capped at 10,000 rows with a `# truncated_at=N of M` line) are described in the [guide](guide/en/insights/1-analytics-and-cost-tracking.md).

## Setting a budget

Every cap is edited in **Analytics → Spend limits**: daily, weekly and monthly, per project and app-wide, plus the per-run soft cap. **Settings → Advanced** and **Project settings → Spend limits** only show the current daily cap with an **Open Spend limits** button. The per-job cost alert is a separate project setting.

When a cap is reached the queue pauses server-side, launches are refused and running loops park (below). Resume by raising or clearing the cap, or wait for the reset. Every cap counts the **local** day, week (from Monday) and month (from the 1st), and includes mission spend: the turns pinned to the project for a project cap, every turn for an app-wide cap.

### Rails and loops over budget

Rail launches and loop runs check the same project and app-wide budgets the queue enforces:

- **Launches are refused.** Play, Launch all, mission launch cards, Relaunch, the Loops page **Run**, MCP `launch`/`launch_all`, the mobile companion and milestone chains all receive `409 daily_budget_exceeded` with `scope` (`project` or `desktop`), `budgetUsd`, `spentUsd` and `resetsAt`. Nothing is spawned. The UI shows the amounts and where to raise the budget. Launch all counts these rails as "over the daily budget", not as failures. A milestone chain pauses with `launch_rejected:daily_budget_exceeded` and can be resumed.
- **Running loops pause at the next step.** When the budget runs out mid-run, Desktop asks Core to pause the workflow (Core with the `pauseRuns` capability; older Core checks only before the next step): the current step finishes and the run parks as `paused` with `restart_reason = budget_paused`. The run card and log show *Paused on the daily budget*. Raise or clear the budget, then press **Resume** (or `POST /api/projects/:id/loop-runs/:runId/resume`, or send any message to the run). If the budget is still exhausted, the resume returns the same 409 and the run stays paused. **Stop** settles the run as stopped. The pause does not use up the loop's wall-clock timeout.
- **Core workflows** schedule their steps inside one Core process, so Desktop gates them at the points it controls: at launch, at resume, and before it re-invokes Core after a question or approval. Core has no pause control yet, so a Core workflow that is already running finishes its current invocation.
- If the budget state can't be read, the launch is allowed (fail-open, same as the queue). Both the project and the app-wide spend count every billed invocation, including mission turns, since local midnight.

### Weekly, monthly and per-run caps

Besides the daily budget, **Analytics ▸ Spend limits** sets a **weekly** and a **monthly** cap, per project and app-wide, and a **per-run soft cap** ("pause and ask at $X"). Weeks start on Monday and months on the 1st, in your local time. Weekly and monthly caps are enforced by the very same gate as the daily budget: launches are refused with `409 daily_budget_exceeded` (the body names the `period`), queues pause and running loops park as `budget_paused`. The per-run cap pauses one run **before an AI step** that is expected to take it past the cap (the step's own earlier turns in the run, else its median over the project's recent runs on the same provider and model, else a rate-card estimate of a typical turn of its kind), and when its reported cost reaches the cap; the 409 / pause body then carries `nextStep` (`label`, `usd`, `basis`, `samples`) and `remainingUsd`. **Resume** asks you to run that step once (`{ "runCap": "once" }`), continue without the cap (`{ "runCap": "ignore" }`) or raise it (`{ "runCapUsd": n }`). Reaching a cap also puts a **Raise cap** item in the inbox.

The panel shows today, this week and this month against each cap, a month-end **projection** (an estimate: the average of the last 14 completed days times the days left, plus what is spent so far; it is never added to billed spend) and a **What-if** pricer that re-prices the last 30 days of recorded token usage on another model with the app's price list (a model without a price says so). On a subscription plan there is no per-use dollar cost, so the panel shows turns and plan limits instead of dollars.

## App-wide analytics

For the cross-project view, open **Analytics** from the left sidebar or the command palette. Desktop Analytics counts app-ledger turns in every figure (KPIs, timeline, per-project rows), uses the same categories, colours and estimated hatching as the project page, groups turns of no loaded project in one **Home & Blueprint** row, and offers a custom calendar date range.

## Where to go next

- [Customising the app](customizing.md) — themes, settings and telemetry.
- [Creating specs](creating-specs.md) — every spec you create adds rows to your analytics.
- [Using Codex](codex.md) — how cost works when you run a project on Codex (estimated, ~ tilde).

## Legacy workflow usage

Project Analytics also shows recorded uses of classic loops, queued native
commands and local merge-back. This card covers all recorded history for the
project and is independent of spending filters. Refresh its counters to inspect
recent use; unavailable storage is shown as unavailable, never zero. A zero count
alone does not prove the two-release observation period required before retiring
legacy compatibility. These counts are execution observations, not billed costs.
