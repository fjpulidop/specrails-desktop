# Rails & jobs

You've got specs on the board. This is where they turn into code. A **rail** is the lane that drives a spec through the full pipeline — Architect → Developer → Reviewer → Ship — running real AI agents for your project. This page covers launching a rail, parallel execution, and watching the work happen live.

## What a rail is

Think of your screen split in two:

```
SpecsBoard (left)            Rails (right)
─────────────────            ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  drag onto
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

A rail is an **execution lane**. You drag a spec card from the SpecsBoard onto a rail, then press **▶ Play**. For git repositories, the rail launches the pipeline in an isolated git worktree so the AI can edit files and run tests without touching your active working tree. If the project is not a git repo yet, Specrails clearly degrades to shared-folder execution and tells you that no branch or PR card will appear.

You can have several rails to organise work into named lanes (one for the feature you're focused on, another queued behind it). Rails are **dynamic**: the **+ Add** button in the Rails header creates a new lane (up to 12 per project) and idle empty lanes can be deleted. Every rail is server-backed, so your set of lanes survives reloads and is visible to the mobile companion and the in-app agent — the agent can even create a rail itself when all lanes are busy. More on multi-rail and batching in [Batch implement & multi-feature](batch-implement-and-multi-feature).

## Launching a rail on a spec

1. **Drag a spec card** from the SpecsBoard onto a rail. The spec's ID shows up in the rail's spec list. (Prefer not to drag? Use the **Move to rail** popover on the spec card — it shows a status dot per rail so you don't drop work onto a busy lane.)
2. **Pick a Loop** in the rail header. A rail runs a **Loop** — that's the work it performs. The default is the built-in `Implement` loop; you can also pick `Batch`, `Freestyle`, or a custom loop you built yourself. See [The Loop Builder](the-loop-builder).
3. **Press ▶ Play.**

That's it. The rail spins up an AI CLI process in the right execution context and starts the pipeline.

### What's in a rail header

| Control | What it does |
|---------|--------------|
| **Status pill** | `idle`, `running`, or `failed`. There's no separate "completed" — a rail returns to `idle` when its job finishes cleanly. |
| **Spec list** | The IDs assigned to this rail. Drag more in, drag them out to detach. |
| **Loop picker** | The Loop this rail runs — a built-in (`Implement` / `Batch` / `Freestyle`) or a custom loop. See the table below. Persisted per rail. |
| **Profile picker** | Which agent profile runs (Claude rails only). Only appears once the project has at least one profile. |
| **Engine selector** | Which installed provider runs this rail — Claude, Codex, or Gemini. Only renders when the project has more than one provider. See [Picking an engine per rail](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Start or cancel. |

### What a rail runs: Loops

A rail runs a **Loop** — the recipe for the work. Three loops are **built in** and cover the common cases:

| Built-in loop | Command | What it does |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | One job covering all specs on the rail. Runs the full Architect → Developer → Reviewer → Ship pipeline. The everyday default. |
| **Batch** | `/specrails:batch-implement` | One job that works through the rail's specs sequentially, in dependency-aware waves. Best for several related specs. |
| **Freestyle** | Freestyle | Claude implements each spec autonomously, **bypassing** the pipeline. One independent job per spec. Claude only. |

Freestyle is the odd one out: it skips the agent chain and hands Claude the raw spec to work on with its native tools. It's open-ended, so pressing Play opens a confirmation first, and a per-rail model picker lets you choose Haiku / Sonnet / Opus. It only appears when the rail's engine is Claude. A Freestyle run is also the one job that **stays open for you**: chat with it from the Job Detail composer and click **Finalize** when you're satisfied (every other job wraps up on its own).

Beyond the built-ins, you can **build your own loops** — repeat a verify → fix → verify cycle until a goal is met, chain shell commands between AI steps, and more. Those custom loops appear in the same Loop picker. That's the next big idea: [The Loop Builder](the-loop-builder).

## The job queue

Every time you press Play, the rail run becomes a **job**. The most important rule to internalise:

> **Rails run in parallel.** Every git-backed launch isolates its work in a per-spec git worktree, so several rails can run at the same time inside the same project without stepping on each other. Fresh work settles into an **On Review** decision card where you can create a draft PR or discard it; follow-up work for a spec that already has an open PR continues that PR branch instead of starting over from the integration branch.

Want everything moving at once? The **Launch all** button in the Rails header starts every ready lane in one go, after a single confirmation that frames the total cost (N rails × AI spend). Rails that are empty, already running, or awaiting a PR decision are skipped and reported in a compact summary toast. The in-app agent has the same power through `specrails_rails(launch_all)` — and it will create a fresh rail when no free lane exists.

Projects without git do not get worktree isolation or PR continuation. They still run, but the rail writes directly into the shared project folder and the result is accepted or reverted manually from the spec board.

There's no global concurrency knob to tune. The only automatic throttle is budget-based: if you've set a daily budget (project or app-wide), the queue auto-pauses once that day's spend hits the cap.

## Watching it run

Find every job under **Jobs** in the project's right sidebar — a card list, newest first. Each card shows a status badge, the profile badge, a priority badge, duration, cost, and the launched command. Above the list:

- **Status filter chips** — show only jobs in a given status.
- **Date-range filter** — narrow to a time window.
- **Compare** — pick two jobs and view them side by side.

Click any card to open the **Job Detail view**, where the live streaming log and the live metrics live — and where, on Claude jobs, a chat composer lets you **ask the running agent questions or steer it mid-run** without stopping anything. That's the next page: [The Job Detail view](the-job-detail-view).

## Cancelling a job

Click **■ Stop** on the rail header. The app sends `SIGTERM` to the subprocess, waits **5 seconds** for a clean exit, then `SIGKILL`s it. Nothing is left half-spawned.

## If a rail won't launch

If you pick an engine whose CLI isn't installed on your machine, the launch **fails fast** instead of starting a broken job — nothing spawns. Install the missing provider CLI ([Using Codex](../integrations/using-codex), [Using Gemini](../integrations/using-gemini)) and launch again. Missing Claude or Codex gives a precise "*&lt;provider&gt; CLI not found*" message; missing Gemini surfaces a generic launch error today, but the outcome is the same.

## Stopping everything

If something looks wrong:

- **One rail** — click **■ Stop** on its header.
- **Auto-pause on budget** — set a daily budget and the queue pauses itself when that day's spend hits the cap.
- **Everything** — quit the desktop app, or run `specrails-desktop stop`.

## Where to go next

- [The Loop Builder](the-loop-builder) — what a rail runs, and how to build your own loops.
- [The Job Detail view](the-job-detail-view) — phases, live metrics, ticket cards.
- [Batch implement & multi-feature](batch-implement-and-multi-feature) — run several specs at once.
- [Picking an engine per rail](picking-an-engine-per-rail) — Claude vs Codex vs Gemini.
