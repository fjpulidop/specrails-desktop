# CLI reference

The `specrails-desktop` CLI does three things:

1. **Manages the app server** — start, stop, status.
2. **Manages projects** — list, add, remove.
3. **Routes commands into the running server** — implement specs, run health checks, pass raw prompts to your AI CLI.

Everything here is grouped by what you're trying to do, not by alphabetical order of flags.

## Manage the app

### Start it

```bash
specrails-desktop start
specrails-desktop start --port 5000     # custom port (default 4200)
```

`start` daemonises the server, writes its PID to `~/.specrails/manager.pid`, and streams the server's stdout/stderr to `~/.specrails/desktop.log` automatically. The command polls until the server is ready, prints `[specrails-desktop] server started on http://127.0.0.1:<port>`, and returns — it does **not** keep streaming logs to your shell.

To watch the server logs:

```bash
tail -f ~/.specrails/desktop.log
```

If you're using the desktop app, it bundles the server and starts it for you. You don't need `specrails-desktop start` at all.

> **Running from source (contributors):** `start` launches the compiled server at `server/dist/index.js`. On a source-only checkout where nothing is built yet, it falls back to running `server/index.ts` with `tsx`, so you can start the server without a build step.

### Stop it

```bash
specrails-desktop stop
```

Sends `SIGTERM` to the app process. The server then shuts down cleanly and removes its own PID file.

### See what it's doing

```bash
specrails-desktop status                # server status + registered projects
specrails-desktop --status              # one-shot status, compact text output
specrails-desktop --jobs                # see the note below
```

`--status` prints a compact status line that includes the app version. The bare `status` subcommand prints whether the app is running (with its PID and URL) plus the registered project count and names — but no version. Both are plain text, handy to read or grep, not JSON.

> **Note on `--jobs`:** there is no app-level `/api/jobs` route, so the server returns 404 and `--jobs` prints `jobs history requires manager with SQLite persistence (#57)` and exits non-zero against a running server. Job history lives **per project** — view it on the project's **Jobs** page (right sidebar) in the dashboard instead.

## Manage projects

### List

```bash
specrails-desktop list
```

Prints every registered project in three columns: **ID**, **NAME**, **PATH**.

### Add

```bash
specrails-desktop add .                 # register the current directory
specrails-desktop add /path/to/project  # or an explicit path
```

