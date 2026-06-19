# Plugins (Integrations)

The **Integrations** section is a per-project marketplace of optional add-ons that extend what the AI can do. Each project decides independently which plugins it wants — installing a plugin in one project never touches another.

Plugins work by quietly registering an **MCP server** (Model Context Protocol) into your project, giving the AI new tools to call during rails and chat. You don't have to understand MCP to use them — install, and they're available the next time a rail runs.

## What's available today

This version ships **bundled-only**: the plugins you can install are the ones built into the app. There's no remote registry, no user-uploaded plugins, and no third-party code loading — so everything in the catalog is vetted and shipped with Specrails.

The headline plugin is:

- **Serena** — semantic code navigation. It gives the AI language-server-backed understanding of your codebase (jump-to-definition, find references, symbol-aware search) instead of plain text matching. Great for larger or unfamiliar repos where you want the agent to reason about real symbols.

  Serena requires the `uv` tool on your `PATH` (it runs via `uvx`). The app auto-detects whether `uv` is present and tells you if it's missing.

## Installing a plugin

1. Open **Integrations** from the right sidebar.
2. Find the plugin in the catalog. Each card shows a status: **Not installed**, **Installed**, **Degraded**, or **Orphan**.
3. Click into the plugin to **preview the install** — this shows you exactly what files will change before anything happens.
4. Click **Install**. You'll see live progress as it sets up.

Under the hood the install is *surgical and additive*: it only adds its own entries to your project's `.mcp.json` (and, for some plugins, a fragment file in the protected `.claude/agents/` namespace). It never rewrites your config wholesale, and adding a second plugin can never disturb the first. If the install can't verify itself as healthy, it rolls back cleanly.

## Managing installed plugins

- **Health.** Each plugin has an on-demand health check. A plugin that installs fine but later can't start up is marked **Degraded** — it won't block your rails, you'll just see the badge and a reason.
- **Uninstall.** Removing a plugin surgically deletes only the entries it owns, leaving the rest of your config untouched.
- **Orphans.** If a plugin's files are left behind without proper state (for example after an interrupted change), it shows as an **Orphan** and you can clean it up with one click.

## How plugins show up in your work

- **Rails.** Before a rail runs, Specrails checks which plugins are installed and healthy, and makes those tools available to the agent for that job. A degraded plugin is simply skipped for that run — the rail still launches normally. Each job records a snapshot of which plugins were active, which you can see in the job's diagnostic export.
- **Chat.** Chat automatically picks up your project's MCP config, so installed plugins are available there too.
- **Setup.** Plugins are ignored while a project is still being set up — they come into play once the project is ready.

## Provider notes

Plugins are provider-aware. Serena and similar MCP plugins resolve for providers that register MCP through the project's `.mcp.json` (Claude and Gemini). For Codex projects, MCP servers are managed through Codex's own global config instead, so plugin entries in **Integrations** are filtered accordingly. The Jira card in Integrations is provider-agnostic and shows for everyone — see the Jira guide.

## Reserved files

Plugins manage a small, well-defined set of files in your project: your `.mcp.json` (merged surgically), some state under `.specrails/plugins/`, and per-plugin agent fragments at `.claude/agents/custom-<plugin>.md`. These are committable team assets if you want to share an integration with your teammates — the app never blindly overwrites them.