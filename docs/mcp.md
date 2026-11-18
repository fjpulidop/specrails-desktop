# The Specrails MCP server

Specrails Desktop can expose itself to **any MCP client** — Claude Desktop,
Claude Code, Codex, Cursor, or your own agent — as a local
[Model Context Protocol](https://modelcontextprotocol.io) server. A connected
agent can drive the whole dashboard: list your projects, read and
create specs, launch the AI pipeline, watch jobs settle, inspect analytics, and
more — through a versioned tool catalog with discoverable action schemas.

> **Just want to get going?** Open **Settings ▸ MCP**, click **Copy client
> config**, then follow the [client-specific agent runbook](agents/mcp.md).
> MCP and all four permission tiers
> are on by default. Disable **Write**, **AI-spawn**, or **Destructive** there
> to restrict external clients. Existing disabled settings survive upgrades.

This is the **app talking to an outside agent** — the opposite direction from
the [Serena plugin](running-pipelines.md#plugins), where Specrails *consumes* an MCP server. Here Specrails *is*
the server.

The MCP server is **on by default** and entirely local: it listens only on
loopback (`127.0.0.1`) and is authenticated by a token separate from the app's
master token, so nothing off your machine can reach it. You can switch it off
at any time in Settings — an explicit off stays off across upgrades.

## What the MCP exposes

When enabled, the server registers a compact catalog of **domain-facade tools**
plus a few **meta tools**, a set of read-only **resources**, and a self-contained
**guide** an LLM can read to learn the platform with no prior knowledge.

### Tools

Each domain is a single tool with an `action` enum, rather than dozens of
narrow tools — so the catalog stays small and an agent discovers actions by
reading one description. The tools are:

| Tool | What it covers |
|---|---|
| `specrails_status` | One cheap app-wide glance: headline, mood (`idle`/`working`/`needs_you`/`failing`), running missions/rails/jobs, what needs the person, recent failures, today's spend, CPU/memory; poll with `ifNoneMatch` |
| `specrails_board` | One project's board: backlog columns (draft → cancelled) with counts and the newest specs, every rail with its label, availability, specs, what runs on it and its delivery, and the queue |
| `specrails_spend` | Spend today or over a period, app-wide or for one project: billed + estimated total, `byCategory` (implementation, missions, specs, code, support), every cap with utilization and whether it is exhausted, the month-end projection, the costliest projects / specs / missions |
| `specrails_resources` | CPU/memory of everything Specrails launched, by category; with `conversationId`, one mission's process trees, history and worktree disk |
| `specrails_inbox` | The "Needs you" inbox: `list`, `open`, `question`; `answer` (write), `resume` / `retry` (AI-spawn) through the routes the desktop and phone use |
| `specrails_missions` | Agent missions: `list`, `active`, `get` (recent messages, context usage), `send` / `ask` (AI-spawn), `abort` (destructive); never changes a mission's permission level, provider or pin |
| `specrails_projects` | List / resolve projects; unregister (destructive) |
| `specrails_context` | Compact live briefing: project/providers, backlog, rails/runs/deliveries, Git/worktrees, blueprint; source and availability per section |
| `specrails_specs` | Read the backlog: `list` (compact page, server-side `cursor`), `search` (`q`), `board` (status columns), `get`, `list_addenda`, `spending_summary`, `files_touched`, attachments |
| `specrails_specs_write` | Change specs: `create` / `generate` (AI, Quick Add Spec), `commit_draft`, `from_prompt`, `update`, `delete` / `restore`, drafts, AI-edit, Contract Refine, SMASH, and **spec addenda** (`add_addendum`, `update_addendum`, `dismiss_addendum`, `reopen_addendum`, `delete_addendum`) — the way to iterate on an existing spec without rewriting its description: an open addendum rides into the next launch on any loop and the packet reports it |
| `specrails_rails` | Configure/launch dynamic rails (`create_rail`, up to 12), inspect PR candidates/review packets; `launch_all` reports outcomes and isolation availability per rail; `list` pages with `limit`/`cursor` |
| `specrails_jobs` | The job queue and individual jobs: `list`, `get` (paged events), `logs` (bounded, failed step first), `diagnose_failure` (diagnosis + saved AI analysis; `generate:true` is AI-spawn), `queue`, `cancel`, `stats`, `spawn`, queue control, exports and audit |
| `specrails_runs` | Core runtime runs: `state`, `diagnose`, `evidence`, `steer`, `resume` (`mode: resume \| recover \| approve`), `settle`, `dismiss`, `cancel` |
| `specrails_background` | Background processes of an in-app agent conversation: `start` / `kill` (destructive, in-app agent only), `list`, `logs` |
| `specrails_chat` | Explore / sidebar chat conversations and turns |
| `specrails_agents` | Provider-scoped agent profiles and catalog; explicit profiles are validated for the selected provider |
| `specrails_plugins` | The per-project plugin marketplace (install / verify / uninstall) |
| `specrails_jira` | The Jira integration (connect, sync, outbox) |
| `specrails_loops` | Saved loop workflows |
| `specrails_code` | File discovery, literal content search, bounded line reads, summaries and provenance; AI summary regeneration is capability-gated |
| `specrails_git` | Repository/branch/worktree information, status, diffs and PR lookup |
| `specrails_env` | Project environment readiness and environment-file management; `get`/`status`/`recheck` report each configured name's value-free resolution status |
| `specrails_support` | Support triage, local diagnostics, specrails-core update workflows (following the app update channel) and `api_meta` (API, app, Core and contract versions) |
| `specrails_setup` | Add-project and per-project install surface (prerequisites, add, install-config, install, checkpoints, abort) |
| `specrails_analytics` | Per-project spending analytics + budget, decision times, loop economics (`loop_economics`) |
| `specrails_settings` | App-level settings |
| `specrails_watch` | Await the real result of an async (cost-incurring) action |
| `specrails_guide` | The platform guide by topic: no `topic` returns the topic index (read it first), `topic` returns one section |
| `specrails_search` | Find tools/actions by English or Spanish intent, including current permission previews |
| `specrails_describe` | Complete nested JSON schema and action tiers; `action` returns one action's fields with their full docs; optionally validate proposed arguments without execution |
| `specrails_select_project` | Set this session's active project so later calls can omit `projectId` |

Almost every domain tool is **project-scoped** and takes a `projectId`. Calling
`specrails_select_project` first lets later calls omit it. Each external MCP
session has its own selection. Mission calls default to the conversation's
project pin; change that pin in the mission UI or use an explicit `projectId`
for an intentional operation in another project. Selecting an MCP default
cannot silently override the mission pin.

`specrails_projects` includes registered projects whose databases are temporarily
unavailable and marks their `available` state. Their absence from the live
execution registry does not mean the project was deleted. `specrails_context`
reports unavailable sections explicitly rather than presenting empty data.

For investigation, fetch the relevant context sections, search source text with
`specrails_code(search)`, and read the returned file ranges. Refresh state after
mutations and inspect `specrails_rails(review_packet)` before assessing a
delivery. Context summaries and truncated searches are partial evidence.

### Results and errors

Every tool answers with one envelope, returned as pretty JSON text **and** as
MCP `structuredContent` (each tool advertises it as its `outputSchema`):

```json
{ "ok": true, "summary": "2 registered projects: Shop, Blog.", "status": "…", "data": { "…": "the tool payload, unchanged" },
  "ids": { "projectId": "p1" }, "next": [{ "tool": "specrails_status", "args": {}, "why": "…" }], "truncated": false, "cursor": null, "partial": false }
```

`summary` is one or two plain sentences an assistant can relay; `data` is the
pre-envelope payload, so existing consumers read one level deeper; `next`
suggests follow-up calls with exact arguments. Failures set `isError` and answer
`{ "ok": false, "summary": "…", "error": { "code", "message", "retryable", "choices"?, "next"? } }`
with stable codes: `not_found`, `invalid_input`, `conflict`, `unauthorized`,
`provider_unavailable`, `rate_limited`, `internal`, `ambiguous` (with the valid
`choices`) and `confirmation_required`. The full contract is in
[MCP response envelope](internals/mcp-response-envelope.md).

#### Moved actions keep working

The tool names are stable. Actions that moved to a new tool stay accepted on
their old tool as **hidden aliases** (accepted at runtime, absent from the
schema and description), so existing clients and prompts keep working:

| Old call | Now |
|---|---|
| `specrails_jobs(runtime_runs \| runtime_diagnose \| runtime_evidence \| runtime_steer \| runtime_settle \| runtime_dismiss \| runtime_cancel)` | `specrails_runs(state \| diagnose \| evidence \| steer \| settle \| dismiss \| cancel)` |
| `specrails_jobs(runtime_resume \| runtime_recover \| runtime_approve)` | `specrails_runs(resume)` with `mode: resume \| recover \| approve` |
| `specrails_jobs(background_start \| background_list \| background_logs \| background_kill)` | `specrails_background(start \| list \| logs \| kill)` |
| `specrails_specs(create, update, delete, commit_draft, …, *_addendum)` | `specrails_specs_write(<same action>)` |

An alias runs with the target's permission tier, Intent exception, validation
and summary, and its arguments are validated against the target tool's schema.

#### Arguments per action

MCP input schemas must be one JSON object, so each tool keeps a flat set of
optional fields. Every action of the split tools declares the fields it takes;
the server checks them before calling the backend and answers `invalid_input`
naming them (`specrails_runs(diagnose) missing "jobId". It takes: jobId (required).`).
`specrails_describe(name)` lists them per action (`takes`, `required`, `oneOf`),
`specrails_describe(name, action)` returns one action with the complete
description of each field it takes, and `specrails_describe(name, arguments)`
validates a call without executing it.

#### Pagination

`specrails_specs(list/search)`, `specrails_rails(list)` and
`specrails_context(backlog)` page on the server: pass `limit`, then the
`nextCursor` you got back as `cursor` (the envelope carries it as `cursor` with
`truncated: true`). The REST routes behind them (`GET /tickets`, `GET /rails`)
keep their full default answer when `limit` is absent.

### Examples

```jsonc
// tools/call specrails_board { "projectId": "p1" }
{ "ok": true, "summary": "Shop: 42 specs (todo 9, in progress 2, on review 3, done 28); 3 rails, 1 running, 2 free, 1 awaiting review.",
  "data": { "columns": [{ "status": "todo", "count": 9, "top": [{ "id": 51, "title": "CSV export" }] }], "rails": [{ "railIndex": 0, "label": "Rail 1", "availability": "busy", "running": { "kind": "loop", "jobId": "run-1" } }], "queue": { "queued": 0, "paused": false } },
  "next": [{ "tool": "specrails_rails", "args": { "action": "review_packet", "prDeliveryId": "d-1", "projectId": "p1" }, "why": "Rail 3 has a delivery waiting for review." }] }

// tools/call specrails_spend { "period": "today" }
{ "ok": true, "status": "ok", "summary": "Spent $4.20 today across 6 runs. Most went to missions ($3.10). Caps: desktop day 42%.",
  "data": { "scope": "app", "totalUsd": 4.2, "byCategory": { "missions": 3.1, "implementation": 1.1 }, "caps": [{ "scope": "desktop", "period": "day", "budgetUsd": 10, "utilizationPct": 42, "exhausted": false }], "top": [{ "kind": "project", "title": "Shop", "usd": 3.9 }] } }

// tools/call specrails_jobs { "action": "get" }   (missing jobId)
{ "ok": false, "summary": "specrails_jobs(get) failed: …", "error": { "code": "invalid_input", "message": "specrails_jobs(get) missing \"jobId\". It takes: jobId (required), eventLimit, eventOffset.", "retryable": false } }
```

### Guide topics

`specrails_guide` is split into topics so an agent loads only what it needs.
Without arguments it returns the index: one line per topic saying when to read
it. `specrails_guide(topic: "<id>")` returns that topic; ids are matched
case-insensitively with `_` or spaces read as `-`, and an unknown id answers
`invalid_input` with the valid ids as `choices`. The topics are
`platform-model`, `mcp-conventions`, `live-user-updates`,
`permissions-and-confirmations`, `support-and-core`,
`failure-diagnosis-and-recovery`, `git-and-local-delivery`,
`intent-and-framing`, `specs-and-drafts`, `contract-refine`,
`smash-and-epics`, `addenda`, `rails-and-launch`, `rail-launch-cards`,
`pr-decisions-and-ci`, `background-processes-and-apps`, `loops`,
`budgets-and-spend`, `integrations-jira`, `settings-and-providers`,
`setup-and-projects` and `explore-or-delegate`. External clients should start
with `platform-model`, `mcp-conventions` and `permissions-and-confirmations`;
the topics written for the in-app agent say so.

The topics ([`server/mcp/guide.ts`](../server/mcp/guide.ts)) are also the
in-app mission agent's detailed manual: a mission always loads only a compact
operator core with the non-negotiable rules and this index, and reads a topic
before the work it covers. The tool is read tier, so every mission permission
level can call it. `rail-launch-cards` follows `SPECRAILS_MISSION_RAIL_CARDS`.

### Resources

Read-only state is also exposed as MCP **resources** so a client can fetch it
without a tool call:

- `specrails://guide` — the complete platform guide (the topic index plus every topic).
- `specrails://status` — the `specrails_status` snapshot (with its `etag`).
- `specrails://projects` — all registered projects.
- `specrails://projects/{projectId}` — a single project.
- `specrails://projects/{projectId}/board` — the `specrails_board` snapshot (listed per project).
- `specrails://jobs/{jobId}` — a job of any loaded project with its latest 20 events.
- `specrails://missions/{conversationId}` — a mission with its state and latest messages.

Clients can `resources/subscribe` to any of them. The app's own events that
change a resource (job and loop-run updates, rail and queue changes, spec
changes, inbox triggers, mission activity) send
`notifications/resources/updated`, debounced to at most one per resource per
second; high-volume stream frames (log lines, token streams) never notify on
their own. A client without subscriptions polls `specrails_status` with
`ifNoneMatch:<etag>`.

### Prompts

Three short prompts chain the tools; they only describe calls and grant no
permission: `diagnose-failure` (`jobId?`, `projectId?`), `launch-spec`
(`specId`, `projectId?`) and `triage-inbox`.

### Async results — `specrails_watch`

Cost-incurring and streaming actions (launch a rail, generate a spec, send a
chat turn, AI-edit, Contract Refine, SMASH) **return immediately** with a
reference (a `jobId` / `requestId`) and emit their **real** result over the
app's WebSocket bus. An agent gets the actual outcome by calling
`specrails_watch` with that reference; it waits for the operation to settle and
returns the final result. Don't assume success from the acceptance alone — this
is spelled out in `specrails_guide`.

For jobs and loop runs, watch checks stored state before waiting; a completed
run returns immediately even if its completion event preceded the call. Use
`kind: "loop_run"` with a loop-run id. Timeouts do not establish success or
failure; inspect `specrails_jobs(get)` or `specrails_loops(run_get)` for evidence.

### Catalog size

Every mission turn resends the whole `tools/list`, so it carries a compact
**wire** form of each tool ([`wire-briefs.ts`](../server/mcp/tools/wire-briefs.ts),
[`wire-schema.ts`](../server/mcp/tools/wire-schema.ts)): the tool's purpose,
its actions with a few words and their tier, and short field descriptions
(≤ 80 characters). The `action` field lists the required arguments per action
where the tool declares them. Only text changes: types, enums, bounds, required
fields and validation are those of the full schema (`$schema` and the ±2^53
integer bounds are left out of the advertised JSON; the server still checks
them). The complete descriptions stay reachable:
`specrails_describe(name, action)` returns that action's tier, required
arguments and the full docs of the fields it takes; `specrails_describe(name)`
the whole schema; recipes live in `specrails_guide`.

The output schema is structural only (the envelope keys, contents open), since
some clients send it to the model too (Gemini CLI as `responseJsonSchema`;
Claude does not).

| 33 tools | Before | Now |
|---|---|---|
| What the model reads (name + description + input schema) | ~86 KB | ~58 KB |
| Tool descriptions | ~23 KB | ~9 KB |
| Field descriptions | ~34 KB | ~23 KB |
| Output schema (all tools) | ~32 KB | ~12 KB |
| Whole `tools/list` JSON | ~124 KB | ~76 KB |
| Fresh mission "Hola" turn (Claude Haiku, input tokens) | ~43.0k | ~33.4k |

`wire-schema.test.ts` holds the budget (≤ 60 KB model payload, ≤ 6.5 KB per
tool, ≤ 80 KB `tools/list`) and checks that every shortened description is
returned verbatim by `specrails_describe`.

## Runtime runs and rail availability (mission-rail-cards)

`specrails_runs` exposes the programmatic runtime of a job (the same state the
app's Resume / Approve / Recover controls use), so an agent can explain a
failure and act only on the user's confirmation (the former
`specrails_jobs(runtime_*)` names are aliases):

| Action | Tier | What it does |
|---|---|---|
| `state` | read | Runtime state of `jobId` (or every run when omitted; `railIndex` for a rail's latest): status, current step, `canResume`, `recoverableSteps`, `pendingApproval` |
| `diagnose` | read | Recovery assessment: original scope, completed steps, repeated failures, the reviewer verdict |
| `evidence` | read | Durable runtime evidence of `jobId`, paged |
| `steer` | write | Queue `steeringText` with a stable `requestId` (acceptance is not consumption) |
| `resume` | ai-spawn | Continue a resumable run (`approve` / `recover` / `invalidate` / `answer`); `mode: "recover"` replays the recoverable steps (default: all of them) |
| `resume` + `mode: "approve"` | write | Approve a pending step (`stepId` or `approve`) |
| `settle` | write | Prepare delivery for a succeeded-but-unsettled run |
| `dismiss` | write | Dismiss a runtime continuation card |
| `cancel` | destructive | Cancel an active runtime continuation |

The runtime has no fork route, so `specrails_runs` offers no fork.

## Agent actions audit

`specrails_jobs(audit)` (read tier) returns what the agents of a run read,
wrote, executed, called over MCP or fetched: pass `jobId` for one run, or omit
it and pass `from`/`to` for a project-wide window. `format` is `jsonl`
(default) or `csv`; the result carries `rows` and the export text in `data`.
Reads are only as complete as each provider's stream. Every tool call made by
an in-app mission agent in a pinned project is itself recorded as an `mcp` row
(`tool:action`, never its arguments). See
[agent actions audit](internals/agent-actions-audit.md).

`specrails_rails(list)` rails carry `availability` — `free`, `busy` (active job
or loop run), `pending_decision` (an undecided PR delivery) or `on_review` (a
spec parked on review). Inside the app's own agent chat, a launch proposal is a
fenced `rail-launch` block the user plays from an editable card; the tool's
`launch` action is reserved for an explicit "launch now".

## The four permission tiers

Every tool declares one tier. The server refuses any tool whose tier is not
enabled, and the refusal **names the tier the user must turn on** so the agent
can relay it rather than retrying blindly. The tiers are **on by default and
opt-out** — read is always on, and the other three are granted on a fresh
install so a connected assistant can drive the whole app out of the box; untick
any of them in **Settings ▸ MCP** to restrict clients:

| Tier | Default | What it allows |
|---|---|---|
| **Read** | Always on | Queries + resources (list specs, read analytics, inspect jobs) |
| **Write** | On | Mutating but non-destructive, non-spawn: create/edit specs, change settings, configure a rail |
| **AI-spawn** | On | Actions that spawn an AI CLI and **cost money**: launch a rail, generate a spec, send a chat turn |
| **Destructive** | On | Delete data, kill processes, or mutate an external system (e.g. unregister a project, `smash_undo`, Jira writes) |

`specrails_specs_write(commit_draft)` requires AI-spawn when it can append a Contract
Layer. A fresh direct insert with `contractRefine: false` and no Explore/draft
ids remains Write. `specrails_describe` can preview the tier for specific
arguments; its shared-schema validation does not replace action-specific or
backend state checks.

The split is deliberate: a client you only half-trust can be dropped to
read-only with three unticks, and **destructive and cost-incurring actions can
be withheld independently**. A tool's tier is dynamic per action — e.g.
`specrails_specs(list)` is read while `specrails_specs_write(delete)` is destructive —
so the same tool exposes different actions at different trust levels.

**Explicit confirmation.** An external client must resend every destructive
call with `confirm: true` after the person agreed. Without it the server
answers `confirmation_required` with the exact arguments to resend; with
`dryRun: true` nothing executes and the answer describes what would happen.
The in-app agent is governed by its live permission ladder instead. The
Destructive tier stays on by default.

## Setting it up

It is already running — the app persists `mcp_enabled` as on and serves
`/api/mcp` from the first launch, and the scoped token is minted at boot so the
bridge finds it immediately.

1. Open the app and go to **Settings ▸ MCP**.
2. Review the permission tiers (**Write** / **AI-spawn** / **Destructive**).
   Untick the ones you don't want an external client to have; untick all three
   to keep the agent read-only.
3. Click **Copy client config** to grab a ready-to-paste configuration, or
   **Copy token** if your client needs the raw token (for the direct-HTTP path
   below).

Toggling the enable switch off tears down all open MCP sessions immediately;
toggling it back on boots the transport again — no app restart either way.

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

Use **Copy client config** as a starting point. Some versions return only
`specrails-mcp`, which may not be on PATH. Follow the linked agent runbook for path discovery and client-specific
registration; no token belongs in the stdio configuration.

### For agents only — Claude and Codex

Follow the [agent connection runbook](agents/mcp.md)
for executable discovery, client-specific registration, real read-only verification
and troubleshooting. It distinguishes saved configuration, bridge connectivity
and tools available in the current conversation.

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
  what the enabled tiers allow. All four are on by default so a fresh install
  works out of the box; high-risk actions can be withheld per tier at any time.
- **Loopback is not identity.** The scoped MCP token identifies an external local
  client; it cannot impersonate the embedded Agent Mode by adding tier, project,
  or conversation headers. For each Agent Mode turn, Specrails mints a private,
  short-lived capability bound server-side to that conversation, pinned project,
  and permission level, transports it through an app-owned `0600` file, and
  revokes it when the turn ends.
- **Mission agents are read-only.** In the app's own agent chat, the AI CLI
  starts with its native read-only boundary. Claude gets no file-writing or
  shell tools, Codex runs in its read-only sandbox, Gemini runs in plan mode, and
  local engines use the runner's read-only tools. Changes reach your projects
  only through these MCP tools and the rails they launch. Kimi has no native
  read-only mode, so Kimi missions keep their previous permissions. MCP servers
  you add yourself keep their own behaviour.
- **The app must be running.** The MCP server is embedded in the desktop app's
  process — there is no standalone daemon. The Tauri shell keeps it alive even
  when you close the main window: closing the window **minimizes to the system
  tray / menu bar** and leaves the embedded server running, so your MCP client
  stays connected. The server stops only when you choose **Exit** from the tray
  menu (or the OS truly quits the app). If the app isn't running, the bridge
  tells you to start it.

## v1 limitations — what is *not* exposed

The public tool catalog deliberately leaves the highest-risk execution vectors
out of v1. None of these are reachable by an external MCP client authenticated
only with the scoped MCP token:

- **Raw terminal shell execution.** The built-in terminal panel is not exposed
  to external MCP clients. `specrails_background(start)` and `(kill)` are a
  private Agent Mode path: they require a live server-minted capability,
  Autonomous permission, and explicit confirmation for the exact command.
  Supplying legacy context headers or enabling the external Destructive tier
  does not grant access to that path.
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

## External MCP servers for the mission agent

**Security note:** mission turns run without per-tool approval prompts, and
external tools are outside the Specrails permission tiers (those govern only
`specrails_*` tools). Enable only servers you trust. Kill switch:
`SPECRAILS_EXTERNAL_MCP=false`.

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
**Regenerate token** and update your client. The stdio bridge reads the current token locally; check the OS user and
token-file access if it also reports an authentication failure.

**The agent assumed a rail succeeded but it didn't** — cost-incurring actions
return a reference, not a result. The agent must call `specrails_watch` with the
returned `jobId`/`requestId` to get the real outcome. This is documented in
`specrails_guide`; point the agent at it.

**Connection refused on `:4200`** — that's the default app port. If you changed
the port in Settings, use the URL from **Copy client config**, which reflects
the real port. Set `SPECRAILS_MCP_PORT` in the bridge environment for a custom port;
it defaults to `4200` and does not discover arbitrary ports automatically.

## See also

- [Running pipelines](running-pipelines.md) — what rails, jobs, and the
  pipeline an MCP client drives actually do.
- [Creating specs](creating-specs.md) — specs, drafts, SMASH, and Contract
  Refine, all reachable via `specrails_specs`.
- [Tracking cost](tracking-cost.md) — the analytics an agent reads via
  `specrails_analytics`.
- [Customising the app](customizing.md) — other settings, including the budget
  the AI-spawn tier respects.
