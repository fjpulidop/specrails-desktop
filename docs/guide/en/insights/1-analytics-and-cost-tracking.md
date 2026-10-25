# Analytics & cost tracking

Every time Specrails runs an AI CLI on your behalf — a pipeline job, a quick spec, an Explore session, an AI edit, a file summary — it records what happened: which model ran, how many tokens went in and out, how long it took, and what it cost. The **Analytics** section turns all of that into a single dashboard so you always know where your AI spend is going.

Open it from the right sidebar (it's labelled **Analytics**). Everything you see is scoped to the project you're currently in — switch projects and the numbers follow.

## What counts as spend

Specrails tags every AI run with a *surface*: the part of the app that spent it. The main surfaces each get a consistent colour and a filter chip, so you can spot them at a glance:

- **Job** — a queued pipeline job (Architect → Developer → Reviewer → Ship), including Freestyle runs.
- **Loop** — each AI step of a loop run. Rails run as loops by default, so most rail spend lands here.
- **Quick spec** — a spec generated through the fast Add Spec path.
- **Explore spec** — an Explore conversation where you shape a spec by chatting.
- **AI edit** — an AI-assisted refine on an agent or file.
- **SMASH** — splitting an epic spec into smaller specs.
- **File summary** — the plain-language summaries and file stories that power the Code explorer.

Smaller surfaces are tracked as well, without a chip of their own: the chat sidebar, the OpenSpec spec launcher, spec proposals, Agent Studio and the legacy setup chat. Missions pinned to the project count toward its spend too. Nothing that runs an AI CLI is left out, so the totals reflect all of the project's AI activity.

## Reading the dashboard

The page is built from a handful of blocks, top to bottom:

### The burn meter (Hero)

The big number at the top is your total spend for the selected period, with a **vs prev** delta so you can tell at a glance whether you're trending up or down compared to the previous window. If you've only just started using a project, the empty state tells you when tracking began ("Tracking started YYYY-MM-DD") — there's no historical backfill, so the meter only knows about runs that happened while you were on this version.

### Daily timeline

A stacked bar chart of spend per day, broken down by surface. Days with no activity are shown as zero rather than skipped, so the shape of your week is honest. This is the fastest way to see *when* a costly batch ran.

### Quick vs Explore

A side-by-side card comparing your two spec-creation styles. If you've run fewer than five Explore sessions, it shows a gentle call-to-action instead of misleading averages — small samples don't make for trustworthy comparisons.

### By model

Your top models by spend (up to ten). Click any model to filter the whole dashboard down to just that model — handy when you want to know how much a particular high-end model is really costing you.

### Cost vs turns scatter

Each point is one invocation, plotting cost against the number of turns. Outliers — the expensive, many-turn runs — jump right out. (The scatter shows your most recent 500 points to stay responsive.)

### Top tickets

Your ten most expensive tickets across *all* surfaces combined, so a ticket that cost a little in Explore and a lot in a job shows its true total. Deleted tickets and unattributed runs get their own buckets so nothing silently vanishes from the totals.

### Raw invocations table

The ground truth: one row per invocation. This block has its own secondary filters that only affect the table, so you can drill in without disturbing the charts above.

## Filtering

The sticky header at the top carries the two primary filters — **period** and **surface** — and both are saved into the page URL. That means you can bookmark or share a filtered view ("last 30 days, jobs only") and it'll reopen exactly as you left it. The raw table's filters are separate and stay local to that block.

A note on accuracy: failed and aborted runs are kept out of *cost averages* (they'd skew the per-run numbers) but they still count toward your total run count and failure rate. So the averages stay clean while the reliability picture stays complete.

## Per-ticket cost

You don't have to come to the Analytics page to see what a spec cost. Open any ticket and, if it has any spend attached, you'll see a one-line summary right under the title:

> $0.42 · 6 turns · 1m 12s active · breakdown

Click it and you land on the Analytics page already filtered to that ticket. It's the quickest path from "what did this feature cost me?" to the full breakdown.

## Exporting your data

When you need the numbers outside the app — a spreadsheet, a finance report, your own analysis — use the **Export** dropdown. It offers four formats:

- **Summary CSV** — a multi-section file with totals, the daily timeline, by-surface, by-model, and top tickets.
- **Summary JSON** — the same summary, structured.
- **Raw CSV** — every invocation row (up to 10,000; it notes if it had to truncate).
- **Raw JSON** — the same raw rows, structured.

Exports respect whatever period and surface filters you currently have applied, and files are named so they sort sensibly: `<project>-analytics-<period>-<date>.csv`. The button is disabled when there's nothing to export, and you'll get a clear error toast if a download fails.

## Staying live

You don't need to refresh. When a new invocation is recorded anywhere in the project, the open dashboard quietly refetches itself a moment later, so the burn meter keeps pace with work as it finishes.

## Daily budgets {#daily-budget}

Set a daily budget to cap what a day can cost. The app-wide budget lives in **Settings → Advanced**; a per-project budget lives in **Project settings → Budget**.

When the day's recorded spend reaches a budget, the queue pauses itself, rails and loop runs refuse to launch with *Daily budget reached*, and a loop run already in progress parks between steps, paused at the budget. Raise or clear the budget, or wait for the daily reset, and then resume.

The project budget counts your local day; the app-wide budget counts the UTC day. The per-job cost alert is a separate setting.

**Weekly, monthly and per-run caps.** Longer caps work the same way. Open **Analytics → Budget** to set a **weekly** and a **monthly** cap, per project and for the whole app, and a **per-run soft cap** (*pause and ask at $X*). Weeks start on Monday and months on the 1st, in your local time. A weekly or monthly cap pauses queues, refuses launches and parks running loops exactly like the daily budget; raise or clear it there, or wait for the reset. When a run's own reported cost reaches the per-run cap it pauses, and **Resume** asks whether to continue without the cap or raise it. Reaching any cap also adds a **Raise cap** item to the inbox.

The Budget panel shows today, this week and this month against each cap. Its month-end **projection** is an estimate (the average of the last 14 completed days times the days left, plus what you have spent), never added to billed spend. **What-if** re-prices the last 30 days of recorded token usage on another model with the app's price list, and says *No pricing* for a model it has no price for. On a subscription plan there is no dollar cost per use, so the panel shows turns and plan limits instead of dollars.