Registers the project with the app. The path can be **absolute or relative** (it's resolved against your current directory) and must exist. If the project doesn't have specrails-core installed, the next dashboard visit triggers the setup wizard.

### Remove

```bash
specrails-desktop remove <project-id>
```

Unregisters the project (use the **ID** from `specrails-desktop list`). Does **not** delete the project directory or its specrails-core installation. To re-register, just `add` it again — job history under `~/.specrails/projects/<slug>/jobs.sqlite` is preserved.

## Run things in the active project

`specrails-desktop` auto-detects which project you're in by matching your **exact** current directory against registered project paths. Run commands from the project's **root directory** — subdirectories are **not** auto-resolved (path matching is exact, with no parent-directory walking). From anywhere else, use `--project`.

If the app is running but no project is registered for your directory, you'll see:

```
[specrails-desktop] error: server is running but no project registered for the current directory.
  Run: specrails-desktop add <cwd>
```

> **Troubleshooting auth:** when talking to a running server, the CLI reads `~/.specrails/desktop.token` (legacy fallback: `~/.specrails/hub.token`) and attaches it as a `Bearer` token on every request. The token file must contain at least 32 characters to be used. If CLI commands fail against a server you know is running, check that this token file exists and matches the one the server is using.

### Implement a spec

```bash
cd ~/repos/my-app
specrails-desktop implement "#42"
```

This is shorthand for `specrails-desktop /specrails:implement "#42"` — the app queues a rail job that you can monitor in the Dashboard. Token usage and cost are tracked in Analytics.

### Implement a batch

```bash
specrails-desktop batch-implement "#40" "#41" "#43"
```

Shorthand for `/specrails:batch-implement` — runs the listed specs in one dependency-aware job.

### Health check

```bash
specrails-desktop health-check
```

Runs `/specrails:health-check`: a comprehensive codebase health pass (tests, linting, coverage, complexity, dependency audit), comparing against previous runs to surface regressions.

### Compatibility check

```bash
specrails-desktop compat-check
```

Runs `/specrails:compat-check`: snapshots the current API surface and detects breaking changes against a prior baseline, generating a migration guide when breaking changes are found.

### Known verbs

These are all shorthand for `/specrails:<verb>` — the app auto-prefixes:

| Verb | What it does |
|------|--------------|
| `implement` | Queue a rail job for one spec |
| `batch-implement` | Queue one job that implements many specs |
| `why` | Explain why a chunk of code looks the way it does |
| `propose-spec` | Explore an idea and produce a structured spec proposal |
| `get-backlog-specs` | View the prioritised spec backlog |
| `auto-propose-backlog-specs` | Auto-propose new spec ideas from the backlog |
| `refactor-recommender` | Scan the codebase and recommend high-leverage refactors |
| `health-check` | Run the codebase health check |
| `compat-check` | Detect breaking API changes against a baseline |
| `enrich` | Run the agent enrichment workflow |

### Pass a raw prompt

Anything that isn't a known verb (or starts with `/`) is forwarded verbatim to your AI CLI in the project directory:

```bash
specrails-desktop "summarise the changes since main"
specrails-desktop /opsx:ff
specrails-desktop /any:custom:command "with arguments"
```

The app still tracks cost in Analytics under `surface=job`.

### Target a specific project from anywhere

```bash
specrails-desktop --project my-app implement "#42"
specrails-desktop --project ~/repos/api-srv batch-implement "#5" "#6"
```

`--project` accepts a project **name** or a **path** (absolute, or relative starting with `.` / `..`). Use it when you want to launch work in a project from outside its directory (e.g. from a CI runner or your home directory). Both `--project` and `--port` may appear **anywhere** in the command, not just at the front.

## Providers

The app supports three AI providers — **Claude, Codex, and Gemini** — and all three are enabled by default. Each project is configured with one or more of them when you add it.

The CLI itself has **no provider flag**: a CLI-routed job always launches the project's **primary provider** (the first one you selected when you added the project). To pick a different engine for a single spec or rail on a multi-provider project, use the **dashboard** — the Add Spec engine selector or the rail-header engine selector. Provider guides: [Codex](codex.md) and [Gemini](gemini.md).

> **Ops note:** to constrain which providers the dashboard offers, set `SPECRAILS_CODEX_BETA=0` or `SPECRAILS_GEMINI_BETA=0` in the server's environment (only the exact string `0` disables a provider; unset, `1`, or `true` all leave it enabled). This affects the dashboard's provider picker, not the CLI, which has no engine flag.

## OpenSpec workflow

Bundled `opsx:*` commands for structured change management of the app itself. Run them from the project directory:

```bash
specrails-desktop /opsx:new          # start a new change
specrails-desktop /opsx:ff           # fast-forward — create all artifacts in one go
specrails-desktop /opsx:continue     # step through artifact creation one at a time
specrails-desktop /opsx:apply        # implement the change in this conversation
specrails-desktop /opsx:verify       # completeness / correctness / coherence review
specrails-desktop /opsx:sync         # sync delta specs to main specs (no archive)
specrails-desktop /opsx:archive      # archive to openspec/changes/archive/
```

`opsx:apply` and `opsx:verify` run **in the conversation** — `apply` edits code and flips tasks from `- [ ]` to `- [x]`; `verify` reads the change artifacts and writes a completeness/correctness/coherence report. They do **not** queue a server job or spawn the Architect → Developer → Reviewer pipeline (that's the separate `/specrails:implement` flow). Full lifecycle reference: [internals/openspec-workflow.md](internals/openspec-workflow.md).

## Diagnostic flags

| Flag | What it does |
|------|--------------|
| `--port <n>` | Connect to (or start) the app on a non-default port |
| `--project <name\|path>` | Target a specific project from anywhere |
| `--status` | One-shot status print (compact text) |
| `--jobs` | Print job history (per-project only — see the note above) |
| `--version`, `-v` | Print the CLI version and exit |
| `--help`, `-h` | Print usage and exit |

## When the app isn't running

If you invoke a command that routes work (`implement`, `batch-implement`, a raw prompt, …) while the app is not running, the CLI falls back to spawning the **`claude`** binary directly in the current directory. You'll see:

```
[specrails-desktop] manager not running — invoking claude directly
```

This fallback has two important limitations:

- **It always spawns `claude`** — even on a project whose primary provider is Codex or Gemini. The offline path does not honour the project's configured provider, so an offline run can behave differently from the same command run through the app.
- **Nothing is recorded.** There's no queue, no job in the Dashboard, and nothing written to Analytics.

Start the app first (`specrails-desktop start`) if you want the job to use the right provider and show up in the dashboard.

## Where to go next

- [Getting started](getting-started.md) — install and onboard.
- [Running pipelines](running-pipelines.md) — what happens when you `implement`.
- [Internals: API reference](internals/api-reference.md) — what the CLI actually calls.
