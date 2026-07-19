# API reference

REST and WebSocket endpoints exposed by the app server. The server binds to `127.0.0.1` only (loopback); the default port is `4200` but it can be overridden with `--port <n>` on the server command line.

> **New here?** This page is the contract the desktop UI, the CLI, and the mobile gateway all speak to the local server. **You normally never call these endpoints directly — the app does it for you.** Read on only if you are scripting against the server, writing an integration, or debugging. Everything is local-only: there is no cloud API.

The app registers four AI provider CLIs — **Claude, Codex, Gemini, and Kimi**
— all enabled by default. Endpoints that accept `provider` / `aiEngine` take
`claude`, `codex`, `gemini`, or `kimi`, validate project membership, then
enforce the requested surface's adapter capabilities. See the
[Kimi guide](../kimi.md) for its exact matrix.

## Authentication

An app token is **auto-generated on first run** (two concatenated UUIDs) and persisted to `~/.specrails/desktop.token` with mode `0600`. It is **mandatory**, not optional. Every `/api/*` route is protected by it, with two exceptions that are mounted before the auth middleware: `/api/health` and `/api/token`.

Send the token either as a Bearer header or an `X-Desktop-Token` header:

```http
Authorization: Bearer <token>
X-Desktop-Token: <token>
```

The CLI and the desktop client read the token automatically. The browser client fetches it same-origin from `GET /api/token`. WebSocket upgrades carry it as the `token` query parameter.

There is no UI to set or clear the token, and it is not an app setting.

This page is hand-maintained against the route declarations in `server/*-router.ts`, the per-domain `server/project-router-{jobs,spending,settings,terminals,tickets,chat,setup}.ts` family, `server/code-explorer-router.ts`, and `server/jira-router.ts`. If you spot a discrepancy, please file an issue.

---

## Top-level mounts

| Prefix | Router | Auth | Notes |
|--------|--------|------|-------|
| `/api/health` | direct | none | Liveness probe (`{ status, version, uptime, projects, mode }`) |
| `/api/token` | direct | none | Returns the auth token for local bootstrapping (loopback-only) |
| `/api/docs` | `docs-router` | loopback-only (mounted before token auth) | Bundled documentation portal |
| `/api/mobile/*` | `mobile-admin-router` | Bearer / X-Desktop-Token + loopback | Mobile Gateway admin (enable/pair/devices) |
| `/api/*` | `desktop-router` | Bearer / X-Desktop-Token | Cross-project operations |
| `/api/projects/:projectId/*` | `project-router` | Bearer / X-Desktop-Token | Project-scoped operations |
| `/api/projects/:projectId/code/*` | `code-explorer-router` | Bearer / X-Desktop-Token | Code explorer (read + in-app file editing; 404 when the gate is off) |
| `/api/projects/:projectId/rails/*` | `rails-router` | Bearer / X-Desktop-Token | Rails (execution lanes) |
| `/api/projects/:projectId/profiles/*` | `profiles-router` | Bearer / X-Desktop-Token | Agent profiles + catalog studio |
| `/api/projects/:projectId/plugins/*` | `plugins-router` | Bearer / X-Desktop-Token | Plugin marketplace |
| `/api/projects/:projectId/jira/*` | `jira-router` | Bearer / X-Desktop-Token | Jira integration (404 when `SPECRAILS_JIRA_SECTION=false`) |
| `/otlp/v1/{traces,metrics,logs}` | `telemetry-receiver` | none (gated by job id) | OTLP/JSON receiver |
| `/ws` | WebSocket | token in query | Project + app event stream |
| `/ws/terminal/:id` | WebSocket | token in query | PTY traffic for the terminal panel |

**Mount order matters**: the `desktop-router` is mounted at `/api` **before** the project router, so exact routes such as `GET /api/projects` and `DELETE /api/projects/:id` are answered by the desktop router, while everything under `/api/projects/:projectId/*` falls through to the project router.

A non-localhost `Origin` header is rejected by the CORS middleware with `403 Forbidden: cross-origin requests not allowed`.

> **Breaking change (Specrails Desktop rebrand)**: the former `/api/hub/*` prefix is now `/api/*` (e.g. `/api/hub/state` → `/api/state`, `/api/hub/token` → `/api/token`, `/api/hub/projects` → `/api/projects`), the auth header `X-Hub-Token` is now `X-Desktop-Token`, the WebSocket auth subprotocol `hub-token.<token>` is now `desktop-token.<token>`, and the webhook/WS event `hub_daily_budget_exceeded` is now `desktop_daily_budget_exceeded`. There is no server-side alias for the old paths or header.

---

## `/api/*`

