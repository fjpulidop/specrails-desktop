# specrails-desktop documentation

Welcome. These guides are written for **you, the user**: how to get specrails-desktop running, how to use each feature, and what to do when something looks off.

Specrails works with four AI CLIs — **Claude Code**, **OpenAI Codex**,
**Google Gemini**, and **Kimi Code**. Install any compatible combination per
project and choose which engine runs each task.

If you're contributing to the app itself or building on its API, head over to [`internals/`](internals/) for the technical deep dive.

## Start here

1. [Getting started](getting-started.md) — install the app, register your first project, run your first pipeline. ~10 minutes.

## Doing things

| Guide | Use it when… |
|-------|-------------|
| [Creating specs](creating-specs.md) | …you want to draft a spec, compare two specs, save a draft, split a big epic, or refine an existing spec |
| [Projects with several repositories](multi-repo-projects.md) | …your product spans frontend, backend or other repos and needs one shared backlog |
| [Messages during a mission](agent-live-steering.md) | …you want to give the agent new instructions while it is working |
| [Mission applications and process logs](mission-processes.md) | …you want to launch an application, stop it reliably or inspect its output |
| [Running pipelines](running-pipelines.md) | …you want to launch the AI pipeline against a spec, manage rails, pick agent profiles, or install plugins |
| [Using Codex](codex.md) | …you added a project with OpenAI's Codex CLI instead of (or alongside) Claude |
| [Using Gemini](gemini.md) | …you added a project with Google's Gemini CLI instead of (or alongside) Claude, Codex, or Kimi |
| [Using Kimi](kimi.md) | …you want Kimi Code setup, models/effort, session behavior, MCP, and native limitations |
| [Tracking cost](tracking-cost.md) | …you want to see what AI is costing you and which specs are the most expensive |
| [Customising the app](customizing.md) | …you want to change theme, configure settings, set a budget, or turn on telemetry |
| [Terminal panel](terminal.md) | …you want to use the built-in terminal: shortcuts, shell integration, drag-and-drop |
| [MCP server](mcp.md) | …you want to drive the app from an MCP client (Claude Desktop, Cursor, your own agent) |
| [CLI reference](cli.md) | …you want to drive specrails-desktop from the terminal instead of (or alongside) the dashboard |

## Platform-specific notes

- [macOS](platforms/macos.md) — Finder/Dock launches, PATH resolution, broken-symlink diagnostics
- [Windows](platforms/windows.md) — installer formats, SmartScreen, PowerShell, ConPTY

## Looking for something specific?

- **"How do I install it?"** → [Getting started](getting-started.md#install)
- **"How do I add a project?"** → [Getting started](getting-started.md#add-a-project)
- **"Quick vs Explore mode?"** → [Creating specs › Creating a spec](creating-specs.md#creating-a-spec)
- **"How do I use a different provider?"** → [Using Codex](codex.md) ·
  [Using Gemini](gemini.md) · [Using Kimi](kimi.md)
- **"How do I compare two specs?"** → [Creating specs › Compare two specs side by side](creating-specs.md#compare-two-specs-side-by-side)
- **"What's a draft?"** → [Creating specs › Drafts](creating-specs.md#drafts)
- **"What's SMASH?"** → [Creating specs › SMASH a big spec](creating-specs.md#smash-a-big-spec)
- **"What's a rail?"** → [Running pipelines › Rails](running-pipelines.md#rails)
- **"What's an agent profile?"** → [Running pipelines › Agent profiles](running-pipelines.md#agent-profiles)
- **"How do I install Serena?"** → [Running pipelines › Plugins](running-pipelines.md#plugins)
- **"How much did I spend last week?"** → [Tracking cost](tracking-cost.md)
- **"How do I change the theme?"** → [Customising the app › Themes](customizing.md#themes)
- **"How do I set a daily budget?"** → [Customising the app › Budget](customizing.md#budget)
- **"How do I connect an MCP client (Claude Desktop / Cursor)?"** → [MCP server](mcp.md#connecting-a-client)

## Internals

If you're hacking on the app, building on its API, or just curious about how it works:

- [Architecture](internals/architecture.md) — server modules, client layout, WebSocket protocol
- [API reference](internals/api-reference.md) — REST routes catalogue
- [Configuration](internals/configuration.md) — env vars, kill switches, advanced settings
- [Operations runbook](internals/operations-runbook.md) — start/stop, recovery, backups
- [OpenSpec workflow](internals/openspec-workflow.md) — `opsx:*` change lifecycle (used by the app itself)
- [Profiles deep dive](internals/profiles.md) — agent profile internals
- [Adding a provider](internals/adding-a-provider.md) — one-file guide to wiring a new AI CLI adapter
