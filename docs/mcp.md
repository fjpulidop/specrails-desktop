# The Specrails MCP server

Specrails Desktop can expose itself to **any MCP client** — Claude Desktop,
Claude Code, Cursor, or your own agent — as a local
[Model Context Protocol](https://modelcontextprotocol.io) server. Turn it on
and an external LLM can drive the whole dashboard: list your projects, read and
create specs, launch the AI pipeline, watch jobs settle, inspect analytics, and
more — through ~18 well-described tools instead of clicking around the UI.

> **Just want to get going?** Open **Settings ▸ MCP**, flip **Enable MCP** on,
> click **Copy client config**, and paste it into your MCP client. By default
> only **read** actions are allowed; turn on the **Write** / **AI-spawn** /
> **Destructive** tiers when you want the agent to actually change things or
> spend money. Everything below is detail for when you need it.

This is the **app talking to an outside agent** — the opposite direction from
the [Serena plugin](running-pipelines.md#plugins) or
`codex mcp add`, where Specrails *consumes* an MCP server. Here Specrails *is*
the server.

The MCP server is **off by default** and entirely local: it listens only on
loopback (`127.0.0.1`), is authenticated by a token separate from the app's
master token, and serves nothing until you explicitly enable it in Settings.

## What the MCP exposes

When enabled, the server registers a compact catalog of **domain-facade tools**
plus a few **meta tools**, a set of read-only **resources**, and a self-contained
**guide** an LLM can read to learn the platform with no prior knowledge.

### Tools (~18)

Each domain is a single tool with an `action` enum, rather than dozens of
narrow tools — so the catalog stays small and an agent discovers actions by
reading one description. The tools are:

| Tool | What it covers |
|---|---|
| `specrails_projects` | List / resolve projects; unregister (destructive) |
| `specrails_specs` | The spec/ticket backlog: list, get, create, update, delete, drafts, AI generate, AI-edit, Contract Refine, SMASH, per-ticket spend |
| `specrails_rails` | Assign tickets to a rail, configure it, and launch the pipeline |
| `specrails_jobs` | Inspect, stream, and stop pipeline jobs |
| `specrails_chat` | Explore / sidebar chat conversations and turns |
| `specrails_agents` | Agent profiles and the agents catalog (Claude-only features) |
| `specrails_plugins` | The per-project plugin marketplace (install / verify / uninstall) |
| `specrails_jira` | The Jira integration (connect, sync, outbox) |
| `specrails_loops` | Saved loop workflows |
| `specrails_code` | The read-only code explorer (tree, file, summaries, provenance) |
| `specrails_setup` | Add-project setup wizard surface |
| `specrails_analytics` | Per-project spending analytics + budget |
| `specrails_settings` | App-level settings |
| `specrails_watch` | Await the real result of an async (cost-incurring) action |
| `specrails_guide` | Returns the platform guide — read this first |
| `specrails_search` | Find the right tool/action for an intent |
| `specrails_describe` | Full description + input schema for a named tool |
| `specrails_select_project` | Set an active project so later calls can omit `projectId` |

Almost every domain tool is **project-scoped** and takes a `projectId`. Calling
`specrails_select_project` first lets later calls omit it.

### Resources

Read-only state is also exposed as MCP **resources** so a client can fetch it
without a tool call:

- `specrails://guide` — the platform guide (concepts, workflow, invariants).
- `specrails://projects` — all registered projects.
- `specrails://projects/{projectId}` — a single project.

### Async results — `specrails_watch`

Cost-incurring and streaming actions (launch a rail, generate a spec, send a
chat turn, AI-edit, Contract Refine, SMASH) **return immediately** with a
reference (a `jobId` / `requestId`) and emit their **real** result over the
app's WebSocket bus. An agent gets the actual outcome by calling
`specrails_watch` with that reference; it waits for the operation to settle and
returns the final result. Don't assume success from the acceptance alone — this
is spelled out in `specrails_guide`.

## The four permission tiers

Every tool declares one tier. The server refuses any tool whose tier is not
enabled, and the refusal **names the tier the user must turn on** so the agent
can relay it rather than retrying blindly. The tiers are **opt-in and
cumulative** — read is always on, the rest are off until you enable them in
**Settings ▸ MCP**:

| Tier | Default | What it allows |
|---|---|---|
| **Read** | Always on | Queries + resources (list specs, read analytics, inspect jobs) |
| **Write** | Off | Mutating but non-destructive, non-spawn: create/edit specs, change settings, configure a rail |
| **AI-spawn** | Off | Actions that spawn an AI CLI and **cost money**: launch a rail, generate a spec, send a chat turn |
| **Destructive** | Off | Delete data, kill processes, or mutate an external system (e.g. unregister a project, `smash_undo`, Jira writes) |

The split is deliberate: a client you only half-trust can be left read-only;
**destructive and cost-incurring actions are opt-in** and never happen by
accident. A tool's tier is dynamic per action — e.g. `specrails_specs(list)` is
read while `specrails_specs(delete)` is destructive — so the same tool exposes
different actions at different trust levels.

## Enabling it

1. Open the app and go to **Settings ▸ MCP**.
2. Toggle **Enable MCP**. This boots the embedded transport immediately — no
   app restart. (Behind the scenes it persists `mcp_enabled` and starts serving
   `/api/mcp`.)
3. Enable the permission tiers you want (**Write** / **AI-spawn** /
   **Destructive**). Leave them off to keep the agent read-only.
4. Click **Copy client config** to grab a ready-to-paste configuration, or
   **Copy token** if your client needs the raw token (for the direct-HTTP path
   below).

Toggling the enable switch off again tears down all open MCP sessions
immediately.

## Connecting a client

There are two ways to connect, and **the stdio bridge is the recommended,
universal one.**

### Option A — the stdio bridge `specrails-mcp` (recommended)

Most MCP clients (Claude Desktop, Claude Code, Cursor) speak MCP over **stdio**:
they launch a command and talk to it on stdin/stdout. Specrails ships a tiny
relay, **`specrails-mcp`**, bundled with the app. It transparently forwards MCP
stdio from your client to the embedded HTTP server on loopback — and it reads
the scoped token from `~/.specrails/mcp.token` **locally**, so the token never
appears in your client's config file.

A typical client config looks like:

```json
{
  "mcpServers": {
    "specrails": {
      "command": "specrails-mcp"
    }
  }
}
```

Use the exact command/path from the panel's **Copy client config** button — it
fills in the path to the bundled bridge for your platform. No token, no URL, no
port to manage; the bridge handles all of it. If the Specrails app isn't
running, the bridge replies with a clear *"Specrails app is not running. Start
the Specrails Desktop app, then retry."* rather than a cryptic connection error.

### Option B — the direct HTTP URL (remote-HTTP clients)

Clients that speak MCP's **streamable-HTTP** transport directly can skip the
bridge and connect to:

```
http://127.0.0.1:4200/api/mcp
```

with the scoped token in either header form (both are accepted):

```
Authorization: Bearer <your mcp token>
X-Desktop-Token: <your mcp token>
```

Get the token from **Settings ▸ MCP ▸ Copy token** (or read
`~/.specrails/mcp.token`). The endpoint is **loopback-only** — it rejects any
request that doesn't originate from `127.0.0.1`, so this path is for local
HTTP-capable clients, not for exposing Specrails on a network. (`4200` is the
default app port; if you've changed it, the panel's config reflects the real
one.)

#### One-liners for the common CLIs

**Claude Code** (HTTP transport):

```bash
claude mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <your mcp token>"
```

**Gemini CLI** (HTTP transport — same shape):

```bash
gemini mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <your mcp token>"
```

**Codex CLI** (stdio — register the bundled bridge; copy the exact bridge
command from **Settings ▸ MCP ▸ Copy config**, it embeds the app's bundled
Node + script path):

```bash
codex mcp add specrails -- <bridge command from Settings ▸ MCP>
```

## Security model

- **A scoped token, not the master token.** The MCP surface is authenticated by
  its own token at `~/.specrails/mcp.token` (mode `0600`), completely separate
  from the app's all-powerful master token (`~/.specrails/desktop.token`). The
  master token grants terminals (shell), arbitrary AI-CLI spawns, and project
  admin; handing that to a third-party MCP client would be a security smell. The
  scoped token only reaches the four tiered surfaces above. You can rotate it
  any time with **Regenerate token** in Settings — the old token stops working
  immediately.
- **Loopback only.** Both the transport (`/api/mcp`) and the admin control plane
  (`/api/mcp-admin`) require the request to come from `127.0.0.1`. There is no
  network ingress; an MCP client must run on the same machine.
- **Tiers, not blanket access.** Even with a valid token, an agent can only do
  what the enabled tiers allow (read by default). High-risk actions stay opt-in.
- **The app must be running.** The MCP server is embedded in the desktop app's
  process — there is no standalone daemon. The Tauri shell keeps it alive even
  when you close the main window: closing the window **minimizes to the system
  tray / menu bar** and leaves the embedded server running, so your MCP client
  stays connected. The server stops only when you choose **Exit** from the tray
  menu (or the OS truly quits the app). If the app isn't running, the bridge
  tells you to start it.

## v1 limitations — what is *not* exposed

The tool catalog deliberately leaves the highest-risk execution vectors out of
v1. None of these are reachable over MCP:

- **Terminal shell execution.** The built-in terminal panel runs arbitrary
  shell commands; the MCP surface does **not** expose it. An agent cannot run
  shell on your machine through Specrails.
- **Browser capture.** No browser navigation / screenshot / capture tool.
- **In-app file write.** The code explorer is **read-only** over MCP — there is
  no source-file overwrite tool (`code_write_file`). An agent can read files and
  AI-generated summaries, but cannot edit your code directly through MCP. (AI
  *rails* still write code — that's the pipeline, gated behind the AI-spawn
  tier — but there is no direct file-overwrite tool.)
- **The prerequisite installer.** The `uv`/remote-script prerequisite installer
  is not exposed, so an agent cannot trigger remote-script installs.
- The global Claude marketplace / `~/.claude/settings.json` mutation is also
  out of scope.

These boundaries are intentional and may be revisited in a later version.

## Troubleshooting

**My client can't connect / "app is not running"** — start the Specrails
Desktop app. The MCP server is embedded in the app process; it isn't a separate
daemon. If the window is hidden, the app is still running in the tray/menu bar —
look for the Specrails icon there. Only the tray **Exit** stops the server.

**Every tool is refused with a "permission tier" message** — the action needs a
tier you haven't enabled. Open **Settings ▸ MCP** and turn on **Write** /
**AI-spawn** / **Destructive** as appropriate. Read-only actions work with no
extra tiers.

**`401 Unauthorized: invalid MCP token`** (direct-HTTP path) — the bearer token
is wrong or stale. Re-copy it from **Settings ▸ MCP ▸ Copy token**, or
**Regenerate token** and update your client. The stdio bridge avoids this
entirely (it reads the token locally).

**The agent assumed a rail succeeded but it didn't** — cost-incurring actions
return a reference, not a result. The agent must call `specrails_watch` with the
returned `jobId`/`requestId` to get the real outcome. This is documented in
`specrails_guide`; point the agent at it.

**Connection refused on `:4200`** — that's the default app port. If you changed
the port in Settings, use the URL from **Copy client config**, which reflects
the real port. The bridge resolves the port automatically.

## See also

- [Running pipelines](running-pipelines.md) — what rails, jobs, and the
  pipeline an MCP client drives actually do.
- [Creating specs](creating-specs.md) — specs, drafts, SMASH, and Contract
  Refine, all reachable via `specrails_specs`.
- [Tracking cost](tracking-cost.md) — the analytics an agent reads via
  `specrails_analytics`.
- [Customising the app](customizing.md) — other settings, including the budget
  the AI-spawn tier respects.