### Projects

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/projects` | List registered projects |
| `POST` | `/projects` | Register a project. Body `{ path, name?, provider?, providers? }`. Each provider value is one of `claude`, `codex`, `gemini`, `kimi` (registry-validated). `providers: string[]` enables a multi-provider project (first entry = primary/default); legacy single `provider` still honoured; omit both to default to `["claude"]`. 409 if the path is already registered or Kimi fails its executable/version/Core-target checks. 400 if a provider is unknown, or if a disabled provider is selected: `codex` when `SPECRAILS_CODEX_BETA=0`, `gemini` when `SPECRAILS_GEMINI_BETA=0` (both default-enabled). Kimi has no beta flag: it requires a usable `kimi` CLI ≥ 0.27.0 and a Core build that advertises the Kimi target. Kimi 0.27 has no safe non-billing authentication probe, so login/model configuration is confirmed by the first real turn |
| `DELETE` | `/projects/:id` | Unregister (does not delete the project directory) |
| `GET` | `/resolve?path=…` | Find a project by **exact** canonical filesystem path. No parent-directory walking — a subdirectory returns 404 |

Example — register a project that uses both Claude and Gemini:

```json
// POST /api/projects
{
  "path": "/Users/me/code/my-app",
  "name": "My App",
  "providers": ["claude", "gemini"]
}
// → 201 { "project": { "id": "my-app", "name": "My App", "provider": "claude", "providers": ["claude", "gemini"], ... } }
```

### App state

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/state` | `{ projects, projectCount, …todayStats }` (today's cross-project cost/run aggregates spread into the response) |
| `GET` | `/cli-status` | Detected AI CLI provider + version (`{ provider, version }`), e.g. `claude`, `codex`, `gemini`, or `kimi` — runs the registered adapter's version probe. Registry-driven |
| `GET` | `/available-providers` | Provider catalogue used by the setup wizard. Registry-driven map (`{ claude, codex, gemini, kimi, tiers, providerIssues, launchDescriptors }`) reporting which CLIs are usable. Codex/Gemini are surfaced unless forced off by `SPECRAILS_CODEX_BETA=0` / `SPECRAILS_GEMINI_BETA=0` (both enabled by default). Kimi is reported unavailable, with a machine-readable `providerIssues.kimi`, when the CLI is missing/unusable, is older than 0.27.0, or the installed Core lacks the Kimi target. The bounded readiness probe is intentionally non-billing and cannot prove account authentication; a login/configuration problem is surfaced by the first model turn. `launchDescriptors` exposes each external CLI command; the app does not bundle a Kimi daemon/server |
| `GET` | `/core-compat` | specrails-core version compatibility probe |
| `GET` | `/setup-prerequisites` | Tool checks (`node`/`npm`/`npx`/`git`, optionally `uv`). Add `?diagnostic=1` to nest a `diagnostic` object: `{ pathSegments, pathSources, loginShellStatus, whichResults, nodeEnv, platform }` |

### Settings, budget, theme

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/settings` | App-wide settings |
| `PUT` | `/settings` | Update any subset of `{ port?, specrailsTechUrl?, costAlertThresholdUsd? }` |
| `GET` | `/budget` | App-wide budget config |
| `PATCH` | `/budget` | Update the app-wide daily budget |
| `GET` | `/theme` | Current UI theme (defaults to `specrails`) |
| `PATCH` | `/theme` | Set UI theme. Body `{ theme }`; one of `dracula`, `aurora-light`, `obsidian-dark`, `matrix`, `specrails`. 400 on an unknown value |
| `GET` | `/language` | Current UI language; `{ language: null }` when the user never chose one (the client then follows the OS language) |
| `PATCH` | `/language` | Set UI language. Body `{ language }`; one of `en`, `es`, `fr`, `de`, `pt`, `it`, `zh`, `ja`. 400 on an unknown value |
| `GET` | `/code-explorer-settings` | `{ language, monthlyBudgetUsd }` (summary language `en`/`es`, default budget $5) |
| `PATCH` | `/code-explorer-settings` | Update `{ language?, monthlyBudgetUsd? }` |
| `GET` | `/terminal-settings` | App-wide terminal panel defaults |
| `PATCH` | `/terminal-settings` | Update app-wide terminal defaults |

### Analytics (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/analytics?period=&from=&to=` | Cross-project aggregated spending (the Desktop Analytics page; supports a custom `from`/`to` range) |
| `GET` | `/recent-jobs?limit=` | Recent jobs across all projects (1–50) |

### Mobile Gateway admin (`/api/mobile/*`)

Loopback-only admin surface for the Mobile Gateway (the gateway itself is a separate HTTPS listener that tunnels the web companion's RPC over WebRTC). The wire contract the phone consumes intentionally keeps the legacy `hub.*` names — see the frozen mobile wire-compat note in `CLAUDE.md`.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/status` | Gateway status (`{ enabled, running, port, certFingerprint, desktopName }`) |
| `POST` | `/enable` | Start the gateway (generates the TLS identity on first run) |
| `POST` | `/disable` | Stop the gateway |
| `POST` | `/webrtc/offer` | Create a serverless pairing offer (offer SDP + single-use secret + desktop identity) for the first QR |
| `POST` | `/webrtc/answer` | Apply the companion's scanned answer SDP to the open offer |
| `GET` | `/devices` | List paired devices |
| `DELETE` | `/devices/:id` | Revoke a paired device |
| `POST` | `/cert/rotate` | Rotate the gateway TLS identity (unpairs every device) |

### specrails-tech proxy

Proxies the external specrails-tech agents service (base URL from `desktop_settings.specrails_tech_url`).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/specrails-tech/status` | Health + connected flag |
| `GET` | `/specrails-tech/agents` | List remote agents |
| `GET` | `/specrails-tech/agents/:slug` | Agent detail |
| `GET` | `/specrails-tech/docs` | List remote docs |
| `GET` | `/specrails-tech/docs/:page` | Doc page detail |

### Agents catalogue (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/agents` | List all configured agents |
| `GET` | `/agents/:id` | Get one agent |
| `POST` | `/agents` | Create an agent entry |
| `PATCH` | `/agents/:id` | Update |

### Webhooks

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/webhooks` | List webhooks |
| `POST` | `/webhooks` | Create |
| `PATCH` | `/webhooks/:id` | Update |
| `DELETE` | `/webhooks/:id` | Delete |
| `POST` | `/webhooks/:id/test` | Fire a test payload |

Subscribable events: `job.completed`, `job.failed`, `job.canceled`, `daily_budget_exceeded`, `desktop_daily_budget_exceeded`. **Breaking**: the event formerly named `hub_daily_budget_exceeded` is now `desktop_daily_budget_exceeded` — stored webhook subscriptions are rewritten automatically by a one-time migration, but external consumers matching on the event name must update.

---

## `/api/projects/:projectId/*`

All routes below are prefixed with `/api/projects/:projectId/`. In the client, use `getApiBase()` as the prefix — it injects the active project ID for you and throws if no project is active.

### Spawn / commands / config

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/spawn` | Queue a command job. Body `{ command, priority?, dependsOnJobId?, pipelineId?, profileName?, aiEngine? }`. `aiEngine` is a per-job provider override validated against installed providers (omit to use the primary). `profileName: null` forces legacy (no profile). Returns `202 { jobId, position }` |
| `GET` | `/config` | List discovered `/specrails:*` and `/opsx:*` commands |
| `POST` | `/config` | Force re-discovery |
| `GET` | `/default-spec-model?provider=` | Resolve the Quick-spec model for an engine. Returns `{ model, provider, allowed, providers }`; `provider` falls back to the primary if omitted/invalid |

Example — queue a command on a specific provider:

```json
// POST /api/projects/my-app/spawn
{ "command": "/specrails:implement #42 --yes", "aiEngine": "gemini" }
// → 202 { "jobId": "j_01H...", "position": 0 }
```

### Pipelines and jobs

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/pipelines/:pipelineId` | One pipeline (group of jobs) |
| `GET` | `/state` | Active job, queue depth, paused flag |
| `GET` | `/activity` | Chronological event log (`job_started`/`job_completed`/`job_failed`/`job_canceled` items) |
| `GET` | `/issues` | GitHub issues linked to the project |
| `GET` | `/jobs` | Job list (`?limit=&offset=&status=`) |
| `GET` | `/jobs/export` | CSV/JSON export |
| `GET` | `/jobs/compare` | Compare metrics between two jobs |
| `GET` | `/jobs/:id` | One job. Returns `{ job, events, phaseDefinitions }`; `job` is annotated with `hasTelemetry`, `tickets[]` (resolved from the command, powers the ticket header), `interactiveSettleMode` (`'finalize'` \| `'auto'` \| `null`) and `interactiveAcceptingTurns` (whether a resident session accepts turns right now — a between-steps loop run reports `'auto'`/`false` so the composer can phrase the waiting state) |
| `DELETE` | `/jobs/:id` | Cancel a running or queued job |
| `DELETE` | `/jobs` | Purge completed jobs (optional `{ from, to }` window) |
| `PATCH` | `/jobs/:id/priority` | Re-rank a queued job |
| `POST` | `/jobs/:id/messages` | Send one more user turn to a running **interactive** job (queued behind the active turn). Body `{ text }`. Manager-agnostic: QueueManager is tried first, then the loop engine's active ai-step session. `202` accepted, `400` missing text, `403` interactive jobs disabled, `409` no active interactive session (unknown / non-interactive / finalized / a loop run between steps) |
| `POST` | `/jobs/:id/finalize` | Finalize a running interactive job (SIGTERM the resident child; final totals + terminal status are stamped when it closes). For a loop run this settles the **current step** and the loop advances. `202` scheduled, `403` interactive jobs disabled, `409` not an active interactive session |
| `GET` | `/jobs/:jobId/diagnostic` | Stream a diagnostic ZIP (telemetry + profile + plugins snapshots) |

The two interactive endpoints back Claude's persistent-stdin in-job chat.
Providers without persistent stdin (Codex, Gemini, and Kimi) run one-shot and
return 409 here; Kimi chat surfaces resume via a new `kimi --session=<id> -p` child after
a successful resume hint. Both endpoints return 403 when
`SPECRAILS_INTERACTIVE_JOBS=false`.

Example — fetch one job:

```json
// GET /api/projects/my-app/jobs/j_01H...
{
  "job": {
    "id": "j_01H...",
    "command": "/specrails:implement #42 --yes",
    "status": "completed",
    "total_cost_usd": 0.83,
    "num_turns": 14,
    "model": "sonnet",
    "hasTelemetry": true,
    "tickets": [{ "id": 42, "title": "Add CSV export" }]
  },
  "events": [ /* streamed job events */ ],
  "phaseDefinitions": [ /* architect → developer → reviewer → ship */ ]
}
```

### Queue

Jobs within a project run **strictly one at a time** (serialized) — a single queue per project. Parallelism is across projects only.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/queue` | Current queue state |
| `POST` | `/queue/pause` | Pause |
| `POST` | `/queue/resume` | Resume |
| `PUT` | `/queue/reorder` | Reorder. Body `{ jobIds: string[] }` |

