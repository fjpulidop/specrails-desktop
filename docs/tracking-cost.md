# Tracking cost

## What gets tracked

Every AI CLI call a project makes writes one `ai_invocations` row tagged with a **surface** (the closed list lives in `server/modules/accounting/runtime/ai-invocations.ts`). There are twelve:

| Surface | What it captures |
|---------|------------------|
| **`job`** | Every queued job: rail runs on the CLI pipeline (Implement, Freestyle), plus the AI steps of a local merge-back (verify / resolve-merge / fix) |
| **`loop`** | Every AI step of a Loop run (the built-in Implement / SDD Quick loops and your custom loops) |
| **`quick-spec`** | One-shot Quick spec generation (including a Quick-mode Contract Refine run) |
| **`explore-spec`** | Every Explore conversation turn (including the Explore Contract Refine run) |
| **`ai-edit`** | The **AI Edit / Refine** overlay (refining an agent or a ticket) |
| **`smash`** | SMASH runs that break an epic spec into sub-specs |
| **`file-summary`** | Code-explorer AI summaries and file stories |
| **`chat-sidebar`** | Turns in the project chat sidebar |
| **`spec-launcher`** | The OpenSpec fast-forward launcher that turns a spec into an OpenSpec change |
| **`proposal`** | Spec proposals (explore an idea, refine it with feedback) |
| **`agent-studio`** | Custom-agent generation and test runs in the Agents studio |
| **`setup`** | AI turns of the legacy setup/enrich chat (`/setup/start`, `/enrich/start`; used by API/MCP callers, not by the app UI) |

**Missions are tracked too, in a separate ledger.** Mission (agent chat) turns and their sub-agents record to the app-level `agent_invocations` table. A mission pinned to a project is folded into that project's Analytics next to the surfaces above; unpinned (Home) missions appear only in Desktop Analytics.

Adding a project does not spend tokens: the background workspace assembly runs specrails-core `init` offline and makes no model call.

> Cost averages exclude `failed`/`aborted` rows, but those rows still count toward the total run count and the failure rate.

## Authoritative vs estimated cost

Whether a cost figure is exact depends on the provider's CLI, not on which provider you picked:

- **Claude cost is provider-billed and authoritative** — the figure comes straight from the CLI's own usage report.
- **Codex do not report cost natively**, so the app **estimates** their cost from a local rate-card (`server/modules/accounting/runtime/pricing.ts`) using the captured token counts. Estimated rows are flagged: they render with a `~` tilde in the raw table (hover for the tooltip — *"Estimated from local pricing table — this provider does not report cost natively"*) and feed an "includes ~$X estimated" footnote in the Hero.

On multi-provider projects, a **Provider breakdown** card splits spend across the project's installed engines so you can see authoritative vs estimated at a glance.

> **Fail-soft on unknown models.** The rate card lists specific models (the current Codex catalogs). If an invocation uses a model that isn't in the table, the app **does not fabricate a number** — it stores no cost (`total_cost_usd` is left empty), so that row simply shows a blank cost rather than a misleading estimate.

## The Analytics page

Open **Analytics** from the project right sidebar.

### Sticky filter header

