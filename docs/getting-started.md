# Getting started

This guide walks you from "I just heard about specrails-desktop" to "I just shipped my first AI-driven change" in about ten minutes. No prior knowledge of specrails-core required — the app sets it up for you.

## What you'll need

- A project you want to work on (any Git repository works)

If you install with **npm** (Option 2 below) you'll also need **Node.js 20+** and **`git`** on your PATH. The **desktop app** bundles its own Node and Git runtimes, so you don't need those installed separately.

That's it. specrails-desktop sets up specrails-core for each project automatically, outside your repository.

## Install

Two options:

### Option 1 — Desktop app (recommended)

Download a signed build for your OS from the [latest GitHub Release](https://github.com/fjpulidop/specrails-desktop/releases/latest) (the **Download** button on [specrails.dev](https://specrails.dev) links the same files):

- **macOS** — `specrails-desktop-<version>-aarch64.dmg` (Apple Silicon, notarised)
- **Windows** — `specrails-desktop-<version>-x64-setup.exe` (NSIS; `-arm64-setup.exe` on ARM64)

Open the installer, drag to Applications (macOS) or click through the wizard (Windows). The app bundles the server, so you don't need a separate process. The desktop app resolves your PATH for you at startup — no manual Homebrew/Volta/nvm setup needed — see [platforms/macos.md](platforms/macos.md) if anything looks off.

> First Windows launch shows a SmartScreen warning until the installer is code-signed. Click **More info → Run anyway**. Details and hash-verification steps in [platforms/windows.md](platforms/windows.md).

### Option 2 — npm

```bash
npm install -g specrails-desktop
specrails-desktop start
```

By default the app binds to `http://127.0.0.1:4200`. Open it in your browser.

## Add a project

There are two ways. Pick whichever feels natural.

**From the dashboard:** click **+ Add project** in the sidebar. Choose **Existing project** and pick the repository folder (the display name defaults to the folder name), or choose **New project** to describe an idea and let the Project Builder bootstrap a repository with a Milestone-1 backlog (see [Project builder](internals/project-builder.md)).

**From the CLI:**

```bash
specrails-desktop add /path/to/your/project
specrails-desktop list   # verify
```

### What happens after you add it

There is no setup wizard. The project registers immediately and Specrails assembles its workspace in the background:

- **AI CLIs are auto-detected.** The app uses every supported CLI it finds on your machine (Claude, Codex). If none is detected, the Add Project dialog shows a warning, but registration is never blocked; the project picks up a provider as soon as one is detected.
- **The workspace lives outside your repository.** For each detected provider the app runs specrails-core `init` (from the bundled Core in the desktop app, or `npx specrails-core@^6.0.0` when no bundle is present) into `~/.specrails/projects/<slug>/workspace`. Your repository stays pristine: the framework files are not scaffolded into it.
- **Progress shows on the project's sidebar entry.** A small indicator ("Setting up workspace…") appears while assembly runs. If a provider fails, the entry shows "Workspace setup failed — click to retry"; the retry only re-runs the providers that failed.
- **Roles and models are configured in the app, not installed as files.** The pipeline roles (`sr-architect`, `sr-developer`, `sr-reviewer`) are defined by the Core engine's runtime; their provider and model live in **Settings → Agent runtime**. Per-agent overrides live in agent profiles on the **Agents** page.

The Core version is pinned to the major the app ships with (Core 6); it never silently jumps to a new major. Newer Core releases within that major are offered through the voluntary update channel (see [Core runtime updates](internals/core-runtime-updates.md)).

## Your first spec

A "spec" is a description of work you want done. specrails-desktop gives you two ways to author them.

### Quick mode — one-shot generation

When you already know what you want:

A compatible AI CLI generates the full spec in one turn. A small toast at the
bottom right shows the project, the spec title, and live elapsed time
("Generating… 0:12") — it turns into a success or failure toast (with a
**View** action) when generation finishes.

### Explore mode — converse with the AI

When the spec needs shaping:

1. Click **+ Add Spec → Explore**.
2. (Optional) pick a context preset from the slider — `Minimal` (just your message) up to `Desktop` (the full codebase + Contract Layer enrichment + project and user-approved MCPs).
3. Type a starting message. The AI responds with a live draft below.
4. Iterate. Each turn updates the draft.
5. Click **Save as Draft** to come back later, or **Create Spec** when the draft looks right.

The committed spec lands on your board with status `todo`.

## Run your first pipeline

The right pane of the Dashboard is your **Rails** — execution lanes:

1. Drag a spec card from the left pane onto a Rail.
2. Pick a **Loop** in the rail header — start with the built-in **Implement** (the full pipeline). You can also pick **Freestyle**, **SDD Quick (OpenSpec)**, or a custom loop you built in the **Loops** section. See [Running pipelines → Loops](running-pipelines.md#loops).
3. (Optional) pick an **agent profile** from the rail header. This picker only appears once the project has profiles (create them on the **Agents** page); otherwise the rail runs in legacy mode (single orchestrator, no per-agent overrides).
4. Press **▶ Play** on the rail.

The rail flips to running. The Jobs page (right sidebar) streams the AI's output live. When the slash command defines them, you'll see the pipeline phases progress: Architect → Developer → Reviewer → Ship.

- **Jobs page** — each job has a status panel with live counters and a `JobTicketHeader` chip for every ticket the job touched (click to open).
- **Analytics page** — burn rate, top tickets, daily timeline (see [Tracking cost](tracking-cost.md)).
- **The spec's detail modal** — a one-line spending summary linking back to Analytics filtered by that ticket.

## What's next?

- **[Creating specs](creating-specs.md)** — drafts, SMASH (decompose epics), Continue Editing (refine specs in place), Compare (side-by-side review).
- **[Running pipelines](running-pipelines.md)** — agent profiles, plugins (Serena), telemetry export.
- **[Tracking cost](tracking-cost.md)** — analytics deep dive and CSV exports.
- **[Codex](codex.md)** — using the Codex CLI as a provider, alongside or instead of Claude.
- **[Terminal panel](terminal.md)** — the built-in per-project terminal (toggle with `Cmd/Ctrl+J`).
- **[Customising the app](customizing.md)** — themes, terminal settings, kill switches.
- **[CLI reference](cli.md)** — drive specrails-desktop from the terminal.

## Troubleshooting

**"Port 4200 already in use" on start**

```bash
specrails-desktop stop                # stops the running server cleanly
# or kill the process holding the port
lsof -i :4200    # macOS / Linux
```

On macOS, this usually means the app was launched from Finder/Dock and didn't pick up Homebrew/Volta paths. The app resolves PATH at startup automatically, but if it still fails, see [platforms/macos.md](platforms/macos.md).

**The sidebar shows "Workspace setup failed"**

Click the entry to retry. If it keeps failing, the usual causes are a missing Node runtime in the environment that launched the app (npm installs only; the desktop app bundles Node) or an AI CLI that isn't authenticated:

- **Claude** — sign in to the `claude` CLI or set `ANTHROPIC_API_KEY`.
- **Codex** — sign in to the `codex` CLI.

Click **Copy diagnostics** in the install-instructions modal — that prints the resolved PATH, where the app found each tool, and login-shell status. Paste it into a bug report if you can't figure it out.

**More**

Operational issues (port conflicts, stale PID files, database corruption) are covered in the [Operations runbook](internals/operations-runbook.md).