### Analytics + spending

Spending is tracked across six surfaces: `job`, `quick-spec`, `explore-spec`, `ai-edit`, `smash`, `file-summary`.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/stats` | Summary (total jobs, tokens, cost) |
| `GET` | `/metrics` | Raw metrics |
| `GET` | `/spending` | Burn-rate / timeline / by-surface / by-model / top-tickets — powers the Analytics page |
| `GET` | `/invocations` | Paginated raw `ai_invocations` rows |
| `GET` | `/tickets/:id/spending-summary` | Per-ticket cross-surface aggregate (powers `TicketSpendingLine`) |
| `GET` | `/analytics/export?format=csv\|json&mode=summary\|raw&…` | Multi-section summary CSV/JSON, or raw rows (10 000 cap) |

Example — the Analytics dashboard payload (abridged):

```json
// GET /api/projects/my-app/spending?period=30d
{
  "summary": { "totalCostUsd": 12.40, "totalRuns": 58, "prevPeriodDeltaPct": -8.2, "trackingStartedAt": "2026-05-01" },
  "bySurface": [{ "surface": "job", "costUsd": 9.10 }, { "surface": "explore-spec", "costUsd": 2.30 }],
  "byModel": [{ "model": "sonnet", "costUsd": 8.00 }, { "model": "gemini-3.5-flash", "costUsd": 1.20 }],
  "dailyTimeline": [ /* zero-filled, stacked by surface */ ],
  "topTickets": [ /* top 10 cross-surface */ ]
}
```

Cost is provider-billed for Claude and estimated for Codex/Gemini. Kimi
provides no authoritative token/USD envelope, so those values remain null.

### Budget

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/budget` | Daily cap + per-job alert |
| `PATCH` | `/budget` | Update |

