# Running pipelines

You have specs on the board. Now let's ship them. This guide covers launching a rail, picking a **Loop** (built-in or your own), agent profiles, plugins, and the Jobs page.

## The big picture

```
SpecsBoard (left)            Rails (right)
─────────────────            ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  drag onto
#3 Cost limits      │ ────────────►   Rail 1
#4 Audit log        │                 ▶ Play
                    │
                    └────────────►   Rail 2
                                     ▶ Play

                     Each rail runs Architect → Developer → Reviewer → Ship
                     in your project directory.
```

A **rail** is an execution lane. Drag a spec card from the SpecsBoard onto a rail and press **▶ Play** to launch the pipeline. Rails let you organise and queue work into named lanes.

Rails run on **Claude** by default. If your project has more than one provider installed, a per-rail engine selector lets you launch a rail on **Codex** or **Gemini** instead — see [Using Codex](codex.md) and [Using Gemini](gemini.md). Only the **Freestyle** loop is Claude-only; the standard Implement and Batch loops run on any installed provider.

> **One job at a time per project.** Each project has a single queue, so within a project only one rail job runs at a time; the rest queue behind it. Real parallelism is **across projects** — open two projects and their rails run independently. See [Running multiple rails](#running-multiple-rails).

## Rails

Each rail has a header with:

- **Status pill** — `idle`, `running`, or `failed`. (There's no separate "completed" state — a rail returns to `idle` when its job finishes cleanly.)
- **Spec list** — the IDs of the specs assigned to this rail. Drag in more, drag out to detach. You can also use the **Move to rail** popover from a spec card; it shows a status dot per rail so you don't push work onto a busy lane.
- **Loop picker** — the **Loop** this rail runs: a built-in (`Implement`, `Batch`, or `Freestyle`) or one of your published custom loops. See [Loops](#loops).
- **Profile picker** — which agent profile this rail uses. This only appears once the project has **at least one** profile (create them on the Agents page). When present, `No profile` runs the rail in legacy mode.
- **Engine selector** — pick which installed provider (Claude, Codex, or Gemini) runs this rail. Only renders on projects with more than one provider installed.
- **Play / Stop button** — start or cancel.

### Loops

A rail runs a **Loop**, picked in the rail header and persisted per rail. The three **built-in** loops cover the common cases:

| Built-in loop | Command | What it does |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | One job covering all the specs on the rail. Runs the full Architect → Developer → Reviewer → Ship pipeline. |
| **Batch** | `/specrails:batch-implement` | One job that works through the rail's specs sequentially, in dependency-aware waves. |
| **Freestyle** | (Freestyle) | Claude implements each spec autonomously, **bypassing** the OpenSpec pipeline. One independent job per spec. Claude only. |

Beyond the built-ins, the **Loops** section (left sidebar, above the project list) is a global, n8n-style **visual builder** shared across all your projects. A loop is a graph of typed steps:

- **AI Step** — runs a prompt or a magic command (`{{cmd:implement}}`, `{{cmd:verify}}`, `{{cmd:fix}}`, …), with `{{spec.*}}` data tokens and a global **constants** library (`{{const:*}}`).
- **Shell** — runs a command and captures its output.
- **Loop Decider** — an AI node that, each iteration, decides **continue** (loop back) or **stop** (exit) based on a goal you write — e.g. *“the verification step reported VERIFICATION: PASS”*. This is what powers autonomous **verify → fix → verify until green** loops.
- **Start / End** — entry and terminal nodes.

Each run is bounded by **max iterations**, a wall-clock **timeout**, and an optional **cost cap** (USD, checked between steps). The builder also has live validation, a dry-run preview (resolve every step's exact text without spawning), import/export to JSON, and copy/paste of steps across loops. **Fork** a built-in to start from a working graph, then **Publish** to make a loop selectable on any rail.

> Loop runs stream live in the Jobs view like any rail job — and the Job Detail view groups a loop's log **by step**: a live chip map of the graph on top, one collapsible section per step below, with follow mode tracking the running step. Provider/model/effort are governed by the **rail**, not the loop's steps.

### Pipeline phases

`Implement` and `Batch` run the pipeline phases defined by the slash command's frontmatter — by default:

```
Architect ──► Developer ──► Reviewer ──► Ship
```

Each phase is a specialised agent invoked by the rail's engine (Claude, Codex, or Gemini) in your project's working directory:

| Phase | Agent | What it does |
|-------|-------|--------------|
| Architect | `sr-architect` | Plans the implementation |
| Developer | `sr-developer` | Writes the code |
| Reviewer | `sr-reviewer` | Reviews the output |
| Ship | (varies) | Final wrap-up: tests, commit, PR draft |

In plain terms: the project's **agent profile** decides which AI agent handles each phase. The baseline trio (`sr-architect`, `sr-developer`, `sr-reviewer`) is always present; a profile's routing rules can add extra agents or swap which one runs a phase. The phase progress bar only renders when the command defines phases. For the full format, see [internals/profiles.md](internals/profiles.md).

**How the work is delivered (ask-first).** By default (`SPECRAILS_RAIL_DELIVER_PR` on — set `0`/`false`/`off` to disable) a rail runs in isolated git worktree(s) off your project's designated integration branch (*Settings → Integration branch*, defaults to the repo default branch). When the run finishes, **nothing is pushed and no PR is opened yet**: the work stays committed on its isolated branches, the specs move to a new **On Review** status, and the app asks you what to do — a persistent decision bar appears on the rail with **Create PR** and **Discard**. **Create PR** assembles the branches into **one draft pull request** — combined across every spec on the rail, with per-ticket commit history preserved; you can then **Approve** it (promote to ready-for-review) and later **Check merge** — once a human merges it in GitHub, the specs flip to Done. **Discard** cleans up the worktrees and branches and returns the specs to the backlog. specrails never merges and never modifies your working tree; a human owns the merge. Creating the PR needs `gh` authenticated + a remote; otherwise the work is still committed to a branch you can PR from yourself (the bar offers a retry). When the flow is disabled, the rail integrates its branches locally instead (the legacy behaviour) and no decision is asked. This is desktop-owned: specrails-core's `implement` is told to skip its own shipping (`SPECRAILS_GIT_AUTO=false`) so it never opens a second, uncoordinated PR.

### Freestyle

`Freestyle` (mode value `ultracode` on the API — its original name) is a Claude-only loop that skips the Architect → Developer → Reviewer → Ship pipeline entirely. Instead of orchestrating the agent chain, it hands Claude a configurable pre-prompt plus the full spec text and lets it work autonomously with its native tools.

- **One job per spec.** If the rail has three specs, `Freestyle` launches three independent jobs.
- **Variable cost.** Because the run is open-ended, pressing Play opens a confirmation dialog before anything spawns.
- **Model picker.** A per-rail control lets you pick **Haiku / Sonnet / Opus** (default Sonnet) for the Freestyle run.
- **Claude only.** The Freestyle loop and its model picker are offered only when the rail's engine is Claude. Codex and Gemini rails can't run Freestyle, and agent profiles don't apply to Freestyle rails.
- **Interactive by default.** Like every Claude job, a Freestyle run is a live session: chat with the running job and send follow-up prompts from the Job Detail composer. What's special about Freestyle is the ending — the session stays open until **you** click **Finalize** (other jobs wrap up on their own once a turn finishes with nothing queued). Can be disabled server-side via `SPECRAILS_INTERACTIVE_JOBS=false`.

You can customise the Freestyle pre-prompt per project on the [Settings page](customizing.md#freestyle-pre-prompt).

### Running multiple rails

Within a single project, jobs are **serialised** — the project runs one rail job at a time and queues the rest. Adding more rails organises your work into lanes, but it doesn't make them run concurrently inside that project.

True parallelism is **across projects**: each project has its own queue, so rails in different projects run at the same time without contending. There is no global concurrency limit to configure — the only automatic throttle is budget-based (see [Stopping everything](#stopping-everything)).

## Jobs

Every rail run becomes a **Job**. Find them under **Jobs** in the project's right sidebar.

### Jobs page

A card list of every job for the active project, newest first. Each card shows:

- A status badge, the profile badge, a priority badge, duration, cost, and the launched command.

Controls above the list:

- **Status filter chips** — click to show only jobs in a given status.
- **Date-range filter** — narrow to a window of time.
- **Compare** — enter compare mode, select two jobs, and open a side-by-side comparison.

Click a card to open the **Job Detail page**.

### Job Detail page

Two panels sit above the streaming log:

- **Status header** — a status icon and a live duration timer (the one genuinely live number), plus an activity line showing what the job is doing right now and a count of steps taken. Cost, turns, and tokens are deliberately **not** estimated mid-run — they show as pending and are revealed with their final, authoritative values when the job exits.
- **Ticket header** — chips for every spec the job touched (matched from the launched command). Click a chip to open that spec's detail over the job page without leaving it. With four or more tickets, the chips collapse into a `+N more` mode you can expand.

Below: the full streaming log with auto-scroll, search, and copy.

**Talk to the running job.** Every Claude job (and every Claude AI step in a loop run) is an interactive session by default: a chat composer sits at the bottom of the Job Detail page — and of the job modal in mission mode — so you can ask the running agent a question or steer it mid-run. Messages sent while the model is streaming queue up and run next; the job keeps following its plan. The composer shows a live `N turns · $X` line summed from each completed turn's real usage (still no estimates). Most jobs finish on their own the moment a turn completes with nothing queued — a subtle **Wrap up now** ends them early; Freestyle jobs instead wait for your explicit **Finalize**. During a loop run your messages reach the currently running AI step (between steps the composer shows a short waiting state, and **Settle this step** advances the loop). Codex and Gemini jobs run one-shot as before. Server kill switch: `SPECRAILS_INTERACTIVE_JOBS=false`.

### Cancelling a job

Click **Stop** on the rail header. The app sends `SIGTERM` to the subprocess, waits **5 s**, then `SIGKILL`.

### If a rail won't launch

If you pick an engine whose CLI isn't installed on your machine, the launch fails fast instead of starting a broken job. Install the missing provider CLI — see [Using Codex](codex.md) or [Using Gemini](gemini.md) — then launch again. (Missing Claude or Codex returns a precise "*&lt;provider&gt; CLI not found*" message; missing Gemini surfaces a generic launch error today, but the result is the same — nothing spawns.)

### Diagnostic export

Visible only when [telemetry](customizing.md#telemetry) was enabled for the job. Click **Export diagnostic** in the Job Detail header to download a ZIP containing:

- `job-metadata.json` — command, status, profile, plugins
- `telemetry.ndjson` — uncompressed OTLP/JSON
- `logs.txt` — full streaming log
- `summary.md` — human-readable highlights
- `profile.json`, `plugins.json` — exact snapshots of what ran (when present)

## Agent profiles

A **profile** is a named JSON file that bundles the agent chain + per-agent models + routing rules. Different rails can run different profiles.

### Why use profiles

Without profiles, every rail uses the project's frontmatter-baked models. With profiles, you can:

- Keep a `default` profile for everyday work (Sonnet across the board).
- Add a `budget` profile that swaps Developer to Haiku and routes simple tasks away from Architect.
- Add a `max` profile for high-stakes work with Opus + every optional agent.

### Browse / create profiles

Open **Agents** in the project's right sidebar. Two sub-tabs:

- **Profiles** — full CRUD over `.specrails/profiles/*.json`. The live validator enforces the baseline trio and routing ordering — Save is disabled with an "N issues to resolve" hint while the profile is broken.
- **Agents Catalog** — read-only viewer of upstream `sr-*` agents and your `custom-*` agents.

The empty state offers **Migrate from current agents**: one click creates a `default` profile mirroring today's frontmatter.

Each profile gets a per-profile analytics card showing usage for the last 7 / 30 / 90 days: jobs, success rate, avg tokens, avg duration.

### Pick a profile at launch

Pick the profile from the **rail header's profile dropdown**. It's preselected to the project's resolved default, and your choice **persists per rail** across launches. The selection is sent with the launch; rails in the same batch can run different profiles.

The **`No profile`** option always exists — use it to run a rail exactly as it did pre-4.1.0. (The dropdown itself only appears once the project has at least one profile.)

> **Profiles apply to Claude rails only.** When a rail's engine is Codex or Gemini, the run always uses legacy mode — any selected profile is ignored. Profiles are a Claude-specific feature.

### Custom agents (Agent Studio)

From the Agents Catalog tab, the toolbar offers three creation entry points:

| Button | Behaviour |
|--------|-----------|
| **Generate with Claude** | Describe the agent in natural language; Claude drafts the full `.md`. |
| **Template** | Start from the catalog of 50 templates across 13 categories (Software Engineering, Testing & QA, Data & Analytics, Security & Compliance, Product & Design, …). |
| **Blank** | Start from a minimal template. |

You can also **Duplicate** any existing agent (upstream or custom) from its card.

Custom agents live at `.claude/agents/custom-*.md` and are **never touched** by specrails-core's installer/update scripts. Every save appends a version row — open **History** in the Studio to browse and restore.

Click **Test** in the Studio to run the current draft against a sample task in an isolated `claude` invocation — no files written; output + token count + duration shown inline.

### Requirements

Profiles require `specrails-core ≥ 4.1.0` in the project. Without it, you can still create and edit profiles in the app, but the pipeline runs in legacy mode (no env injection). A yellow banner on the Agents page tells you when to upgrade.

For deeper internals (resolution order, snapshotting, file format), see [internals/profiles.md](internals/profiles.md).

## Plugins

Per-project bundled integrations. Click **Integrations** in the project's right sidebar.

### Bundled today

- **Serena** — semantic code navigation via LSP + MCP. Requires `uv` on PATH (the app auto-detects).

### Installing a plugin

Each plugin tile has:

- **Status** — `not installed`, `installed`, `orphan` (state file mentions it but `.mcp.json` doesn't), or `degraded` (verify failed).
- **Preview install** — shows which `mcpServers` entries and agent fragments will land where, so you can sanity-check before clicking.
- **Install** — applies the changes. Progress streams over the WebSocket (`plugin.install_progress` event).
- **Uninstall** — removes the surgical changes; never wholesale rewrites your `.mcp.json`.
- **Health** — on-demand verify (probes a `--version`-style command with a 2 s timeout).

### How plugins affect your pipeline

Before each rail spawn, the app:

1. Resolves the project's installed plugins (parallel verify, per-plugin 2 s timeout).
2. Classifies them into `active` and `degraded`.
3. Writes a per-job snapshot to `~/.specrails/projects/<slug>/jobs/<jobId>/plugins.json` (chmod 400).
4. Injects two env vars into the subprocess: `SPECRAILS_PLUGINS_ACTIVE` (CSV) and `SPECRAILS_PLUGINS_SNAPSHOT` (file path).

Degraded plugins are **non-blocking** — the rail spawns anyway, but a `plugin.degraded` toast surfaces in the UI.

### Reserved paths

The app never wholesale rewrites these files:

- `<project>/.mcp.json` — surgical merge per plugin.
- `<project>/.specrails/plugins/state.json` — install registry.
- `<project>/.specrails/plugins/snapshots/<jobId>.json` — per-job snapshots.
- `<project>/.claude/agents/custom-<plugin>.md` — optional fragment per plugin.

specrails-core's installer also guarantees it never touches `.specrails/plugins/**` or `.claude/agents/custom-*.md`.

## Running many specs at once

Want a whole batch of specs to run from one rail? Use the **Batch** loop:

1. Drag all the specs you want onto a single rail.
2. Pick the **Batch** loop on that rail.
3. Press **▶ Play**.

The rail launches one `/specrails:batch-implement` job that works through every assigned spec in dependency-aware waves. Monitor progress on the Jobs page. Because a project runs one job at a time, this is also the way to chain a list of specs without juggling multiple rails.

## Stopping everything

If something looks wrong:

- **One rail** — click **Stop** on the rail header.
- **Auto-pause on budget** — if you set a daily budget (project or app-wide), the queue automatically pauses once that day's spend hits the cap. Configure it under [Budget](customizing.md#budget).
- **Everything** — quit the desktop app, or run `specrails-desktop stop`.

## Where to go next

- [Tracking cost](tracking-cost.md) — see what each rail run is costing you.
- [Customising the app](customizing.md) — daily budget, per-job alerts, telemetry.
- [Using Codex](codex.md) — run rails on the Codex CLI.
- [Using Gemini](gemini.md) — run rails on the Gemini CLI.
- [Agent profile internals](internals/profiles.md) — for power users.
