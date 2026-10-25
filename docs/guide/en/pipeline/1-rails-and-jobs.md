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

You can have several rails to organise work into named lanes (one for the feature you're focused on, another queued behind it). Rails are **dynamic**: the **+ Add** button in the Rails header creates a new lane (up to 12 per project) and idle empty lanes can be deleted. Every rail is server-backed, so your set of lanes survives reloads and is visible to the mobile companion and the in-app agent — the agent can even create a rail itself when all lanes are busy.

## Launching a rail on a spec

1. **Drag a spec card** from the SpecsBoard onto a rail. The spec's ID shows up in the rail's spec list. (Prefer not to drag? Use the **Move to rail** popover on the spec card — it shows a status dot per rail so you don't drop work onto a busy lane.)
2. **Pick a Loop** in the rail header. A rail runs a **Loop** — that's the work it performs. The default is the built-in `Implement` loop; you can also pick `Freestyle`, or a custom loop you built yourself. See [The Loop Builder](the-loop-builder).
3. **Press ▶ Play.**

That's it. The rail spins up an AI CLI process in the right execution context and starts the pipeline.

### What's in a rail header

| Control | What it does |
|---------|--------------|
| **Status pill** | `idle`, `running`, or `failed`. There's no separate "completed" — a rail returns to `idle` when its job finishes cleanly. |
| **Spec list** | The IDs assigned to this rail. Drag more in, drag them out to detach. |
| **Loop picker** | The Loop this rail runs — a built-in (`Implement` / `Freestyle` / `SDD Quick (OpenSpec)`) or a custom loop. See the table below. Persisted per rail. |
| **Profile picker** | Which provider-scoped agent profile runs (Claude rails). Only appears once the effective provider has at least one profile. |
| **▶ Play / ■ Stop** | Start or cancel. |

### What a rail runs: Loops {#rail-loops}

A rail runs a **Loop** — the recipe for the work. Two loops are **built in** and cover the common cases:

| Built-in loop | Command | What it does |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | One job covering all specs on the rail. Runs the full Architect → Developer → Reviewer → Ship pipeline. The everyday default. |
| **Freestyle** | Freestyle | The rail's provider implements each spec autonomously, **bypassing** the pipeline; verification and the Loop Decider then refine it until green. One independent run per spec. Works on Claude, Codex, Gemini, Kimi and local engines; the interactive in-job chat is Claude-only. |

To run several specs, put related ones (up to 3) on one rail — `Implement` runs them as one aggregate job — or spread independent specs across several rails: each git-backed rail runs in parallel in its own isolated worktree.

The built-ins are editable, too: edit one in the Loop Builder and publish it, and every rail that picks it runs your version (use **Restore original** to go back).

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

## Stopping everything

If something looks wrong:

- **One rail** — click **■ Stop** on its header.
- **Auto-pause on budget** — set a daily budget and the queue pauses itself when that day's spend hits the cap.
- **Everything** — quit the desktop app, or run `specrails-desktop stop`.

## Integrate locally with uncommitted changes

**Integrate locally** merges an approved delivery into your integration branch (for example `main`) on this computer, without a PR. You do not need a clean checkout first:

- Uncommitted changes that do not touch the delivered files simply stay where they are.
- If your changes touch the same files, Specrails saves them as a git stash named `specrails: before integrating #N (…)`, integrates, and puts them back. The toast reads *Saved your local changes, integrated #N, and restored them.*
- If putting them back conflicts with the integrated code, Specrails leaves the branch exactly as integrated and **keeps the stash** — nothing is lost. The card shows *Your local changes are saved as a stash* with the conflicting files, **Restore my changes** (try again, for example after you changed the code) and the stash name to copy. Specrails then restores them itself on a new branch `specrails/restore-local-<id>` in a separate worktree: if they apply cleanly there it commits them; otherwise an AI conflict resolver works only inside that worktree, keeping both your intent and the integrated code, and Specrails commits the result. The card lists the restored files; **Bring them back to <branch>** moves them onto your branch (only then is the stash dropped) and **Discard the restored branch** removes the branch and keeps the stash. A mission is only told what happened; it never has to run anything. OpenSpec skills and commands that Specrails generates (for example `.claude/skills/openspec-*/SKILL.md`) are not treated as your changes: on a conflict they keep the integrated version.
- Ignored files are never stashed: if one of them collides with the delivery, Specrails asks you to move it first.
- If the app stops between saving and restoring, it restores your changes the next time the project opens (only while the same branch is checked out).

## Time and cost forecast {#launch-forecast}

Before you press Launch, a rail can show how long runs like this usually take and, where it is meaningful, what they usually cost, for example *Usually 6–9 min · $2–4 for runs like this*.

The range is the middle half of your own history: the 25th to 75th percentile of completed runs in this project that used the same loop or command and the same engine. It needs at least 5 comparable runs. Until then the line reads *Not enough history yet* instead of a guess. Only costs the provider reported are used; estimated costs are left out. It is an estimate, never a bill.

The dollar figure shows only when the engine is known to bill per use (for example an API key). On a subscription plan, or while the billing mode is not known yet, only the time shows. When the rail holds several specs the band is for one spec and says *(per spec)*. If today's spend plus the top of the range could reach your daily budget, the line adds *May pause at budget* with a link to the budget settings. If today's budget is already used up, Launch asks you to confirm first, because the run would pause until it resets.


## Where to go next

- [The Loop Builder](the-loop-builder) — what a rail runs, and how to build your own loops.
- [The Job Detail view](the-job-detail-view) — phases, live metrics, spec cards.