### Tickets

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/tickets` | Filters: `?status=`, `?label=`, `?q=` |
| `GET` | `/tickets/:id` | One ticket |
| `POST` | `/tickets` | Create |
| `PATCH` | `/tickets/:id` | Update any subset of fields |
| `DELETE` | `/tickets/:id` | Delete (cascades the draft conversation if it is the last reference) |
| `POST` | `/tickets/generate-spec` | Quick-mode generation. Body `{ idea, model?, contractRefine?, aiEngine?, attachmentIds?, pendingSpecId?, contextScope? }` (the spec text is `idea`, not `title`). Streams progress over WS |
| `POST` | `/tickets/save-as-draft` | Persist an Explore conversation as a draft (idempotent on `conversationId`) |
| `POST` | `/tickets/from-draft` | Commit a draft (flip-in-place) or insert a new ticket |
| `POST` | `/tickets/from-prompt` | Create a ticket directly from a prompt |
| `POST` | `/tickets/:id/contract-refine` | Retry Contract Refine for an existing ticket. `202` scheduled, `404` unknown ticket, `409` when the effective provider cannot enforce the required tool policy (`contract_refine_unsupported_for_<provider>`; this includes Kimi), the kill switch is active (`feature_disabled_by_env`), or the ticket has no origin conversation. Kimi is rejected before spawn or mutation |
| `POST` | `/tickets/:id/smash` | SMASH an epic into sub-specs |
| `POST` | `/tickets/:id/smash/undo` | Undo a SMASH operation |
| `DELETE` | `/tickets/:id/children` | Delete all children of an epic |
| `POST` | `/tickets/:id/ai-edit` | Open an AI edit (Refine) session against the ticket |
| `DELETE` | `/tickets/:id/ai-edit` | Cancel an AI edit session |
| `POST` | `/tickets/:ticketId/attachments` | Upload an attachment (multipart) |
| `GET` | `/tickets/:ticketId/attachments` | List attachments |
| `GET` | `/tickets/:ticketId/attachments/:attachmentId` | Download one |
| `DELETE` | `/tickets/:ticketId/attachments/:attachmentId` | Delete one |
| `DELETE` | `/tickets/:ticketId/attachments` | Delete all |

### Chat / Explore

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/chat/conversations` | List (filter by `?kind=sidebar\|explore`) |
| `POST` | `/chat/conversations` | Create. Body `{ kind?, model?, aiEngine? (alias provider), contextScope? }`. `contextScope` is only allowed for `kind=explore` |
| `GET` | `/chat/conversations/:id` | One conversation (with messages) |
| `PATCH` | `/chat/conversations/:id` | Update metadata (title, contextScope, etc.) |
| `DELETE` | `/chat/conversations/:id` | Delete (clears `origin_conversation_id` on linked draft tickets) |
| `GET` | `/chat/conversations/:id/messages` | List messages |
| `POST` | `/chat/conversations/:id/messages` | Send a turn; streams over WS |
| `DELETE` | `/chat/conversations/:id/messages/stream` | Cancel an in-progress turn |
| `GET` | `/chat/conversations/:id/spec-draft` | Live spec-draft state |
| `POST` | `/chat/conversations/:id/minimize` | Park the session (arms the idle-kill timer) |
| `POST` | `/chat/conversations/:id/restore` | Cancel the idle-kill timer |

### Setup wizard

The setup wizard is a three-step flow (Configure / Install / Done). The `enrich/*` and `setup/start`+`setup/message` endpoints back the legacy AI-enriched flow that the app UI does not expose; they remain mounted for forward compatibility.

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/setup/install-config` | Write `.specrails/install-config.yaml` to the project |
| `POST` | `/setup/install` | Run `npx specrails-core init --from-config <file>` (the pinned core release — currently `specrails-core@^4.12.0` — is resolved by SetupManager, overridable via `SPECRAILS_CORE_BIN`) |
| `POST` | `/setup/start` | Legacy setup-chat session start |
| `POST` | `/setup/message` | Legacy setup-chat turn |
| `POST` | `/enrich/start` | Legacy AI-enrich session start |
| `POST` | `/enrich/message` | Legacy AI-enrich turn |
| `GET` | `/setup/checkpoints` | Checkpoint state + last log lines |
| `POST` | `/setup/abort` | Abort the wizard |

### Proposals

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/propose` | List spec proposals |
| `POST` | `/propose` | Create |
| `GET` | `/propose/:id` | One proposal |
| `POST` | `/propose/:id/refine` | Refine with feedback |
| `POST` | `/propose/:id/create-issue` | Convert a proposal to a GitHub issue |
| `DELETE` | `/propose/:id` | Delete |

