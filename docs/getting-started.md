# Getting started

This guide walks you from "I just heard about specrails-desktop" to "I just shipped my first AI-driven change" in about ten minutes. No prior knowledge of specrails-core required — the app installs it for you.

## What you'll need

- **An AI CLI signed in** — [Claude Code](https://claude.com/claude-code) (via Claude subscription login or an `ANTHROPIC_API_KEY`), the [Codex CLI](codex.md) (`codex` ≥ 0.128.0), or the [Gemini CLI](gemini.md) (`gemini` ≥ 0.11.0, with `GEMINI_API_KEY` set). You can mix and match — install Claude, Codex, Gemini, or any combination.
- A project you want to work on (any Git repository works)

If you install with **npm** (Option 2 below) you'll also need **Node.js 20+** and **`git`** on your PATH. The **desktop app** bundles its own Node and Git runtimes, so you don't need those installed separately.

That's it. specrails-desktop will install specrails-core in your project on first run if it isn't there yet.

## Install

Two options:

### Option 1 — Desktop app (recommended)

Download a signed build for your OS from `https://specrails.dev/downloads/specrails-desktop/latest/`:

- **macOS** — `specrails-desktop-<version>-aarch64.dmg` (Apple Silicon, notarised)
- **Windows** — `specrails-desktop-<version>-x64-setup.exe` (NSIS) or `.msi`

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

**From the dashboard:**

1. Click **+** in the left sidebar.
2. Enter the absolute path to your project (e.g. `/Users/you/repos/my-app`).
3. Pick your **AI providers**. Check **Claude**, **Codex**, **Gemini**, or any combination — the first one in the list (Claude, then Codex, then Gemini) that you check becomes the project default. The provider set is fixed once the project is created.
4. The prerequisites panel verifies `node`, `npm`, `npx`, `git`. If anything's missing, the panel surfaces OS-aware install commands you can copy.
5. Click **Add**.

**From the CLI:**

```bash
specrails-desktop add /path/to/your/project
specrails-desktop list   # verify
```

> Heads-up: if you run a spec from the CLI while no app server is running, the offline fallback always invokes `claude` — regardless of the project's primary provider — and records nothing to Analytics. Start the app (or `specrails-desktop start`) to use Codex or Gemini and to capture cost tracking.

### If the project doesn't have specrails-core yet

The setup wizard runs automatically. Three steps:

1. **Configure** — choose which agents to install (the baseline trio `sr-architect`, `sr-developer`, `sr-reviewer` is always selected; optional agents like Test Writer or Security Reviewer are opt-in). Pick a model preset (Balanced / Budget / Max) and optionally override the model per agent.
2. **Install** — the app runs the installer (`npx --yes --prefer-online specrails-core@^4.8.0 init --yes --from-config <config>`) non-interactively and streams the output live. The version is pinned to the core release the app ships with — it never silently jumps to a new major.
3. **Done** — a summary tells you how many agents and commands landed. Click **Continue to project**.

That's the whole onboarding. No tier picker, no second wizard. You can manage agents and their per-agent models later from the **Agents** page (Profiles tab).

## Your first spec

A "spec" is a description of work you want done. specrails-desktop gives you two ways to author them.

### Quick mode — one-shot generation

When you already know what you want:

1. On the Dashboard, click **+ Add Spec → Quick**.
2. Type a one-line title (e.g. *"Add a webhook retry with exponential backoff"*).
3. (Optional) toggle **Enrich with Contract Layer** to get a structured block of names, data shapes, invariants, and a file touch list appended to the description. (Contract Layer enrichment is a Claude-only feature — on Codex and Gemini projects the toggle is shown but the refinement step is skipped.)
4. Hit Enter.

Your AI CLI generates the full spec in one turn. A small toast at the bottom right shows the project, the spec title, and live elapsed time ("Generating… 0:12") — it turns into a success or failure toast (with a **View** action) when generation finishes.

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
2. Pick a **Loop** in the rail header — start with the built-in **Implement** (the full pipeline). You can also pick **Batch**, **Freestyle**, or a custom loop you built in the **Loops** section. See [Running pipelines → Loops](running-pipelines.md#loops).
3. (Optional) pick an **agent profile** from the rail header. This picker only appears once the project has profiles (create them on the **Agents** page); otherwise the rail runs in legacy mode (single orchestrator, no per-agent overrides).
4. Press **▶ Play** on the rail.

The rail flips to running. The Jobs page (right sidebar) streams the AI's output live. When the slash command defines them, you'll see the pipeline phases progress: Architect → Developer → Reviewer → Ship.

Token usage, duration, and cost are tracked per turn and surface in:

- **Jobs page** — each job has a status panel with live counters and a `JobTicketHeader` chip for every ticket the job touched (click to open).
- **Analytics page** — burn rate, top tickets, daily timeline (see [Tracking cost](tracking-cost.md)).
- **The spec's detail modal** — a one-line spending summary linking back to Analytics filtered by that ticket.

## What's next?

- **[Creating specs](creating-specs.md)** — drafts, SMASH (decompose epics), Continue Editing (refine specs in place), Compare (side-by-side review).
- **[Running pipelines](running-pipelines.md)** — agent profiles, plugins (Serena), telemetry export.
- **[Tracking cost](tracking-cost.md)** — analytics deep dive and CSV exports.
- **[Codex](codex.md)** — using the Codex CLI as a provider, alongside or instead of Claude.
- **[Gemini](gemini.md)** — using the Gemini CLI as a provider, alongside or instead of Claude.
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

**Your AI CLI (`claude`, `codex`, or `gemini`) isn't found inside the app**

On macOS, this usually means the app was launched from Finder/Dock and didn't pick up Homebrew/Volta paths. The app resolves PATH at startup automatically, but if it still fails, see [platforms/macos.md](platforms/macos.md).

**The setup wizard fails on `npx specrails-core init`**

Most likely Node is missing from the shell environment that launched the app, or whichever AI CLI your project uses isn't authenticated:

- **Claude** — sign in to the `claude` CLI or set `ANTHROPIC_API_KEY`.
- **Codex** — sign in to the `codex` CLI.
- **Gemini** — make sure `gemini` is on your PATH and `GEMINI_API_KEY` is set (headless spawns can't use the interactive "Login with Google" flow).

Click **Copy diagnostics** in the install-instructions modal — that prints the resolved PATH, where the app found each tool, and login-shell status. Paste it into a bug report if you can't figure it out.

**More**

Operational issues (port conflicts, stale PID files, database corruption) are covered in the [Operations runbook](internals/operations-runbook.md).
