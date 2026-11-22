# Control Specrails from any AI (MCP server) {#mcp-server}

Specrails can expose **itself** to any AI assistant that speaks the [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline, or your own agent. Turn it on, point your assistant at Specrails, and you can drive the whole app by chatting: *"list my projects", "create a spec for social login in the API project", "launch rail 0 and tell me when it's done", "how much did I spend this week?"*. Your assistant calls Specrails' tools under the hood instead of you clicking around.

This is the opposite direction from the plugins and "My approved MCPs" features: those let Specrails *use* other MCP servers; this lets other apps use **Specrails**.

## It's on out of the box

It's **on by default** — the server is already running the first time you open the app, no restart, nothing to flip. Open **Settings ▸ MCP** to grab the client config, or to switch it off if you don't want it.

You stay in control of *what* an external AI may do through a set of permission tiers:

| Tier | What it allows | Default |
|---|---|---|
| **Read** | List and inspect projects, specs, jobs, analytics… | Always on (when MCP is enabled) |
| **Write** | Create and edit specs, change settings and rail config | On — untick to restrict |
| **AI-spawn** | Actions that run an AI and **cost money** (launch a rail, generate a spec, send a chat turn) | On — untick to restrict |
| **Destructive** | Delete projects/specs/jobs, stop running work | On — untick to restrict |

All four tiers are granted out of the box, so a connected assistant can drive the whole app right away. Untick any tier you'd rather keep to yourself; if your assistant then tries something that tier covers, Specrails refuses with a clear message telling you which tier to switch back on.

## Connect Claude Code or Codex in one step

Open **Settings ▸ MCP** and click **Connect** next to Claude Code or Codex — or run one command in a terminal:

```bash
specrails-desktop mcp connect --client claude   # or codex
```

Specrails adds itself to the client's own configuration, keeps a backup of the file, writes no access token anywhere, and checks the connection right away (you see how many tools it found). Running it again is harmless. Start a new Claude Code or Codex session afterwards. **Copy command** shows the client's own command if you prefer to run it yourself; for other assistants, use **Copy client config**.

If something doesn't work, run `specrails-desktop mcp doctor`. It checks everything in one go (the app, the access token file, the bridge and the Node that runs it, each client's entry, and a real connection) and gives the fix for each problem. It only looks; it changes nothing. After a Node upgrade (for example with Homebrew), run **Connect** again if your assistant stopped finding Specrails.

**Ask before spending** (same panel, $0.50 by default) is the amount above which a connected assistant must ask you before it starts paid work. Merges, PRs and deletions always ask. Your assistant gets a simple set of 15 tools with ready-made next steps, waiting without polling, answers in your language and slash prompts such as *start-my-day*, *review-waiting*, *ship-milestone* and *why-stuck*. If an older script of yours needs the previous tools, switch off **Simplified MCP tools** in the same panel; Specrails' own missions are not affected.

## For agents only: connect your client

When a person asks an agent to connect, read the [dedicated MCP connection runbook](https://github.com/fjpulidop/specrails-desktop/blob/main/docs/agents/mcp.md). It covers the one-command connect, manual registration for Claude Code and Codex, verification and troubleshooting. Registration alone is not proof of connection: complete `initialize`, `tools/list` and a read-only call.

For a quick look at everything, the assistant calls `specrails_overview`: what is running, what needs you, recent failures, today's spend and the machine's CPU and memory, in one call. `specrails_inbox` reads and answers the **Needs attention** inbox, `specrails_missions` lists and messages your missions, `specrails_specs` and `specrails_rails` show a project's backlog and rails, `specrails_insights` your spend and limits, and `specrails_wait` waits for a run to finish instead of asking over and over. A failed run comes with its diagnosis and the end of its log.

Every answer starts with a short plain-language summary and the possible next steps, with the recommended one marked, and errors say what went wrong and whether retrying helps. Before anything irreversible, or paid work above your limit, the assistant shows you a preview and asks you first. Your yes only works for that exact action and expires if things change in the meantime.

Before acting, the assistant can ask `specrails_overview` for a current briefing on one project: specs, runs and Git state. Unavailable sections are reported explicitly; they do not mean the project is empty. It can also search and read your source code, line by line, without changing it.

Each external MCP session keeps its own selected project. In Mission mode, the default follows the conversation's project pin, which you change in the mission interface; an MCP selection cannot override it. Naming another project in a call targets that project on purpose.

## What you can do with it

A few recipes once your assistant is connected. Everything is on by default; untick **Write** or **AI-spawn** in Settings ▸ MCP if you'd rather it only observe for now.

**Turn work from your other tools into specs.** If your assistant also has GitHub, Jira, Gmail or Slack connected, it can bring the work to Specrails for you:
> *"Take this week's open GitHub issues labelled 'bug', create a spec for each in the API project, and launch them."*
>
> *"Read my latest customer-feedback emails, group them by theme, and create one spec per theme."*

**Overnight autopilot.** Leave it running with the app in the tray and come back to a report:
> *"Here are 12 ideas. Turn each into a spec, launch them three at a time across the rails, watch every job, and tomorrow give me a summary of what finished, what failed and what it cost."*

Untick **Destructive** and it can build all night without ever deleting anything.

**Across all your projects.** Something the dashboard doesn't do on its own:
> *"Check all my projects. Tell me which have specs in the backlog and no rail running, and start the highest-priority one in each."*

**Hands-free while you code.** Drive Specrails from your editor or by voice, without switching windows:
> *"Launch rail 0 with Opus for spec #42 and tell me when it's done."*

**Ask about cost and history.** Your analytics, in plain language:
> *"Where did I spend the most on AI this week, by project and by model? Show me the five most expensive specs."*

**Your daily standup.**
> *"Write my standup: which rails ran yesterday, what completed, what failed, total cost — as bullets ready to paste into Slack."*

**Understand the code.** No editor needed:
> *"Which files did spec #38 touch? Summarise in one line what changed in each."*

Because your assistant reads the built-in guide first, you rarely need to name tools or specs — describe the outcome and it works out the calls.

## A few things to know

- **Specrails must be running.** The MCP server lives inside the app, so your assistant can reach it only while Specrails is open. Thanks to the tray, closing the window keeps it running in the background — only **Exit** from the tray (Mac menu bar / Windows system tray) actually stops it.
- **Long actions stream.** Launching a rail or generating a spec returns immediately and finishes in the background; your assistant can "watch" it and report back when it settles.
- **Security.** The MCP uses its own access token, separate from everything else, and only listens on your own machine (loopback). The token cannot impersonate Agent Mode by supplying tier, project, or conversation headers: the embedded agent uses a private, short-lived, server-minted capability. You can copy or regenerate the scoped token any time from the panel.
- **Not exposed (v1).** For safety, external MCP clients cannot run raw terminal shell commands, use the embedded browser, edit files in-app, or install system prerequisites. Agent Mode has a separate authenticated path for confirmed long-running background commands at Autonomous permission; external clients cannot obtain it by enabling Destructive. Everything else that *manages* Specrails is available.

You can disable MCP at any time from the same panel — your assistant simply loses access, and nothing else changes.