### OpenSpec changes

OpenSpec changes are read from `openspec/changes/<name>/` (active) and `openspec/changes/archive/<YYYY-MM-DD-name>/` (archived).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/changes` | List changes under `openspec/changes/` |
| `GET` | `/changes/:changeId/artifacts/:artifact` | Read one artifact. Allowed names: `proposal.md`, `design.md`, `tasks.md`, `delta-spec.md`, `context-bundle.md` |

### Spec launcher

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/spec-launcher/start` | Launch a spec-generation run |
| `DELETE` | `/spec-launcher/:launchId` | Cancel a launch |

### Templates

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/templates` | List templates |
| `POST` | `/templates` | Create |
| `GET` | `/templates/:templateId` | One template |
| `PATCH` | `/templates/:templateId` | Update |
| `DELETE` | `/templates/:templateId` | Delete |
| `POST` | `/templates/:templateId/run` | Run the template against the project |

### Integration contract

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/integration-contract` | Read the project's `integration-contract.json` |

### Browser capture

Gated by `requireBrowserCaptureEnabled` — returns 404 when the feature is disabled.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/browser/sessions` | List capture sessions |
| `POST` | `/browser/sessions` | Start a capture session |
| `POST` | `/browser/sessions/:id/navigate` | Navigate the embedded browser |
| `POST` | `/browser/sessions/:id/capture` | Capture the current page/selection |
| `POST` | `/browser/sessions/:id/capture-breakpoints` | Capture across responsive breakpoints |
| `POST` | `/browser/sessions/:id/element` | Capture a picked element |
| `POST` | `/browser/sessions/:id/clipboard` | Read/write the session clipboard |
| `DELETE` | `/browser/sessions/:id` | Close a session |

### Terminals

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/terminals` | List PTY sessions |
| `POST` | `/terminals` | Create a session |
| `PATCH` | `/terminals/:id` | Rename |
| `DELETE` | `/terminals/:id` | Kill |
| `GET` | `/terminals/:id/marks` | Persisted command marks (OSC 133) |