- **Period** — `7d`, `30d`, `90d`, or `All`. (There's no 24-hour or custom-range option here — the custom calendar range lives on Desktop Analytics, below.)
- **Surface** — chips for `All` plus Jobs, Explore, Quick, Refine, SMASH, File summaries and Loops. All surfaces (including the ones without a chip) are included by default; toggle chips to narrow the view.
- **Engine** — one chip per installed provider plus `All`. These appear **only on multi-provider projects** and let you filter activity by engine.

The period and surface filters are URL-synced, so you can share or bookmark a view.

### Hero burn meter

The big number at the top is total spend in the selected period, with:

- a `% vs prev` delta (the same period length ending where the previous interval ended),
- the invocation count and total token count,
- a per-surface cost breakdown bar with a legend (cost + count per surface),
- and, when any rows are estimated, an "includes ~$X estimated" footnote.

When the project has zero invocations in the period (e.g. you just started), the Hero shows "Tracking started YYYY-MM-DD" — the date of the first invocation ever recorded. There's no historical backfill; tracking begins at that first row.

### Daily stacked timeline

A daily bar chart for the period, stacked by surface. It plots seven series — **Jobs, Explore, Quick, Refine, File summaries, SMASH and Loops**. The smaller surfaces (chat sidebar, spec launcher, proposals, Agent Studio, setup) still count in the Hero total, the per-surface breakdown bar, Top models and the raw table. Days with zero activity are zero-filled so the x-axis stays regular.

Surface colours are consistent wherever a surface appears across the page:

- `job` → blue (`accent-info`)
- `quick-spec` → purple (`accent-secondary`)
- `explore-spec` → highlight (`accent-highlight`)
- `ai-edit` → green (`accent-success`)
- `smash` → highlight (`accent-highlight`)
- `file-summary` → yellow (`accent-warning`)
- `loop` → primary (`accent-primary`)

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

### Quick vs Explore card

Share-of-spend between Quick spec generation and Explore conversations, with a small sparkline. If Explore has fewer than 5 runs in the period, a CTA nudges you to try it.

### Top models

The top 10 models used in the period with their share of spend. Click a row to filter the rest of the page by that model.

### Cost-vs-turns scatter

A scatter plot of the last 500 invocations: x = turns, y = cost. Handy for spotting the outlier "this Explore session burned 4×" runs.

### Top tickets

The top 10 tickets by total spend across all surfaces, ranked by cost. Two special cases compete for those slots:

- **Deleted tickets** appear individually, one per ticket (e.g. `deleted ticket #42`) — invocations whose `ticket_id` no longer resolves.
- **Unattributed** is a single synthetic bucket for invocations with no `ticket_id` (mostly mid-Explore turns before commit).

Neither is pinned — they show up only when they rank into the top 10.

### Raw invocations table

At the bottom of the page. It loads up to 100 rows in one batch and shows a "Showing first N of M matching rows" note when there are more. Secondary filters scoped to the table only (a narrower date range, status, and minimum cost) let you drill in.

Columns: **Surface, Ticket, Cost, Turns, Tokens, Model, Status, Started.**

A few rendering details to know:

- Contract Refine invocations show as **Contract Layer** in the Surface column and "Contract Layer refinement" in the Ticket column.
- Uncommitted Explore turns show a provisional, italicised title derived from the first user message — these are tickets that aren't committed yet.

## Per-ticket spending

Inside any spec's detail modal there's a one-line spending summary just below the title:

```
$0.42 · 3 turns · 4m 12s active · 2 jobs + 1 explore
```

The breakdown segment is a **count** of invocations per surface, not a cost split. Clicking the line opens Analytics filtered to that ticket (`?ticketId=<id>` in the URL).

## Exports

Top-right of the Analytics page → the **Export** dropdown. Four options:

| Export | Format | What's included |
|--------|--------|-----------------|
| **Summary CSV** | Multi-section CSV | Totals, daily timeline, by-surface, by-model, top tickets |
| **Summary JSON** | JSON | Same data, structured |
| **Raw CSV** | CSV | One row per invocation, capped at 10,000 rows |
| **Raw JSON** | JSON | Same |

Filename patterns differ by mode: Summary exports use `<project-slug>-analytics-<period>-<YYYY-MM-DD>.{csv,json}`; Raw exports use `<project-slug>-invocations-<period>[-<surface>]-<YYYY-MM-DD>.{csv,json}` — the optional `-<surface>` segment appears only on raw exports.

Raw exports above 10,000 rows append a `# truncated_at=N of M` comment line. If you need more, narrow the period or surface filter first.

Exports use the standard `fetch → Blob → URL.createObjectURL → anchor.click()` pattern, so they work the same in the Tauri desktop webview as in a browser. On failure a sonner `Export failed` toast surfaces.

## Setting a budget

Open **Settings** from the project right sidebar → the **Budget** card:

- **Daily budget (USD)** — the app auto-pauses the queue when the day's spend reaches this. While it is exhausted, rail launches are refused (nothing starts) and running loops pause at the next step boundary; in-flight steps aren't killed.
- **Per-job cost alert (USD)** — emits an alert when a single job exceeds this amount.

Leave either field blank to disable that limit.

When the daily budget is hit, a dismissible banner appears across the project pages ("Daily budget exceeded — … Queue is paused.") and the queue stays paused server-side. Resume by raising the budget, clearing it, or waiting for the counter to reset at midnight (it counts completed-job cost since the start of the current calendar day, not a rolling 24-hour window).

### Rails and loops over budget

Rail launches and loop runs check the same project and app-wide budgets the queue enforces:

- **Launches are refused.** Play, Launch all, mission launch cards, Relaunch, the Loops page **Run**, MCP `launch`/`launch_all`, the mobile companion and milestone chains all receive `409 daily_budget_exceeded` with `scope` (`project` or `desktop`), `budgetUsd`, `spentUsd` and `resetsAt`. Nothing is spawned. The UI shows the amounts and where to raise the budget. Launch all counts these rails as "over the daily budget", not as failures. A milestone chain pauses with `launch_rejected:daily_budget_exceeded` and can be resumed.
- **Running loops pause at the next step.** When the budget runs out mid-run, Desktop asks Core to pause the workflow (Core with the `pauseRuns` capability; older Core checks only before the next step): the current step finishes and the run parks as `paused` with `restart_reason = budget_paused`. The run card and log show *Paused on the daily budget*. Raise or clear the budget, then press **Resume** (or `POST /api/projects/:id/loop-runs/:runId/resume`, or send any message to the run). If the budget is still exhausted, the resume returns the same 409 and the run stays paused. **Stop** settles the run as stopped. The pause does not use up the loop's wall-clock timeout.
- **Core workflows** schedule their steps inside one Core process, so Desktop gates them at the points it controls: at launch, at resume, and before it re-invokes Core after a question or approval. Core has no pause control yet, so a Core workflow that is already running finishes its current invocation.
- If the budget state can't be read, the launch is allowed (fail-open, same as the queue). The app-wide spend is the queue's figure: completed jobs since UTC midnight. The project spend counts every billed invocation since local midnight.

See [Customising the app](customizing.md#budget) for the full setup.

## App-wide analytics

For the cross-project view, open **Analytics** from the Arc sidebar on the left. Desktop Analytics is a separate page with its own blocks — KPI cards, a cost timeline, and per-project breakdowns — rolled up across all your registered projects. It also offers a custom calendar date range that the per-project page doesn't.

## Where to go next

- [Customising the app](customizing.md) — set the budget, configure notifications.
- [Creating specs](creating-specs.md) — every spec you create adds rows to your analytics.
- [Using Codex](codex.md) — how cost works when you run a project on Codex (estimated, ~ tilde).

## Legacy workflow usage

Project Analytics also shows recorded uses of classic loops, queued native
commands and local merge-back. This card covers all recorded history for the
project and is independent of spending filters. Refresh its counters to inspect
recent use; unavailable storage is shown as unavailable, never zero. A zero count
alone does not prove the two-release observation period required before retiring
legacy compatibility. These counts are execution observations, not billed costs.
