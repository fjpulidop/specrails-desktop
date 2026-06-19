# The Job Detail view

Click any job card on the **Jobs** page and you land here: the cockpit for a single rail run. It's built around one promise — **the live numbers you see are real, never guesses.** This page walks through the phases, the live metrics, and the ticket cards.

## The layout

Two panels sit above the full streaming log:

```
┌─────────────────────────────────────────────┐
│  Status header  (icon · live duration · …)  │
├─────────────────────────────────────────────┤
│  Ticket header  ( #12  #14  #15 )           │
├─────────────────────────────────────────────┤
│                                             │
│  Streaming log  (auto-scroll · search · …)  │
│                                             │
└─────────────────────────────────────────────┘
```

## Pipeline phases

For `Implement` and `Batch` jobs, the run moves through the phases defined by the slash command — by default:

```
Architect ──► Developer ──► Reviewer ──► Ship
```

Each phase is a specialised agent the rail's engine invokes in your project directory:

| Phase | Agent | What it does |
|-------|-------|--------------|
| **Architect** | `sr-architect` | Plans the implementation. |
| **Developer** | `sr-developer` | Writes the code. |
| **Reviewer** | `sr-reviewer` | Reviews the output. |
| **Ship** | (varies) | Final wrap-up: tests, commit, PR draft. |

Which agent handles each phase is decided by the project's **agent profile**. The baseline trio (`sr-architect`, `sr-developer`, `sr-reviewer`) is always present; routing rules in a profile can add agents or swap which one runs a phase. The phase progress bar only appears when the command actually defines phases — Ultracode jobs (which bypass the pipeline) won't show one.

## Live metrics — honest by design

The status header is the headline. It shows a status icon, an activity line describing what the job is doing *right now*, a count of steps taken, and a row of metrics:

| Metric | When you see the real value |
|--------|------------------------------|
| **Duration** | **Live.** A 1-second ticker counts up while the job runs — this is the one genuinely live number. |
| **Turns** | Derived incrementally from streamed assistant events as they arrive. |
| **Tokens** | Aggregated incrementally from the same stream (tolerant of events missing usage fields). |
| **Cost** | Shown as `—` until the job exits, then revealed as the authoritative `total_cost_usd`. |

The design principle: **no approximate or estimated mid-run numbers.** Duration is real because it's just a clock. Turns and tokens are accumulated from actual streamed activity. Cost is deliberately *not* estimated while running — it shows as pending and only resolves to its final, authoritative figure when the provider reports it at job exit. If a number looks like it's waiting, that's intentional — you're being shown truth, not a projection.

The header label and icon map to the job's status, and the panel renders for `running`, `completed`, and `failed` jobs alike — so a finished job's detail view shows the same metrics frozen at their final values.

## The ticket cards

The **ticket header** sits between the status header and the log. It's a premium identity card showing a chip for every spec the job touched — matched from the launched command, so it reflects exactly which tickets this run was about.

- **2–3 tickets** — shown as a list of chips.
- **4 or more** — collapse into a compact `+ N more` mode with an expand chevron, so the header stays tidy.

Clicking a chip opens that spec's detail **over the job page** — you don't lose your place or change route. It's a quick way to re-read what a job is supposed to deliver while you watch it work. (On tablet-width screens you can even drag a ticket modal aside to compare two specs side by side.)

## The streaming log

Below the panels is the full log of the run, streamed in real time over the WebSocket:

- **Auto-scroll** keeps the newest output in view (scroll up and it pauses so you can read).
- **Search** to jump to a phrase.
- **Copy** to grab the whole log.

This is the raw truth of what the AI is doing — every tool call, every file edit, every test run.

## Diagnostic export

If [telemetry](../settings/customizing) was enabled for the job, an **Export diagnostic** button appears in the header. It downloads a ZIP containing:

- `job-metadata.json` — command, status, profile, plugins.
- `telemetry.ndjson` — uncompressed OTLP/JSON signals.
- `logs.txt` — the full streaming log.
- `summary.md` — human-readable highlights.
- `profile.json`, `plugins.json` — exact snapshots of what ran (when present).

Handy for sharing a run with a teammate, or filing a precise bug report.

## Where to go next

- [Rails & jobs](rails-and-jobs) — launching and queueing.
- [Batch implement & multi-feature](batch-implement-and-multi-feature) — many specs, dependency waves.
- [Tracking cost](../analytics/tracking-cost) — turn per-job costs into project analytics.