### Project settings

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/settings` | Project settings |
| `PATCH` | `/settings` | Update |
| `GET` | `/terminal-settings` | Per-project terminal overrides |
| `PATCH` | `/terminal-settings` | Update |
| `GET` | `/agent-models` | Per-agent model overrides |
| `PATCH` | `/agent-models` | Update |
| `GET` | `/context-budget` | Context-window budget per surface |
| `GET` | `/context-scope-last` | Last-used context scope per surface (sticky preset) |
| `PATCH` | `/context-scope-last` | Update the sticky preset |
| `GET` | `/add-spec-quick-contract-refine-last` | Last-used Quick-mode Contract Refine toggle |
| `PATCH` | `/add-spec-quick-contract-refine-last` | Update the toggle |

---

## `/api/projects/:projectId/code/*`

A non-developer-friendly file tree + Monaco viewer with plain-language AI summaries and *touched-by-AI* provenance chips, plus opt-in in-app editing of existing files (overwrite-only). Mounted via `code-explorer-router`; 404 when the server gate is off.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/tree?withProvenance=1&filter=touched-by-ai\|all&cursor=…` | Virtualised file tree (pagination cap 2000, `.gitignore`-aware) |
| `GET` | `/file?path=…` | File contents (binary refusal, 2 MB cap, path-traversal guard) |
| `PUT` | `/file` | In-app edit: overwrite an **existing** text file. Body `{ path, content }`. Overwrite-only (no create, no rename); same traversal / deny-list / `.gitignore` guards as the read path. `404` if the path does not exist, `413` over the 2 MB cap, `415` for binary content/files |
| `GET` | `/summary?path=…` | Plain-language AI summary for a file |
| `POST` | `/file/regenerate-summary?path=…` | Enqueue a summary regeneration. Body `{ overrideBudget? }` → `202 { enqueued: true }` |
| `GET` | `/provenance?ticketId=…` | Files touched by a ticket |
| `GET` | `/diff` | File-change diff data |

---

## `/api/projects/:projectId/rails/*`

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | List rails |
| `PUT` | `/:railIndex/tickets` | Assign tickets to a rail. Body `{ ticketIds: number[] }` |
| `PUT` | `/:railIndex/profile` | Set the rail's default profile |
| `PUT` | `/:railIndex/engine` | Set the rail's AI engine override. Body `{ aiEngine }` (string — one of the project's providers — or `null` to clear) |
| `PUT` | `/:railIndex/name` | Set the rail's display name. Body `{ name }` (string or `null` to clear back to the default label); 400 if longer than 60 characters |
| `POST` | `/:railIndex/launch` | Launch the rail. Body `{ mode?, loopId?, profileName?, aiEngine?, model?, reasoning_effort?, originConversationId?, originSurface?, interactive? }`. `mode` is `implement` / `batch-implement` / `freestyle` / `loop`; a factory `loopId` maps to its canonical rail mode. `model` and `reasoning_effort` are validated against the effective adapter/model (Kimi effort is K3-only). Kimi + a loop containing a Decider returns a capability error before the first step. Claude alone advertises persistent in-job stdin; `interactive` remains wire-compatible. Returns `202 { jobId, railIndex, mode }`; a missing provider CLI fails before a job starts. |
| `POST` | `/:railIndex/stop` | Stop the rail's running job (cancels every job the rail registered) |

---

## `/api/projects/:projectId/profiles/*`

Gated by `SPECRAILS_AGENTS_SECTION !== 'false'`. Profiles are provider-scoped;
Claude and Kimi advertise profile execution, while Codex and Gemini force
legacy mode. CRUD requests may carry the effective provider so same-named
Claude/Kimi profiles do not collide.

> **Provider capability notes.** Claude and Kimi support provider-scoped
> profiles and Freestyle; integration state/health is also provider-scoped.
> Kimi agentic surfaces are available, but pure-output/read-only actions
> (Quick Spec, AI Edit, Contract Refine, SMASH/Re-SMASH, Project Builder
> generation, Loop Decider, Code Explorer AI, and Agent Studio automation)
> reject Kimi before spawn. Kimi tokens/USD cost remain null. See the
> [Kimi guide](../kimi.md).

### Profile CRUD

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | List profiles |
| `POST` | `/` | Create (validator enforces the baseline trio + routing ordering) |
| `GET` | `/:name` | One profile |
| `PATCH` | `/:name` | Update |
| `DELETE` | `/:name` | Delete |
| `POST` | `/:name/duplicate` | Duplicate. Body `{ name }` (the new profile name) |
| `POST` | `/:name/rename` | Rename. Body `{ name }` (the new profile name) |
| `GET` | `/resolve?profile=…` | Preview which profile would run given a selection |

### Bootstrap and analytics

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/migrate-from-settings` | Seed `default.json` from existing agent frontmatter |
| `GET` | `/analytics?windowDays=30` | Per-profile usage analytics |
| `GET` | `/core-version` | specrails-core version probe (drives the upgrade banner) |

### Agents catalogue + studio

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/catalog` | Read upstream `sr-*` + custom `custom-*` agents |
| `GET` | `/catalog/:agentId` | One agent |
| `POST` | `/catalog` | Create a custom agent (template/blank/duplicate) |
| `PATCH` | `/catalog/:agentId` | Update a custom agent |
| `DELETE` | `/catalog/:agentId` | Delete a custom agent |
| `POST` | `/catalog/test` | Test-run a draft against a sample task (no FS writes) |
| `POST` | `/catalog/generate` | Generate an agent `.md` via Claude from a natural-language description |
| `GET` | `/catalog/:agentId/versions` | Version history |

### Agent refine sessions

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/catalog/:agentId/refine` | Open a refine session |
| `GET` | `/catalog/:agentId/refine` | List sessions |
| `GET` | `/catalog/:agentId/refine/:refineId` | One session |
| `PATCH` | `/catalog/:agentId/refine/:refineId` | Update |
| `DELETE` | `/catalog/:agentId/refine/:refineId` | Cancel |
| `POST` | `/catalog/:agentId/refine/:refineId/turn` | Send a turn |
| `POST` | `/catalog/:agentId/refine/:refineId/apply` | Apply the diff to the agent file |

---

## `/api/projects/:projectId/plugins/*`

Gated by `SPECRAILS_PLUGINS_SECTION !== 'false'`.

Every route accepts an optional provider target. Read and delete routes use
`?provider=<id>`; mutation routes accept `{ "provider": "<id>" }`. The value
must belong to the project's configured `providers`; omission preserves the
legacy behaviour and targets the primary `project.provider`.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | List bundled plugins with installed/orphan/degraded state |
| `GET` | `/:name/preview-install` | Provider-native MCP/instructions diff |
| `POST` | `/:name/install` | Install (streams progress over WS) |
| `DELETE` | `/:name` | Uninstall or remove an orphan |
| `POST` | `/:name/activate` | Activate (post-install) |
| `POST` | `/:name/deactivate` | Deactivate |
| `POST` | `/:name/update` | Update to the latest bundled version |
| `GET` | `/:name/health` | On-demand verify (2 s timeout) |
| `POST` | `/_prerequisites/:prereq/install` | Install a plugin prerequisite (e.g. `uv` for Serena) |
| `POST` | `/_marketplace/disable` | Hide the integrations marketplace for this project |

---

## `/api/projects/:projectId/jira/*`

Optional per-project Jira integration: a project's specs can be backed by a Jira board instead of the local store. Mounted via `jira-router` and gated by `SPECRAILS_JIRA_SECTION` — **every route 404s when the flag is `false`**. Inert until a connection is configured. The Jira token is never returned to the client (connection responses carry `hasToken` only). The first six endpoints back the step-by-step connect wizard (test → pick project → optional status map → connect).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/connection` | Current connection (token redacted) or `{ connected: false }` |
| `PATCH` | `/connection` | Toggle `enabled` (hot-swap local ↔ Jira) and/or update the discard status / status map. `404` if no connection |
| `DELETE` | `/connection` | Disconnect and restore the local backlog config |
| `POST` | `/test` | Wizard step 1: validate credentials without saving. Body `{ baseUrl, accountEmail?, token }`. `401` on bad credentials |
| `POST` | `/discover-projects` | Wizard step 2: list visible Jira projects. Body `{ baseUrl, accountEmail?, token, query? }` |
| `POST` | `/discover-statuses` | Wizard step 3 (optional): list a project's statuses. Body `{ baseUrl, accountEmail?, token, projectKey }` |
| `POST` | `/connect` | Wizard final step: validate + persist + start sync. Body `{ baseUrl, accountEmail?, token, jiraProjectKey, statusMap?, discardStatus? }`. `201` on success |
| `GET` | `/statuses` | The connected project's real statuses (post-connect picker), using stored credentials |
| `POST` | `/resume` | Re-paste a fresh token after a `401` and drain the parked outbox |
| `POST` | `/sync` | Manual "Sync now" — a full re-fetch ignoring the high-water mark |
| `GET` | `/outbox?state=` | List durable write-back ops (optional `state=pending\|inflight\|done\|dead`) + counts |
| `POST` | `/outbox/:id/retry` | Re-queue a dead-lettered op. `404` if the op is missing or not dead |
| `POST` | `/specs` | Add Spec when the project source is Jira: create the issue in Jira and materialize it locally. Body `{ title, description?, labels?, priority?, issueType? }` → `201 { localId, jiraKey }` |
| `POST` | `/specs/:localId/discard` | Move the linked issue to the configured discard status (instead of deleting). Body `{ comment? }`. `404` if unlinked, `409` otherwise |
| `GET` | `/specs/:localId/details` | Read-only Jira details + development payload for the spec detail modal |
| `GET` | `/links` | The spec ↔ Jira issue map (drives the badge and diagnostics) |

## `/api/docs/*`

The bundled documentation portal (served by `docs-router`, loopback-only — mounted before token auth).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | List categories. Top-level `.md` files → a synthetic `guides` category; each subdirectory becomes its own category |
| `GET` | `/:category/:slug` | Fetch one document (`{ title, content, category, slug }`) |

Source resolution: `~/.specrails/docs/` (user-editable) wins if present; otherwise the bundled `docs/` from the install.

---

## `/otlp/v1/{traces,metrics,logs}`

OTLP/JSON receiver (`telemetry-receiver`) used by the pipeline-telemetry feature. Reads `specrails.job_id` and `specrails.project_id` from `resource.attributes`. Returns:

- `400` — attributes missing
- `404` — unknown project or job
- `200` — payload accepted

10 MB cap per blob. Once a log payload pushes a blob over the cap, further logs are dropped (a one-shot `logs_truncated` control line is written).

---

## WebSocket — `/ws`

A single connection at `ws://127.0.0.1:4200/ws?token=<authToken>` multiplexes every project and app-level event. The token query param is required.

Every project-scoped message includes a `projectId` field. App-level messages have no `projectId` and reach every handler.

**On connect**, the current Super-mode server sends exactly **one** frame: `desktop.projects` (the project list). There is **no live `init` frame** — the `init` type still exists in `server/types.ts` and is consumed by `usePipeline`, but only demo-mode emits it; per-project initial state is fetched via REST (e.g. `GET /jobs`, `GET /queue`).

### Job, queue & pipeline

| Type | Scope | Notes |
|------|-------|-------|
| `log` | project | Streaming log line |
| `event` | project | Structured job event |
| `phase` | project | Pipeline phase transition |
| `queue` | project | Queue snapshot (`{ jobs, activeJobId, paused, timestamp }`) — job-exit state changes reach the client here |
| `pipeline_status` | project | Pipeline finished (`completed` / `failed`) |
| `exit` | both | Replay of a process exit (`{ code, signal, early }`); also emitted on the terminal stream |
| `job.turn_user` | project | Interactive job: a user prompt was accepted (echoed so the in-job chat can render the bubble immediately; `queued` is true when a turn is already streaming) |
| `job.turn_done` | project | Interactive job: a turn finished streaming, carrying the running sum of real token/cost totals |
| `job.finalized` | project | Interactive job finalized (or crashed): final authoritative totals + terminal status |
| `job.interactive` | project | Loop runs: the accepting-turns signal (`acceptingTurns: true` when an ai-step's resident session goes live, `false` when it settles) — flips the composer between live and the between-steps waiting state without polling |

### Budget & cost

| Type | Scope | Notes |
|------|-------|-------|
| `cost_alert` | project | Job exceeded the per-job alert threshold |
| `daily_budget_exceeded` | project | Project daily budget hit; queue paused |
| `desktop_daily_budget_exceeded` | app | App-wide daily budget hit |
| `spending.invalidated` | project | Analytics cache should refetch (no payload) |

### Tickets, specs & drafts

| Type | Scope | Notes |
|------|-------|-------|
| `ticket_created` | project | New ticket |
| `ticket_updated` | project | Ticket changed (`ticket.id === 0` signals a full external refetch) |
| `ticket_deleted` | project | Ticket removed |
| `spec_gen_stream` / `spec_gen_done` / `spec_gen_error` | project | Quick generation lifecycle |
| `spec_draft.update` | project | Live Explore spec-draft update |
| `ticket_ai_edit_stream` / `ticket_ai_edit_done` / `ticket_ai_edit_error` | project | AI Edit (Refine) session lifecycle |
| `smash.started` / `smash.progress` / `smash.completed` / `smash.failed` / `smash.undone` | project | SMASH epic-split lifecycle |

### Chat & Explore

| Type | Scope | Notes |
|------|-------|-------|
| `chat_stream` | project | Streaming assistant chunk |
| `chat_done` | project | Turn finished |
| `chat_error` | project | Turn failed |
| `chat_title_update` | project | Auto-titled a conversation |
| `chat_command_proposal` | project | The assistant proposed a command |
| `explore.contract_refine_started` / `explore.contract_refine_failed` | project | Contract Refine lifecycle |

### Proposals & spec launcher

| Type | Scope | Notes |
|------|-------|-------|
| `proposal_stream` / `proposal_ready` / `proposal_refined` / `proposal_issue_created` / `proposal_error` | project | Proposal lifecycle |
| `spec_launcher_stream` / `spec_launcher_done` / `spec_launcher_error` | project | Spec launcher lifecycle |

### Agents & profiles

| Type | Scope | Notes |
|------|-------|-------|
| `agent.changed` | project | Agent catalog updated |
| `profile.changed` | project | Profile catalog updated |
| `agent_refine_stream` / `agent_refine_ready` / `agent_refine_phase` / `agent_refine_applied` / `agent_refine_cancelled` / `agent_refine_error` | project | Agent refine session lifecycle |

### Rails

| Type | Scope | Notes |
|------|-------|-------|
| `rail.job_started` / `rail.job_completed` / `rail.job_stopped` | project | Rail job lifecycle |
| `rail.updated` | project | A non-launch rail change (tickets reassigned, renamed, mode/profile/engine edited) — carries the full post-mutation rail snapshot |

### Plugins

| Type | Scope | Notes |
|------|-------|-------|
| `plugin.installed` / `plugin.uninstalled` | project | Install/uninstall completed |
| `plugin.health_changed` / `plugin.degraded` | project | Health flipped |
| `plugin.install_progress` | project | Streaming install progress |
| `plugin.prereq_install_progress` / `plugin.prereq_installed` | project | Prerequisite install lifecycle |

### Files (Code explorer)

| Type | Scope | Notes |
|------|-------|-------|
| `file.provenance_updated` | project | A job touched files |
| `file.summary_updated` / `file.summary_failed` / `file.summary_skipped` | project | Summary lifecycle |

### Jira

| Type | Scope | Notes |
|------|-------|-------|
| `jira.synced` | project | Inbound poll materialized issues into the local cache |
| `jira.sync_error` | project | A sync attempt failed |
| `jira.auth_expired` | project | A `401` paused the project; the user must re-paste a token (then `POST /jira/resume`) |
| `jira.outbox_changed` | project | The durable write-back outbox changed (op enqueued/drained/dead-lettered) |
| `jira.degraded` | project | A write-back op was dead-lettered or a path is blocked; sync continues |

### Setup wizard

| Type | Scope | Notes |
|------|-------|-------|
| `setup_log` | project | Streaming install log line |
| `setup_chat` | project | Setup-chat assistant chunk |
| `setup_checkpoint` | project | Checkpoint state change |
| `setup_install_done` | project | `npx … init` finished |
| `setup_turn_done` | project | One setup-chat turn finished |
| `setup_complete` | project | Setup wrapping up |
| `setup_error` | project | Setup failed |

### App-level

| Type | Scope | Notes |
|------|-------|-------|
| `desktop.project_added` | app | New project registered |
| `desktop.project_removed` | app | Project unregistered |
| `desktop.projects` | app | Bulk project list refresh |

### Client filtering pattern

WS handlers use a ref (not state) to avoid stale closures:

```tsx
const activeProjectIdRef = useRef(activeProjectId)
useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

// In the WS message handler:
if (msg.projectId && msg.projectId !== activeProjectIdRef.current) return
```

App-level messages (no `projectId`) are processed by every handler.

---

## WebSocket — `/ws/terminal/:id`

A dedicated WebSocket for terminal PTY traffic, separate from `/ws` so a chatty shell can never starve project events.

Connect with `?token=<authToken>&projectId=<id>`.

Attach protocol:

1. Server sends the existing scrollback as one binary frame.
2. Server sends a `{ type: "ready", cols, rows }` JSON frame.
3. Live PTY output streams as binary frames.
4. Shell-integration marks (OSC 133/1337) parsed server-side stream as JSON `{ type: "mark", kind, … }` frames.

Client → server: text input as binary; `{ type: "resize", cols, rows }` JSON on viewport changes.

---

## Errors

The app uses standard HTTP status codes. Notable conventions:

- `400` — malformed body / invalid params
- `401` — missing or invalid token (Bearer or `X-Desktop-Token`)
- `403` — cross-origin request (a non-localhost `Origin` header), or a feature gated off (interactive jobs disabled, code-explorer deny-list/gitignore)
- `404` — resource not found (including a project resolved from an unregistered path, or any route under a disabled section gate such as Jira / Code explorer)
- `409` — write conflict (file-lock contention on tickets, plugin/profile name collision, project path already registered) or a state conflict (e.g. not an active interactive job, Contract Refine unsupported)
- `413` — payload too large (code-explorer edit over the 2 MB cap)
- `415` — unsupported media type (code-explorer edit of binary content)
- `500` — unhandled exception (logged to stdout)
- `503` / launch error — the selected provider CLI was not found; no job is
  allowed to start with a missing executable

Error responses are `{ "error": "<message>" }`.

---

## Caveats

- **Surface drift**: this file is hand-maintained against the route declarations in `server/*-router.ts`, the per-domain `server/project-router-{jobs,spending,settings,terminals,tickets,chat,setup}.ts` family, `server/code-explorer-router.ts`, and `server/jira-router.ts`. The app adds endpoints regularly; if a route exists in code but not here, please open an issue.
- **Stability**: routes under `/api/*` and `/api/projects/:projectId/*` are considered stable. A few legacy setup endpoints (`setup/start`, `setup/message`, `enrich/*`) back a flow the UI does not expose and remain only for forward compatibility.
