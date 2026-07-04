# Batch implement & multi-feature

One spec at a time is fine, but a lot of real work comes in clusters — a feature plus its tests plus its migration, or a backlog you want cleared in one sitting. This page covers running several specs together: Batch mode, dependency waves, and how the pipeline keeps concurrent work from colliding.

## Running several specs at once

The simplest way to run a pile of specs from one rail is **Batch** mode:

1. **Drag all the specs** you want onto a single rail. They stack up in that rail's spec list.
2. **Switch the rail's mode to Batch** (the segmented control in the rail header).
3. **Press ▶ Play.**

The rail launches **one** `/specrails:batch-implement` job that works through every assigned spec. Monitor it like any other job on the Jobs page — it's a single job covering the whole set, not one job per spec.

This matters because of the **one-job-per-project queue**. Since a project runs only one rail job at a time, Batch mode is also the cleanest way to *chain* a list of specs without juggling multiple rails and waiting for each to drain.

### Implement vs Batch — which mode?

| | **Implement** | **Batch** |
|---|---|---|
| Command | `/specrails:implement` | `/specrails:batch-implement` |
| Specs per job | All on the rail, treated as one unit of work | All on the rail, worked **sequentially** |
| Best for | A tightly coupled change | Several distinct features you want cleared in order |
| Ordering | n/a | Dependency-aware waves (see below) |

If the specs are really one change, use **Implement**. If they're a list of separate features, use **Batch** and let it sequence them.

## Dependency waves

Batch mode doesn't just run specs top to bottom — it computes a **dependency-aware execution order** and groups specs into *waves*. The orchestrator (`/specrails:batch-implement`) figures out which specs depend on which, then schedules them so that nothing runs before the work it builds on.

Conceptually:

```
Wave 1:  #2 (data model)        ← no dependencies, runs first
Wave 2:  #4 (API on the model)  ← waits for #2
         #5 (CLI on the model)  ← waits for #2
Wave 3:  #7 (docs across all)   ← waits for #4 and #5
```

Within the job, each wave's specs are implemented before the next wave starts. You don't configure this by hand — the orchestrator derives the waves from the specs themselves. Watch it unfold in the [Job Detail view](the-job-detail-view): the streaming log narrates which spec the batch is on, and the ticket header shows every spec the job touched.

## Worktree isolation and how work is delivered

When several specs are implemented in one run, the pipeline keeps each unit of work isolated so concurrent or sequential changes don't trample each other's files. Each spec's implementation runs in its own clean **git worktree** — a separate checkout that shares your repository's history but never touches your working tree while the AI works.

When the run finishes, **nothing is pushed and no pull request is opened yet**. The work stays safely committed on its isolated branches, the specs move to a new **On Review** status, and specrails **asks you first**: a persistent decision bar appears on the rail with **Create PR** — one draft pull request off your project's designated integration branch (set it in **Settings → Integration branch**; it defaults to your repository's default branch), combined across every spec on the rail — and **Discard**. specrails **never merges, and never commits to your integration branch directly** — you decide whether a PR exists at all, and a human owns the merge. It's the safe hand-off: specrails produces the pull request only when you say so, and your engineers review and merge it in GitHub the way they already do.

In practice this means:

- Each spec gets a clean slate to implement against, rather than inheriting the in-flight edits of the previous spec mid-stream.
- Your working tree is never modified while the run is in flight — nothing lands until you say so.
- When the run is done the specs show an **On Review** badge and the rail asks the question: **Create PR** to open the combined draft pull request, or **Discard** to clean up the branches and return the specs to the backlog. If you launched the rail from the agent chat, the same question appears as a card in that conversation — answer in either place, both stay in sync.
- After creating it, **Open PR** views the draft, **Publish** opens it for review and hands it to your team's normal GitHub review, and **Check merge** flips the specs to Done once your team has merged it.
- If the isolated branches can't be combined cleanly when you create the PR, specrails stops safely and leaves the branches for a human — it never forces a broken merge onto your base. You can retry or discard from the same bar.

> Creating the PR needs the GitHub CLI (`gh`) authenticated and a remote configured. Without them, specrails still keeps the work committed on a branch you can open a pull request from yourself — nothing is lost, and the decision bar lets you retry. To fall back to the older behaviour (integrate locally instead of asking), set `SPECRAILS_RAIL_DELIVER_PR=0`.

The app records, per job, exactly which files were touched and which ticket touched them (you'll see this surface as provenance chips in the **Code** section and as a "Files touched by this ticket" list on each spec's detail modal). That attribution is what lets you trust a multi-spec run: you can always trace a file change back to the spec that caused it.

## Multi-feature across projects

If you want genuine parallelism — two big features building at the same time — split them **across projects**, not across rails in one project. Each project has its own independent queue, so:

```
Project A   ▶ Rail running feature X   ┐
                                       ├─ run simultaneously
Project B   ▶ Rail running feature Y   ┘
```

There's no global concurrency limit and no contention between projects. Open both, launch a rail in each, and they progress together. The only shared throttle is your budget cap, which pauses queues per-project or app-wide once the day's spend hits the limit.

## Tips for big batches

- **Group related specs on one rail** before switching to Batch — the dependency waves only see what's on that rail.
- **Set a daily budget** before a large batch so an unexpectedly expensive run auto-pauses instead of running away. Configure it under [Budget](../settings/customizing).
- **Use the Compare button** on the Jobs page afterward to diff two batch runs side by side.
- **Export a diagnostic** (if telemetry was on) to get the exact profile + plugin snapshot for the whole batch.

## Where to go next

- [Rails & jobs](rails-and-jobs) — the queue model in depth.
- [The Job Detail view](the-job-detail-view) — watch a batch run live.
- [Picking an engine per rail](picking-an-engine-per-rail) — note that Batch runs on any provider; Ultra is Claude-only.
