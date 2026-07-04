# The Job Detail view

Click any job card on the **Jobs** page and you land here: the cockpit for a single rail run. It's built around one promise — **the live numbers you see are real, never guesses.** This page walks through the phases, the live metrics, the ticket cards — and the composer that lets you **talk to the running job**.

## The layout

Two panels sit above the full streaming log; on a running Claude job, a chat composer sits below it:

```
┌─────────────────────────────────────────────┐
│  Status header  (icon · live duration · …)  │
├─────────────────────────────────────────────┤
│  Ticket header  ( #12  #14  #15 )           │
├─────────────────────────────────────────────┤
│                                             │
│  Streaming log  (auto-scroll · search · …)  │
│                                             │
├─────────────────────────────────────────────┤
│  Composer  (send a message to the job · …)  │
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

Which agent handles each phase is decided by the project's **agent profile**. The baseline trio (`sr-architect`, `sr-developer`, `sr-reviewer`) is always present; routing rules in a profile can add agents or swap which one runs a phase. The phase progress bar only appears when the command actually defines phases — Freestyle jobs (which bypass the pipeline) won't show one.

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

## Loop runs: the step explorer

When the job is a **loop run** (see [The Loop Builder](the-loop-builder)), the flat log makes way for a **step explorer** that mirrors the loop's actual shape:

- **The overview strip** at the top is the loop's live map — one chip per node (AI Step, Shell, Loop Decider…), laid out in the order the graph flows. Chips light up as the run progresses: dimmed while pending, pulsing while running, then a check or a cross. A Decider chip also shows the verdict it routed by — loop back or move on — and an iteration counter (`Iteration 3/10`) keeps score on the right. Click any chip to jump straight to that node's latest step.
- **One collapsible box per step.** Every pass over a node becomes its own section, with the step number, its name, an iteration badge, its duration once it finishes — and its own copy button, so you can grab exactly one step's output. (The toolbar copy still takes the whole log.) Anything printed before the first step — the run banner, the worktree notice — is tucked into a **Setup** section.
- **Follow mode** is on by default: the running step stays open and auto-scrolls while earlier steps fold out of the way. The moment you scroll up or open an older step, following pauses so you can read — a floating **Resume follow** pill takes you back to live. **Expand all / collapse all** sit in the toolbar, and typing in the search box looks across every step at once.
- **Interrupted steps are honest too.** A step that never got to report an outcome — the run was cancelled or the app went down mid-step — is marked **Interrupted** with a dashed border, rather than pretending it finished.

Everything else on this page works exactly the same for loop runs — the live metrics, the ticket cards, the composer. Non-loop jobs keep the classic streaming log above.

## Talk to the running job

Every Claude job runs as a **live session** by default, so a chat composer sits at the bottom of this page — and of the job modal in mission mode. Use it to ask the running agent a question ("why did that test fail?") or to steer it mid-run ("skip the refactor, focus on the fix").

A few things worth knowing:

- **Messages queue, they don't interrupt.** Send while the agent is streaming and your message waits its turn — it runs as the next prompt, and the job keeps following its plan. A small counter shows how many messages are queued.
- **The totals line is real.** The composer shows a live `N turns · $X` summary, summed from each completed turn's actual usage — consistent with this page's no-guesses promise.
- **Two ways a session ends.** Most jobs **wrap up on their own**: the moment a turn finishes with no messages queued, the session settles and the job completes — your messages are optional steering, never an obligation. A subtle **Wrap up now** action ends it early with everything produced so far. **Freestyle** jobs are the exception: they idle between turns and wait for you to click **Finalize** — that's their design, a back-and-forth session you close when you're done.
- **Loop runs route to the active step.** On a custom or built-in loop, your message reaches the **AI step that is running right now**. Between steps (while the Loop Decider thinks, or a shell command runs) the composer shows a short *"Waiting for the next step…"* state — your drafted text is kept, and sending re-enables when the next AI step starts. **Settle this step** ends the current step early and lets the loop advance with what it produced.
- **Claude only, for now.** Codex and Gemini jobs run one-shot exactly as before — no composer appears. (Server operators can turn the whole feature off with `SPECRAILS_INTERACTIVE_JOBS=false`.)

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
