# Tracking cost

specrails-desktop records AI CLI invocations across Claude, Codex, Gemini, and Kimi and surfaces the available metrics on one Analytics page per project. This guide walks through what's tracked, what's unavailable, and how to read the dashboard.

## What gets tracked

Six surfaces, all per-project:

| Surface | What it captures |
|---------|------------------|
| **`job`** | Every rail run (the Architect → Developer → Reviewer → Ship pipeline, plus Freestyle and Batch runs) |
| **`quick-spec`** | One-shot Quick spec generation (including a Quick-mode Contract Refine run) |
| **`explore-spec`** | Every Explore conversation turn (including the Explore Contract Refine run) |
| **`ai-edit`** | The **AI Edit / Refine** overlay (refining an agent or a ticket) |
| **`smash`** | SMASH runs that break an epic spec into sub-specs |
| **`file-summary`** | Code-explorer AI summaries of individual files |

Each invocation row carries the provider, model, status, timestamps, duration,
and relevant ticket/conversation IDs. Token, USD-cost, and turn fields are
nullable because not every CLI reports them; Kimi leaves those values
unavailable rather than writing zero.

The surface list is app-wide, not a promise that every provider can spawn
every row type. Kimi records its agentic chats/Explore/rails/loops, but Quick
Spec, AI Edit, Contract Refine, SMASH/Re-SMASH, file summaries, construction
story, AI auto-title, Project Builder blueprint/milestone generation, Loop
Decider, and Agent Studio automation fail before spawn. Those rejected
requests create no invocation row; AI auto-title uses a deterministic fallback.

> Cost averages exclude `failed`/`aborted` rows, but those rows still count toward the total run count and the failure rate.

## Authoritative vs estimated cost

Whether a cost figure is exact depends on the provider's CLI, not on which provider you picked:

- **Claude cost is provider-billed and authoritative** — the figure comes straight from the CLI's own usage report.
- **Codex and Gemini do not report cost natively**, so the app **estimates** their cost from a local rate-card (`server/pricing.ts`) using the captured token counts. Estimated rows are flagged: they render with a `~` tilde in the raw table (hover for the tooltip — *"Estimated from local pricing table — this provider does not report cost natively"*) and feed an "includes ~$X estimated" footnote in the Hero.
- **Kimi reports neither token counts nor a native USD-cost envelope** in its
  stream. Specrails does not invent an estimate: cost and token cells stay
  unavailable.

On multi-provider projects, a **Provider breakdown** card splits spend across the project's installed engines so you can see authoritative vs estimated at a glance.

> **Fail-soft on unknown models.** The rate card lists specific models (the current Codex and Gemini catalogs). If an invocation uses a model that isn't in the table, the app **does not fabricate a number** — it stores no cost (`total_cost_usd` is left empty), so that row simply shows a blank cost rather than a misleading estimate.

## What's NOT tracked (intentionally)

- **Sidebar chat** — the general-purpose chat panel in the right sidebar. It spawns an AI process, including `kimi -p` when Kimi is selected, but isn't pipeline work, so the app excludes it from analytics by design.
- **Setup wizard** — the install/enrich flow when you add a project. It *does* spawn an AI CLI (a genuine model invocation), but it's an interactive one-time wizard rather than a repeatable pipeline job, so it's deliberately left uninstrumented.

If you want the absolute total of what an engine has cost you, your provider's
own console is the source of truth. This is especially important for Kimi,
whose CLI stream provides no billable usage envelope to Desktop.

## The Analytics page

Open **Analytics** from the project right sidebar.

### Sticky filter header

- **Period** — `7d`, `30d`, `90d`, or `All`. (There's no 24-hour or custom-range option here — the custom calendar range lives on Desktop Analytics, below.)
- **Surface** — chips for `All` plus each of the six surfaces (Jobs, Explore, Quick, Refine, SMASH, File summaries). All are included by default; toggle chips to narrow the view.
- **Engine** — one chip per installed provider plus `All`. These appear **only on multi-provider projects** and let you filter activity by engine.

The period and surface filters are URL-synced, so you can share or bookmark a view.

### Hero burn meter

The big number at the top is total spend in the selected period, with:

- a `% vs prev` delta (the same period length ending where the previous interval ended),
- the invocation count and total token count,
- a per-surface cost breakdown bar with a legend (cost + count per surface),
- and, when any rows are estimated, an "includes ~$X estimated" footnote.

When the project has zero invocations in the period (e.g. you just started), the Hero shows "Tracking started YYYY-MM-DD" — the date of the first invocation ever recorded. There's no historical backfill; tracking begins at that first row.

### Provider breakdown

On multi-provider projects, a dedicated card splits available spend across the
project's installed engines. It is data-driven, so Kimi appears even though its
cost is unavailable. Estimated Codex/Gemini totals carry a `~` tilde. The card
is hidden on single-provider projects.

### Daily stacked timeline

A daily bar chart for the period, stacked by surface. It plots five series — **Jobs, Explore, Quick, Refine, and File summaries**. SMASH spend is still tracked and shows up elsewhere (the Hero per-surface bar, Top models, and the raw table), but it is not currently a separate bar in this chart. Days with zero activity are zero-filled so the x-axis stays regular.

Surface colours are consistent wherever a surface appears across the page:

- `job` → blue (`accent-info`)
- `quick-spec` → purple (`accent-secondary`)
- `explore-spec` → highlight (`accent-highlight`)
- `ai-edit` → green (`accent-success`)
- `smash` → highlight (`accent-highlight`)
- `file-summary` → yellow (`accent-warning`)

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

- **Daily budget (USD)** — the app auto-pauses the queue when the day's spend (the sum of completed-job cost since midnight) exceeds this. New rail launches queue rather than start; in-flight jobs aren't killed.
- **Per-job cost alert (USD)** — emits an alert when a single job exceeds this amount.

Leave either field blank to disable that limit.

When the daily budget is hit, a dismissible banner appears across the project pages ("Daily budget exceeded — … Queue is paused.") and the queue stays paused server-side. Resume by raising the budget, clearing it, or waiting for the counter to reset at midnight (it counts completed-job cost since the start of the current calendar day, not a rolling 24-hour window).

See [Customising the app](customizing.md#budget) for the full setup.

## App-wide analytics

For the cross-project view, open **Analytics** from the Arc sidebar on the left. Desktop Analytics is a separate page with its own blocks — KPI cards, a cost timeline, and per-project breakdowns — rolled up across all your registered projects. It also offers a custom calendar date range that the per-project page doesn't.

## Where to go next

- [Customising the app](customizing.md) — set the budget, configure notifications.
- [Creating specs](creating-specs.md) — every spec you create adds rows to your analytics.
- [Using Codex](codex.md) — how cost works when you run a project on Codex (estimated, ~ tilde).
- [Using Gemini](gemini.md) — how cost works when you run a project on Gemini (also estimated, ~ tilde).
- [Using Kimi](kimi.md) — why Kimi duration/outcome are recorded while tokens and cost remain unavailable.
