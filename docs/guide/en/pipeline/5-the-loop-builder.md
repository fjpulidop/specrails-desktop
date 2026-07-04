# The Loop Builder

A **rail runs a Loop**. The built-in loops (`Implement`, `Batch`, `Freestyle`) cover the everyday cases, but the **Loop Builder** lets you design your own — a visual, n8n-style editor for automation that repeats until a goal is met. This page explains what a loop is, how to build one, and how to run it on a rail.

## Loops and rails — the relationship

A **loop** is the *recipe* for the work; a **rail** is the *lane* that runs it against your specs.

```
   Loop Builder (left sidebar)             Rails (right)
   ───────────────────────────             ─────────────
   Implement   (built-in)                  Rail 1
   Batch       (built-in)      pick on ►      Loop: Verify-until-green
   Freestyle   (built-in)                     ▶ Play
   Verify-until-green (yours)
```

- Loops live in the **Loops** section (left sidebar, alongside your projects) — they are **global**, shared across every project.
- A rail **picks a loop** in its header (the Loop picker) and runs it when you press Play.
- The **rail** decides the provider, model and reasoning effort — *not* the loop's steps. The same loop runs on Claude, Codex or Gemini depending on the rail.

So: build a loop once, then pick it on any rail in any project.

## Opening the builder

Click **Loops** in the left sidebar to see the library: the three built-in loops plus any of your own. Open one to view it, or click **New loop** to start from a blank canvas.

You can't easily edit a built-in directly — instead **Fork** it. That gives you an editable copy of a working graph to start from, which is the easiest way to learn.

## What a loop is made of

A loop is a graph of **nodes** connected by **edges** (the arrows). Each node is one step:

| Node | What it does |
|------|--------------|
| **Start** | Where the run begins. Exactly one per loop. |
| **AI Step** | Runs an AI turn — a prompt you write, or a *magic command* like `{{cmd:implement}}`, `{{cmd:verify}}`, `{{cmd:fix}}`. This is where the real work happens. |
| **Shell** | Runs a shell command (e.g. `npm test`) and captures its output for later steps. |
| **Loop Decider** | The brain of a loop. Each pass it reads a **goal** you write and decides **continue** (loop back and try again) or **stop** (exit). This is what powers *verify → fix → verify until green*. |
| **End** | A terminal node. Marks the run as success or failure. |

Edges connect the steps in order. The **Loop Decider** has two labelled outputs — **continue** and **stop** — so you wire "not done yet" back into the work and "done" out to an End.

### Writing step text

Inside any AI Step or Decider you can reference:

- **Spec data** — `{{spec.title}}`, `{{spec.description}}`, `{{spec.ids}}` (the rail's ticket IDs). Filled in from the spec(s) on the rail at run time.
- **Magic commands** — `{{cmd:implement}}` and friends expand to the matching pipeline command.
- **Constants** — `{{const:NAME}}` pulls from the global **constants library** (drag them in from the palette). Built-in sentinels like the verification PASS/FAIL markers are always available; you can add your own and reuse them across every loop.

## Keeping a loop bounded

A loop that never stops would burn money forever, so every run has three guards (set in the builder toolbar):

| Guard | What it does |
|-------|--------------|
| **Max iterations** | Hard cap on how many times the Decider may loop back, regardless of its verdict. |
| **Timeout (min)** | Wall-clock limit for the whole run. |
| **Max cost ($)** | *Optional.* Stops the loop once the accumulated cost crosses your budget. Checked **between steps** (a step's cost is only known once it finishes), so it may overshoot by one step. On Claude the cost is exact; on Codex and Gemini it's an estimate. Leave it empty for no cap. |

## Building with confidence

The builder helps you get a loop right before it ever runs:

- **Live validation** — problems (no Start, an orphaned step, an empty prompt, a Decider with missing branches) are flagged on the canvas and in a problems panel.
- **Dry-run preview** — resolves every step's exact text (spec data, constants, commands all expanded) **without spawning anything**, so you see precisely what each step would send.
- **Auto-arrange** — tidy the canvas vertically, horizontally or as a grid; your choice is saved per loop.
- **Copy / paste** — `Cmd/Ctrl + C` / `V` to copy steps within or across loops.
- **Import / export** — save loops to a `.json` file and import them back (duplicate names are skipped, the rest import).
- **Rename steps** — give each node a custom label so the graph reads clearly.

## Publishing and running

A loop starts as a **Draft**. When the graph is valid, **Publish** it — published loops are the ones that appear in a rail's Loop picker. (Unpublish to take it out of circulation without deleting it.)

To run a custom loop:

1. Open a project and drag a spec onto a rail.
2. In the rail header, open the **Loop picker** and choose your published loop.
3. Press **▶ Play**.

The run streams live in the **Jobs** view with the same metrics and cost tracking as any rail job — and its log gets a dedicated **step explorer**: a live map of your graph with one collapsible box per step, following the running step as the loop advances (see [The Job Detail view](the-job-detail-view)). On Claude, each **AI Step** is a live session too: message it from the Job Detail composer to steer it mid-step (between steps the composer briefly waits, and **Settle this step** advances the loop with what the step produced). A loop that stops because it hit its iteration or cost cap is reported with that outcome rather than a plain success.

> **Heads-up while a loop runs.** You can't edit or delete a loop while one of its runs is executing — stop the run first.

## Where to go next

- [Rails & jobs](rails-and-jobs) — launching rails and the job queue.
- [The Job Detail view](the-job-detail-view) — watching a run live.
- [Picking an engine per rail](picking-an-engine-per-rail) — the rail (not the loop) picks the provider.
