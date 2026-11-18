# Analytics & cost tracking

Every time Specrails runs an AI CLI on your behalf — a pipeline job, a quick spec, an Explore session, an AI edit, a file summary — it records what happened: which model ran, how many tokens went in and out, how long it took, and what it cost. The **Analytics** section turns all of that into a single dashboard so you always know where your AI spend is going.

Open it from the right sidebar (it's labelled **Analytics**). Everything you see is scoped to the project you're currently in — switch projects and the numbers follow.

## What counts as spend

Every AI call in the project counts: pipeline jobs and loop steps, spec writing, file summaries, side chats, failure diagnosis, and the missions and Intent turns you run with the agent while it is pinned to this project. Missions on Home (no project pinned) belong to no project and are not counted here.

Each call is tagged with the *surface* that spent it, and every surface belongs to one of five **categories** that say *why* the money was spent:

- **Implementation** — building specs with rails, loops and jobs.
- **Missions** — talking to the agent and Intent mode (mission turns, Intent turns and the Intent spec rewrite).
- **Specs** — writing and refining specs: Quick and Explore specs, refine, split, the spec launcher, proposals and triage.
- **Code** — explaining the code: file summaries and file stories.
- **Support** — setup, diagnosis and side chats: failure analysis, setup, Agent Studio and the chat sidebar.

## Reading the dashboard

The page reads top to bottom as *how much → on what and why → when → with which models → the individual calls*.

### How much (Hero)

The big number at the top is your total spend for the selected period, with a **vs prev** delta so you can tell at a glance whether you're trending up or down compared to the previous window. When every engine is on a subscription plan, the figure is labelled an *API-equivalent estimate*: what the calls would cost at API prices, not money that was charged. If you've only just started using a project, the empty state tells you when tracking began.

### Where the money went

One row per category with its cost, its share of the total, the number of calls and tokens, and a one-line reason. The hatched part of a bar is estimated cost (engines that don't report cost natively). Open a category to see the surfaces it is made of, and click one to filter the whole page to it. The Missions category also lists your costliest conversations.

### Daily timeline

A stacked bar chart of spend per day, broken down by surface, with missions in their own colour. Days with no activity are shown as zero rather than skipped. This is the fastest way to see *when* a costly batch ran.

### Spend limits

Your daily, weekly, monthly and per-run caps, the month-end projection and the what-if re-pricing (see below).

### Engines and models

Spend per engine (on projects with more than one) and your top models by spend. Click any model to filter the whole dashboard down to just that model.

### Top specs

Your ten most expensive specs across *all* surfaces combined, so a spec that cost a little in Explore and a lot in a job shows its true total. Mission turns carry no spec, so they are not listed here.

### Raw invocations table

The ground truth: one row per call. The **Why** column shows the surface and its category; mission and Intent rows show the conversation they belong to. This block has its own secondary filters that only affect the table.

### More breakdowns

Collapsed by default: time to decision and merge, loop economics, the cost vs turns scatter and the Quick vs Explore comparison.

## Filtering

The sticky header carries the primary filters — **period**, **category** and (on multi-engine projects) **engine** — and all of them are saved into the page URL, so you can bookmark or share a filtered view ("last 30 days, missions only"). Hover a category chip to see what it covers. A single surface can be selected from the *Where the money went* card (or `?surface=` in the URL); a removable chip in the header shows it. The raw table's filters are separate and stay local to that block.

A note on accuracy: failed and aborted runs are kept out of *cost averages* (they'd skew the per-run numbers) but they still count toward your total run count and failure rate. So the averages stay clean while the reliability picture stays complete.

## Per-spec cost

You don't have to come to the Analytics page to see what a spec cost. Open any spec and, if it has any spend attached, you'll see a one-line summary right under the title:

> $0.42 · 6 turns · 1m 12s active · breakdown

Click it and you land on the Analytics page already filtered to that spec. It's the quickest path from "what did this feature cost me?" to the full breakdown.

## Exporting your data

When you need the numbers outside the app — a spreadsheet, a finance report, your own analysis — use the **Export** dropdown. It offers four formats:

- **Summary CSV** — a multi-section file with totals, the daily timeline, by-category, by-surface, by-model, and top specs.
- **Summary JSON** — the same summary, structured.
- **Raw CSV** — every invocation row (up to 10,000; it notes if it had to truncate).
- **Raw JSON** — the same raw rows, structured.

Exports respect whatever period, category and surface filters you currently have applied, and files are named so they sort sensibly: `<project>-analytics-<period>-<date>.csv`. The button is disabled when there's nothing to export, and you'll get a clear error toast if a download fails.

## Staying live

You don't need to refresh. When a new invocation is recorded anywhere in the project, the open dashboard quietly refetches itself a moment later, so the burn meter keeps pace with work as it finishes.

## Daily limits {#daily-budget}

Set a daily limit to cap what a day can cost. Every cap, daily, weekly, monthly and per-run, is edited in one place: **Analytics → Spend limits**. **Settings → Advanced** and **Project settings → Spend limits** only show the current daily cap, with an **Open Spend limits** button that takes you there.

When the day's recorded spend reaches a limit, the queue pauses itself, rails and loop runs refuse to launch with *Daily limit reached*, and a loop run already in progress parks between steps, paused at the limit. Raise or clear the limit, or wait for the daily reset, and then resume.

The project limit counts your local day; the app-wide limit counts the UTC day. The per-job cost alert is a separate setting.

**Weekly, monthly and per-run caps.** Longer caps work the same way. Open **Analytics → Spend limits** to set a **weekly** and a **monthly** cap, per project and for the whole app, and a **per-run soft cap** (*pause and ask at $X*). Weeks start on Monday and months on the 1st, in your local time. A weekly or monthly cap pauses queues, refuses launches and parks running loops exactly like the daily limit; raise or clear it there, or wait for the reset. When a run's own reported cost reaches the per-run cap it pauses, and **Resume** asks whether to continue without the cap or raise it. Reaching any cap also adds a **Raise cap** item to the inbox.

The Spend limits panel shows today, this week and this month against each cap. Its month-end **projection** is an estimate (the average of the last 14 completed days times the days left, plus what you have spent), never added to billed spend. **What-if** re-prices the last 30 days of recorded token usage on another model with the app's price list, and says *No pricing* for a model it has no price for. On a subscription plan there is no dollar cost per use, so the panel shows turns and plan limits instead of dollars.
