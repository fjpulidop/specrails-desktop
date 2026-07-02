# Control Specrails from any AI (MCP server)

Specrails can expose **itself** to any AI assistant that speaks the [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline, or your own agent. Turn it on, point your assistant at Specrails, and you can drive the whole app by chatting: *"list my projects", "create a spec for social login in the API project", "launch rail 0 and tell me when it's done", "how much did I spend this week?"*. Your assistant calls Specrails' tools under the hood instead of you clicking around.

This is the opposite direction from the plugins and "My approved MCPs" features: those let Specrails *use* other MCP servers; this lets other apps use **Specrails**.

## Turning it on

It's **off by default**. Open **Settings ▸ MCP** and flip **Enable MCP**. That's it — the server starts immediately, no restart.

You stay in control of *what* an external AI may do through a set of permission tiers:

| Tier | What it allows | Default |
|---|---|---|
| **Read** | List and inspect projects, specs, jobs, analytics… | Always on (when MCP is enabled) |
| **Write** | Create and edit specs, change settings and rail config | Off — opt in |
| **AI-spawn** | Actions that run an AI and **cost money** (launch a rail, generate a spec, send a chat turn) | Off — opt in |
| **Destructive** | Delete projects/specs/jobs, stop running work | Off — opt in |

If your assistant tries something a disabled tier covers, Specrails refuses with a clear message telling you which tier to switch on. So you can start read-only and open up exactly what you need.

## Connecting your assistant

The panel shows a ready-to-paste configuration block. The simplest, universal path is the bundled **bridge** (`specrails-mcp`): your assistant runs it, and it relays to Specrails for you. The bridge reads the access token locally, so **the token never appears in your assistant's config**.

In a client like Claude Desktop or Cursor, the config looks like:

```json
{ "mcpServers": { "specrails": { "command": "specrails-mcp" } } }
```

Clients that support remote HTTP MCP servers can instead point straight at `http://127.0.0.1:4200/api/mcp` with the token from the panel.

### From the terminal: Claude Code, Gemini CLI, Codex CLI

Copy your token from **Settings ▸ MCP ▸ Copy token**, then:

```bash
# Claude Code
claude mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <your token>"

# Gemini CLI
gemini mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <your token>"

# Codex CLI (stdio — register the bridge command shown in Settings ▸ MCP)
codex mcp add specrails -- <bridge command from Settings ▸ MCP>
```

The `Authorization: Bearer <token>` header works too. If you changed the app port, swap `4200` for yours.

Once connected, your assistant sees about **18 tools** covering the whole app — projects, specs, rails and jobs, chat/Explore, agents, plugins, Jira, loops, the code explorer, analytics, settings — plus a built-in **guide** tool it reads first so it understands how Specrails works without you explaining anything.

## What you can do with it

A few recipes once your assistant is connected. Start with **Read** on, then turn on **Write** and **AI-spawn** when you want it to actually create and launch work.

**Turn work from your other tools into specs.** If your assistant also has GitHub, Jira, Gmail or Slack connected, it can bring the work to Specrails for you:
> *"Take this week's open GitHub issues labelled 'bug', create a spec for each in the API project, and launch them."*
>
> *"Read my latest customer-feedback emails, group them by theme, and create one spec per theme."*

**Overnight autopilot.** Leave it running with the app in the tray and come back to a report:
> *"Here are 12 ideas. Turn each into a spec, launch them three at a time across the rails, watch every job, and tomorrow give me a summary of what finished, what failed and what it cost."*

Keep **Destructive** off and it can build all night without ever deleting anything.

**Across all your projects.** Something the dashboard doesn't do on its own:
> *"Check all my projects. Tell me which have specs in the backlog and no rail running, and start the highest-priority one in each."*

**Hands-free while you code.** Drive Specrails from your editor or by voice, without switching windows:
> *"Launch rail 0 in Freestyle mode with Opus for ticket #42 and tell me when it's done."*

**Ask about cost and history.** Your analytics, in plain language:
> *"Where did I spend the most on AI this week, by project and by model? Show me the five most expensive tickets."*

**Your daily standup.**
> *"Write my standup: which rails ran yesterday, what completed, what failed, total cost — as bullets ready to paste into Slack."*

**Understand the code.** No editor needed:
> *"Which files did ticket #38 touch? Summarise in one line what changed in each."*

Because your assistant reads the built-in guide first, you rarely need to name tools or specs — describe the outcome and it works out the calls.

## A few things to know

- **Specrails must be running.** The MCP server lives inside the app, so your assistant can reach it only while Specrails is open. Thanks to the tray, closing the window keeps it running in the background — only **Exit** from the tray (Mac menu bar / Windows system tray) actually stops it.
- **Long actions stream.** Launching a rail or generating a spec returns immediately and finishes in the background; your assistant can "watch" it and report back when it settles.
- **Security.** The MCP uses its own access token, separate from everything else, and only listens on your own machine (loopback). You can copy or regenerate that token any time from the panel.
- **Not exposed (v1).** For safety, a few high-risk capabilities are intentionally left out: running shell commands in the terminal, the embedded browser, in-app file editing, and installing system prerequisites. Everything that *manages* Specrails is available; raw machine access is not.

You can disable MCP at any time from the same panel — your assistant simply loses access, and nothing else changes.
