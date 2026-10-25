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

## Versioning and deprecation policy

Every response under `/api` — desktop routes, project-scoped routes, public routes, auth rejections and 404s — carries the header:

```http
X-Specrails-Api-Version: 1
```

The header is set by middleware mounted in `server/index.ts` before any `/api` router (and exposed to allowed CORS origins), so no route can bypass it. `GET /api/health` (public) also returns `apiVersion`, and `GET /api/meta` (authenticated) returns the full version set. The constant lives in `server/api-version.ts`.

Rules:

1. **Additive changes keep the version.** New routes, new optional request fields and new response fields are not breaking. Clients must ignore response fields they do not know.
2. **`apiVersion` is bumped only on a breaking change**: removing or renaming a route or field, changing a field's type or meaning, tightening validation of an existing request, or changing a WebSocket event contract. A bump is a `feat!`/`fix!` commit with a `BREAKING CHANGE:` footer.
3. **Deprecate before removing.** A route or field to be removed is first marked deprecated: it keeps working, the deprecation is recorded in the ledger below and announced in `CHANGELOG.md` under a **Deprecations** heading for the release that ships it (see [CONTRIBUTING](../../CONTRIBUTING.md#api-changes-and-deprecations)).
4. **Keep deprecated surface for at least two minor releases.** Something deprecated in `2.65.0` can be removed no earlier than `2.67.0`, and the removal itself is a breaking change under rule 2.

Deprecation ledger (newest first):

| Route or field | Deprecated in | Earliest removal | Replacement |
|---|---|---|---|
| — | — | — | No deprecations yet |

This page is hand-maintained against the route declarations in `server/*-router.ts`, the per-domain `server/project-router-{jobs,spending,settings,terminals,tickets,chat,setup}.ts` family, `server/modules/code/runtime/code-explorer-router.ts`, and `server/jira-router.ts`. If you spot a discrepancy, please file an issue.

---

## Top-level mounts

| Prefix | Router | Auth | Notes |
|--------|--------|------|-------|
| `/api/health` | direct | none | Liveness probe (`{ status, version, apiVersion, uptime, projects, mode }`) |
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
| `POST` | `/projects` | Register a project. Body `{ path, name?, provider?, providers? }`. Each provider value is one of `claude`, `codex`, `gemini`, `kimi` (registry-validated). `providers: string[]` enables a multi-provider project (first entry = primary/default); legacy single `provider` still honoured; omit both to register with the auto-detected provider set (`["claude"]` when nothing is detected yet). After `201` the workspace is assembled in the background for the detected providers; progress arrives as `project.assemble_progress` WS events. 409 if the path is already registered or Kimi fails its executable/version/Core-target checks. 400 if a provider is unknown, or if a disabled provider is selected: `codex` when `SPECRAILS_CODEX_BETA=0`, `gemini` when `SPECRAILS_GEMINI_BETA=0` (both default-enabled). Kimi has no beta flag: it requires a usable `kimi` CLI ≥ 0.27.0 and a Core build that advertises the Kimi target. Kimi 0.27 has no safe non-billing authentication probe, so login/model configuration is confirmed by the first real turn |
| `DELETE` | `/projects/:id` | Unregister (does not delete the project directory) |
| `POST` | `/projects/:id/assemble-retry` | Re-run the background workspace assembly for the providers that failed (every detected provider when none is recorded as failed). `202 { retrying: [...] }`, or `202 { alreadyRunning: true }` while one is running; `409` when no provider is detected; progress via `project.assemble_progress` |
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
| `GET` | `/available-providers` | Provider catalogue used by the Add Project dialog (no-provider warning), mission and provider pickers. Registry-driven map (`{ claude, codex, gemini, kimi, tiers, providerIssues, launchDescriptors }`) reporting which CLIs are usable. Codex/Gemini are surfaced unless forced off by `SPECRAILS_CODEX_BETA=0` / `SPECRAILS_GEMINI_BETA=0` (both enabled by default). Kimi is reported unavailable, with a machine-readable `providerIssues.kimi`, when the CLI is missing/unusable, is older than 0.27.0, or the installed Core lacks the Kimi target. The bounded readiness probe is intentionally non-billing and cannot prove account authentication; a login/configuration problem is surfaced by the first model turn. `launchDescriptors` exposes each external CLI command; the app does not bundle a Kimi daemon/server |
| `GET` | `/meta` | Versions a client negotiates with: `{ apiVersion, appVersion, coreVersion, contractSchemaVersion, channel, updateManifestUrl }`. `coreVersion` is the Core in use (active framework, else the located contract's Core, else the bundled one); `contractSchemaVersion` is the integration contract's `schemaVersion`; unknown values are `null`. `channel` is the update channel (`latest` or `stable`) and `updateManifestUrl` the Tauri updater manifest it reads |
| `GET` | `/core-compat` | specrails-core version compatibility probe |
| `GET` | `/core-update/status` | Core update status without network access. Includes `channel`, `resolvedDistTag` (`latest`/`stable`/`null`) and `channelFallback` (`true` when `stable` was requested but Core has no `stable` dist-tag, so `latest` was used). A version cached for another channel is never offered |
| `POST` | `/core-update/check` | Resolve the channel's npm dist-tag (`stable` → `stable`, falling back to `latest` only on a 404 for the tag) and return the refreshed status |
| `POST` | `/core-update/update` | Install the checked version (or `{ version }`). `202`; progress over the `core_update.progress` WebSocket event |
| `GET` | `/setup-prerequisites` | Tool checks (`node`/`npm`/`npx`/`git`, optionally `uv`). Add `?diagnostic=1` to nest a `diagnostic` object: `{ pathSegments, pathSources, loginShellStatus, whichResults, nodeEnv, platform }` |

### Settings, budget, theme

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/settings` | App-wide settings, including `allowSubagents` (default `true`), `subagentRuntime` (default `null`) and `updateChannel` (`latest` default, or `stable`) |
| `PUT` | `/settings` | Update any subset of `{ port?, specrailsTechUrl?, costAlertThresholdUsd?, allowSubagents?, subagentRuntime?, updateChannel? }`. `updateChannel` must be `latest` or `stable` (otherwise `400` and nothing is written); it selects the Desktop updater manifest and the Core npm dist-tag. `subagentRuntime` is `null` (same as the mission agent) or `{ provider, model, effort: string \| null }` for missions without a project; an invalid value returns `400`. `allowSubagents` is the app-wide "Allow sub-agents" setting for missions without a project. It must be a boolean (otherwise `400` and nothing is written), and a change refreshes the policy of open sessions |
| `GET` | `/budget` | App-wide budget config |
| `PATCH` | `/budget` | Update the app-wide budgets: `{ desktopDailyBudgetUsd?, desktopWeeklyBudgetUsd?, desktopMonthlyBudgetUsd?, runCapUsd?, costAlertThresholdUsd? }` (`null` clears, a number > 0 sets; a bad weekly / monthly / run value is `400 { error: 'invalid_cap', field }`). `GET /budget` reports the same fields |
| `GET` | `/budget/caps` | Budget panel read model, app-wide: `{ generatedAt, spend: { day, week, month }, projection, config, caps }`. `spend.<period>` is `{ startsAt, resetsAt, usd, estimatedUsd, byProvider: [{ provider, usd, estimatedUsd, invocations, turns }] }` over the LOCAL period (week starts Monday); `projection` is `{ estimate: true, trailingDays, avgDailyUsd, monthToDateUsd, remainingDays, projectedUsd }` or `null` without a completed day of history; `config` is `{ day, week, month, run }`; `caps` lists the configured app-wide caps `{ scope, period, budgetUsd, spentUsd, exhausted, resetsAt }` |
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

### Failure diagnosis

A run that ended `failed`, `blocked` or `stalled` carries one typed record explaining why. It is persisted in `loop_runs.failure_diagnosis` when the run settles (migration 84) and served read-only by:

- `GET /api/projects/:projectId/jobs/:id` as `job.failureDiagnosis`;
- `GET /api/projects/:projectId/loop-runs/:id` as `loopRun.failureDiagnosis` (a delivery card reads its last run's);
- `GET /api/inbox` as `diagnosis` on failed / blocked items.

Shape: `{ kind, confidence, phase, rounds, resetAt, detail, resumablePhase, blocker, source, remedies }`.
`kind` is `tests_failed`, `provider_limit`, `environment`, `blocked`, `timeout`, `tool_inactivity`, `crash` or `unknown`; `confidence` is `high` or `low` (a low-confidence record is always `unknown`); `source` is `core` (the classification of Core contract 5.8) or `desktop` (derived from the loop's stall reason, the provider-limit signal, Core's fixed blocker sentences or `completion.blocker`); `remedies` are ranked ids from `resume`, `retry`, `edit-spec`, `fix-environment`, `open-logs`. A run finished before the column existed reads as `unknown`/low, and a successful run has none. Module: [`server/modules/recovery`](../../server/modules/recovery/README.md).

### Needs-you inbox (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/inbox` | Read-only projection of what waits for the person, across every registered project: `{ items, projects, generatedAt }`. Each item: `id` (`<projectId>:<kind>:<sourceId>`), `projectId`, `projectName`, `kind` (`review` \| `question` \| `failed` \| `blocked` \| `budget` \| `jira`), `title`, `detail`, `at`, `version` (changes when the state changes), `action` (`open-review` \| `open-run` \| `resume-run` \| `retry-jira` \| `raise-cap`), `subjectId` (delivery id, loop-run id, Jira outbox id, or `<scope>:<period>` for a cap), `conversationId`, `diagnosis` (a failed / blocked run's [failure diagnosis](#failure-diagnosis), else `null`; a provider limit or environment problem is listed as `blocked`), and — only on a reached spend cap (`kind: 'budget'`, `action: 'raise-cap'`, id `<projectId>:budget:cap-<scope>-<period>`) — `cap: { scope, period, budgetUsd, spentUsd, resetsAt }`. An app-wide cap is listed once, under the first project. Newest first, at most 50 per project. Each project is read through its own database and a failing project is skipped; nothing is cached or stored. Snooze and Done are per viewer and never reach the server. Module: [`server/modules/inbox`](../../server/modules/inbox/README.md). |

### Sample project (first run)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/onboarding/sample` | `{ catalog: [{ id, name, specCount }], sample, defaultParentDir, launch }`. `sample` is the created sample (`{ sampleId, projectId, path, specIds }`) or `null`; a record whose project was removed by hand is dropped. `launch` is the pre-validated first-run configuration: `{ ready: true, preset, localPreset, estimate: { minutes: [3, 5], usd: [0.3, 1] }, runCapUsd }` or `{ ready: false, reason: 'no_provider' \| 'not_signed_in', estimate, runCapUsd }`. `preset` is `{ provider, model, local, loopId: 'factory:sdd-quick-openspec', runCapUsd }`: the cheapest priced model of the cheapest ready cloud provider with the per-run soft cap, or a configured local engine (no cap). `localPreset` is the local alternative when both exist. The estimate is a static, labelled envelope, never a quote. `?refresh=1` re-probes the providers first; a failing probe is "not ready", never an error. |
| `POST` | `/onboarding/sample` | Body `{ sampleId?, locale?, path?, parentDir? }`. Copies the bundled tic-tac-toe repository, runs `git init -b main` plus one commit, installs the three specs (title, summary and description in `locale`, English as fallback) and registers the project (broadcasting `desktop.project_added`, with the usual silent workspace assembly). `201 { reused: false, project, sample }`; a second call returns `200 { reused: true, ... }` and writes nothing. The folder must be strictly inside the home directory (`400 outside_home`); an explicit `path` must not exist (`409 path_exists`); without `path` the first free `<parentDir>/<name>[-N]` is used (default parent `~/Specrails Samples`). `404 unknown_sample`, `500 git_failed` / `write_failed` / `register_failed` (everything created is removed). |
| `DELETE` | `/onboarding/sample` | `?deleteFolder=1` (or body `{ deleteFolder: true }`) also deletes the folder, only when it is the recorded path, strictly inside home and still a git repository (`409 unsafe_delete` otherwise; the project is not unregistered then). Returns `{ ok, removedProject, deletedFolder }`; `404 not_found` when there is no sample. Module: [`server/modules/onboarding`](../../server/modules/onboarding/README.md). |

The first run itself is the ordinary rail launch: the client assigns the first sample spec to a free rail (`PUT /rails/:n/tickets`) and calls `POST /rails/:n/launch` with `{ loopId, aiEngine, model, runCapUsd }` from the preset.

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

### Mission app addresses

A running mission background process (`GET /api/projects/:id/background-processes`,
its `/:pid/logs` snapshot, the Companion's `/v1/projects/:pid/missions/:cid/processes`
proxy and every `background_process.*` WS event) carries
`appUrls: { local: string[], network: string[] }` once its output announces an
address. `local` opens on the Desktop computer; `network` holds private LAN/VPN
addresses (RFC 1918, `100.64/10`, `*.local`, or this machine's addresses for a
`0.0.0.0` bind) that a phone on the same Wi-Fi opens in its own browser. The
field is derived from the retained logs on read, never persisted, and absent
once the process stops. A new or changed address is announced as a
`background_process.updated` event; log lines themselves are not broadcast.

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

### Missions: Core agent session sub-agents (`/api/agent/*`)

These routes are available when a mission ran in a Core agent session (`SPECRAILS_CORE_SESSIONS`, see [agent sessions](../../server/modules/agent-sessions/README.md)). Rows are Desktop's rebuildable projection of Core's session journal.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/agent/active-turns` | Reconnect snapshot. Besides `turns`, the response includes `sessions[]`: `{ conversationId, residentPhase, processAlive, liveSubagents, subagents }` for missions with background work. |
| `DELETE` | `/agent/conversations/:id` | Soft delete: stops the live turn, closes the Core session and hides the mission (`deleted_at`); `{ ok, restorable: true }`. `?permanent=1` removes the row, history and attachments for good (`404` unknown id). Deleted missions are `404` on `GET /agent/conversations/:id` and `/send`, and absent from the list, search and mobile listings |
| `GET` | `/agent/conversations/trash?projectId=` | Deleted missions pinned to the project (all when omitted), newest deletion first: `{ items: [{ conversation, deletedAt, purgeAt }], retentionDays: 30 }`. Purges missions deleted more than 30 days ago first |
| `POST` | `/agent/conversations/:id/restore` | Undo a delete; idempotent. `{ ok, conversation }`, `404` when the mission no longer exists |
| `GET` | `/agent/conversations/:id` | Includes `session`: `{ residentPhase, processAlive, liveSubagents, subagents }`, or `null` when the mission never ran in Core. |
| `GET` | `/agent/conversations/:id/subagents` | `{ subagents, session }`. Each sub-agent has id, parent, kind, agent type, description, phase (`running`/`idle`/`failed`/`stopped`/`killed`/`interrupted`), reason, restarts, launching Core turn, timestamps, usage, tool uses, duration and result summary. Sub-agents Specrails launched on another provider carry `delegated: { driver, model }`; their usage is recorded as separate `subagent` invocations. |
| `GET` | `/agent/conversations/:id/subagents/:subagentId/events?after=&limit=` | Paged sub-agent transcript `{ events: [{ seq, channel, delta?, tool?, createdAt }], hasMore }`. `limit` is 1–1000. |
| `POST` | `/agent/conversations/:id/subagents/stop` | Body `{ subagentIds? }` (all when omitted). Returns `{ stopped }`; `502` when the session host is unavailable. |
| `POST` | `/agent/conversations/:id/session/rebuild` | Operator repair: replays the mission's Core journal into its sub-agent rows, events, resident state and cursor. Turns already recorded as messages/invocations are not duplicated; the replay is silent, then clients receive `agent_resident_state` and one `agent_subagent` per row. Returns `{ lastSeq, subagents }`; `409` while a turn runs or when the mission has no Core session; `502` when the host is unavailable. |

| `GET` | `/agent/session-hosts` | `{ hosts: [{ scope, status, detail, code }] }`: one entry per Core session host scope (project slug or `global`). `code` explains a degraded scope (`journal_locked`, `protocol_mismatch`, `driver_unavailable`). |
| `POST` | `/agent/session-hosts/:scope/retry` | Starts a degraded scope again. Returns `{ host }`, or `502` with `{ error, host }` when it is still unavailable. |

WebSocket events for these missions:

- `agent_resident_state`, `agent_subagent`, `agent_subagent_event`;
- `agent_turn_started` / `agent_turn_done` for turns Core starts after sub-agents finish (origin `subagent` or `system`);
- `agent_session_updated` (`applied` / `deferred`) and `agent_session_notice` (`level`, `code`, `message`, optional `scope`). The notice covers provider warnings such as `policy.subagent_blocked`, and a turn that fell back to the legacy transport (`host_degraded`, `journal_locked`);
- `agent_sessions_host` (app-level, no `projectId`): `{ scope, status, detail, code }` on every host status change.

Background turns also stream `agent_stream`, `agent_tool` and `agent_tool_result` with a `turnId`.

`agent_session_notice` with code `subagents.delegation_unsupported` or `subagents.driver_unavailable` (and `provider`) says a "Run sub-agents with" choice cannot be honoured, so the mission stays native. In delegated missions the agent uses the `specrails_mission` MCP actions `subagent_start`, `subagent_wait`, `subagent_list` and `subagent_stop`.

`agent_error` may carry `code` and `provider` for failures the client explains in the user's language. One example is `policy_unenforceable`, sent when a provider cannot honour "Allow sub-agents: off".

Flow mode: `POST /agent/conversations/:id/send` also accepts `deliveryMode: 'interrupt'`, only while the conversation's Flow is active (`409 interrupt_requires_flow` otherwise). In a Flow every mid-turn input reaches Core as `session.send { delivery: 'interrupt' }`, which cuts the running turn and runs the input next; the reply continues the same user turn. A Flow turn on a host without `flowSessions` fails with `agent_error` code `flow_sessions_unavailable` (there is no legacy Flow transport). Flow turns are recorded in `agent_invocations` with `surface: 'flow'`.

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
| `GET` | `/jobs/:runId/audit` | Agent actions of one run (job id or loop run id) as an attachment. `?format=jsonl` (default) or `csv`. Pending batched rows are flushed first; at most 100 000 rows, oldest first; `X-Agent-Actions-Rows` carries the count. `400` invalid format. See [agent actions audit](agent-actions-audit.md) |
| `GET` | `/agent-actions` | Project-wide agent actions export. `?format=jsonl\|csv&from=&to=` (ISO timestamps, inclusive). `400` for an invalid format, an unparsable timestamp or `from` after `to` |
| `GET` | `/jobs/compare` | Compare metrics between two jobs |
| `GET` | `/jobs/:id` | One job. Returns `{ job, events, phaseDefinitions }`; `job` is annotated with `hasTelemetry`, `tickets[]` (resolved from the command, powers the ticket header), `interactiveSettleMode` (`'finalize'` \| `'auto'` \| `null`) and `interactiveAcceptingTurns` (whether a resident session accepts turns right now — a between-steps loop run reports `'auto'`/`false` so the composer can phrase the waiting state) and `failureDiagnosis` (`null`, or why a failed / stalled / blocked job stopped: see [failure diagnosis](#failure-diagnosis)) |
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
| `GET` | `/analytics/decision-times?period=7d\|30d\|90d\|all\|custom&from&to` | Time to decision / merge per delivery: `{ period, from, to, project, byLoop[] }`, each group `{ deliveries, toDecision, toMerge }` with `{ measured, pending, unknown, medianMs, p90Ms }`. Window = `on_review_at` (or `created_at` for legacy rows). `medianMs`/`p90Ms` are `null` when nothing is measurable; unknown is never zero. Repository children are excluded (counted via the group parent). 400 on an invalid period or a custom period without `from`/`to` |
| `GET` | `/analytics/loop-economics?period=7d\|30d\|90d\|all\|custom&from&to` | Loop economics: `{ period, from, to, sources: { escapedDefects: tracked\|untracked, requirementsDemonstrated: measured\|unavailable, triageAccuracy: unavailable }, project, byLoop[] }`. Each group: `{ hasData, delivered, merged, discarded, superseded, onReview, discardRate, cost: { pricedDeliveries, unpricedDeliveries, incompleteDeliveries, totalUsd, authoritativeUsd, estimatedUsd, avgCostUsd, estimatedShare }, decisionTimes, rounds: { measuredDeliveries, reviewRounds, fixerRounds, reviewPerDelivery, fixerPerDelivery }, escapedDefects, requirementsDemonstrated, triageAccuracy }`; loops add `loopId`, `loopName`. Delivered = parent delivery that reached `on_review` or beyond. Unknown values are `null`, never 0; published saved loops without deliveries appear with `hasData: false`. `escapedDefects` counts tickets whose `metadata.regressionOf` names a delivery in the window (null while no ticket carries a link). `requirementsDemonstrated` is `{ demonstrated, total, deliveries }` summed over the spec traces (Core `specTrace`) in the settle evidence of delivered deliveries, `null` when none carries one. Same period validation as decision-times |
| `GET` | `/analytics/loop-economics/deliveries?limit=50` | Recent delivered parent deliveries `{ deliveries: [{ id, loopId, loopName, decision, ticketIds, createdAt }] }` (max 200) — source of the ticket "Regression of" picker |

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
| `GET` | `/budget` | Daily / weekly / monthly caps, per-run soft cap and per-job alert: `{ dailyBudgetUsd, weeklyBudgetUsd, monthlyBudgetUsd, runCapUsd, jobCostThresholdUsd, costToday, … }` |
| `PATCH` | `/budget` | Update `{ dailyBudgetUsd?, weeklyBudgetUsd?, monthlyBudgetUsd?, runCapUsd?, jobCostThresholdUsd? }`. `null` clears; a number > 0 sets; a bad weekly / monthly / run value is `400 { error: 'invalid_cap', field }`. All caps are enforced by the same gate (below) |
| `GET` | `/budget/caps` | Budget panel read model: `{ generatedAt, spend, projection, config, appConfig, caps }` — see the app-wide `GET /api/budget/caps` for the shapes. `caps` holds every configured cap of this project AND the app-wide ones with the spend the gate counts; `spend.<period>.byProvider` carries `turns` so a subscription provider can show turns instead of dollars. The projection is an estimate (average of the last 14 completed local days × days left in the month + month to date, integer cents), never a billed figure |
| `GET` | `/budget/what-if?from=<provider:model>&to=<provider:model>&days=30` | What-if pricing over recorded usage. Without `from`/`to`: `{ days, sources, targets, result: null }` (`sources` = models seen in the window with `{ invocations, recordedUsd, priced }`, `targets` = every model the local rate card prices). With both: `result` re-prices each invocation's recorded tokens on both models (`estimateCurrentUsd`, `estimateWhatIfUsd`, `deltaUsd = whatIf − current`, all estimates) and reports `repriced` / `skipped` invocations and `recordedUsd` apart. A model without a rate card yields `noPricing: { side, provider, model }` and null estimates, never a guess. `400 invalid_model_ref` on a malformed ref. Usage is recorded per model, not per profile role |
| `GET` | `/run-duration-range?loopId=\|command=` | Measured p25/median/p75 of this project's settled runs of a loop or job-command shape (`{ range, minSamples }`); `range` is `null` below 5 samples. Feeds the job story's "Runs like this have taken…" |
| `GET` | `/launch-forecast?loopId=\|command=&provider=` | Read-only launch forecast: `{ time, cost, minSamples, budget }`. Same samples as `run-duration-range`, narrowed to `provider`. `time` is `{ p25Ms, medianMs, p75Ms, sampleCount }`. `cost` is `{ lowUsd, highUsd, sampleCount }` (cents), built **only** from provider-reported costs (estimated costs and runs without a cost are excluded) and is an estimate, never a billed figure. Each is `null` below the 5-sample floor (render "Not enough history yet"). `factory:implement`/`factory:batch`/`factory:freestyle` read the `/specrails:implement`/`/specrails:freestyle` jobs; any other loop id reads `loop_runs`. `budget` is the tightest configured cap (daily, weekly or monthly; project or app-wide) `{ scope, period?, budgetUsd, spentUsd, exhausted, resetsAt }` (the same figures the launch gate enforces; `period` is absent for the daily budget) or `null`. `400` without `loopId`/`command` or on a malformed `provider` |

### Scoped search (⌘K)

The command palette's scopes. Missions (`@`) stay on `GET /api/agents/search`, files (`f:`) on `GET /code/find`
and docs (`?`) on `GET /api/docs/search`; these two are project-scoped and read only that project's data.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/search/specs` | `?q=` (required, single line, at most 200 characters, `400` otherwise), `?limit=` (default 8, max 30). Folded (case- and diacritics-insensitive) substring scan of the ticket store: title, short summary, description, labels, non-goals, addenda and comments, so it is never behind the file Core also writes. `#12`/`12` also matches by id. Live Flow placeholders are skipped. Returns `{ results: [{ id, title, status, priority, field, snippet }] }`, best field first (`field`: `id` \| `title` \| `summary` \| `label` \| `description` \| `nonGoal` \| `addendum` \| `comment`), then newest. `snippet` is `{ text, ranges: [[start, end], ...] }` (plain text plus character ranges to mark; never HTML) or `null` |
| `GET` | `/search/jobs` | Same `q`/`limit` rules. FTS5 trigram search (`bm25`, one row per job; queries under 3 characters use a bounded `LIKE` scan) over the job-log index of this project's database (migration 86, `server/db/job-search.ts`): job command, loop name, phase titles and the failure diagnosis kind/detail/host-blocker text. It never indexes events or token streams. Returns `{ results: [{ jobId, command, status, startedAt, field, snippet }] }` (`field`: `command` \| `loop` \| `phase` \| `failure` \| `detail`). `jobId` is also the loop-run id, so the client opens `/jobs/:jobId` |

The job-log index (`job_search_docs` + external-content `job_search_fts`) is derived data kept current at job create,
phase events and settle (`finishJob`, loop-run settle), cleaned on delete/purge, and bounded: 300 characters per
document, 30 phase documents per job, 30,000 documents per project (the oldest tenth is dropped when over). Migration 86
creates it and runs the same idempotent backfill (`rebuildJobSearchIndex`, newest 5,000 jobs). An indexing failure never
fails the write that triggered it.

### Tickets

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/tickets` | Filters: `?status=`, `?label=`, `?q=` |
| `GET` | `/tickets/:id` | One ticket |
| `POST` | `/tickets` | Create. Optional `nonGoals: string[]` ("Out of scope"; `400 nonGoals must be an array of strings` otherwise) |
| `PATCH` | `/tickets/:id` | Update any subset of fields. `metadata` merges keys; `metadata.regressionOf` (delivery id string ≤ 200 chars, escaped-defect link) is validated on create/update/commit-draft (400 otherwise) and `null` removes it. `nonGoals` (string array; `[]` or `null` removes the field) is cleaned (list markers, blanks, duplicates; at most 20 items of 300 characters) and never written back to Jira |
| `DELETE` | `/tickets/:id` | Soft delete: the spec moves to the trash sidecar `<store>.trash.json` (hidden from every list, search and Core read; `{ ok, revision, restorable: true }`, `404` unknown id, repeat deletes are idempotent). A deleted epic orphans its children. Attachments, the Explore draft conversation and the Jira link are kept until the entry is purged or deleted permanently. Broadcasts `ticket_deleted` |
| `GET` | `/tickets/trash` | Recently deleted specs, newest deletion first: `{ items: [{ ticket, deletedAt, purgeAt }], retentionDays: 30 }`. Purges entries older than 30 days first |
| `POST` | `/tickets/:id/restore` | Undo a delete: the spec returns under the same id (and re-adopts the children it orphaned). Idempotent (`alreadyLive: true`), `404` when it is in neither the board nor the trash. Broadcasts `ticket_created` |
| `DELETE` | `/tickets/trash/:id` | Delete permanently: removes the entry plus the cascade a hard delete used to run (attachments, the draft's orphan Explore conversation). `404` when not in the trash |
| `POST` | `/tickets/generate-spec` | Quick-mode generation. Body `{ idea, model?, contractRefine?, aiEngine?, attachmentIds?, pendingSpecId?, contextScope? }` (the spec text is `idea`, not `title`). Streams progress over WS |
| `POST` | `/tickets/save-as-draft` | Persist an Explore conversation as a draft (idempotent on `conversationId`) |
| `POST` | `/tickets/from-draft` | Commit a draft (flip-in-place) or insert a new ticket. An explicit `nonGoals` list wins; otherwise a `## Out of Scope` section of the description moves into `nonGoals` |
| `POST` | `/tickets/from-prompt` | Create a ticket directly from a prompt |
| `POST` | `/tickets/:id/contract-refine` | Retry Contract Refine for an existing ticket. `202` scheduled, `404` unknown ticket, `409` when the effective provider cannot enforce the required tool policy (`contract_refine_unsupported_for_<provider>`; this includes Kimi), the kill switch is active (`feature_disabled_by_env`), or the ticket has no origin conversation. Kimi is rejected before spawn or mutation |
| `POST` | `/tickets/:id/triage` | Recalculate the [spec triage](spec-triage.md) (forced, even when the inputs hash is unchanged). `200 { triage }` with the stored `metadata.triage` record (`ready`, `unavailable` or `failed`), `400` invalid id, `404` unknown ticket, `409 { error: 'triage_not_applicable', reason }` for a cancelled spec, an epic or a Flow-held spec, `503 triage_unavailable` when the project has no triage service. The record is also broadcast as `ticket_updated` |
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
| `DELETE` | `/chat/conversations/:id` | Delete (clears `origin_conversation_id` on linked draft tickets). Sidebar/Explore chats keep their hard delete; the soft delete applies to specs and agent missions |
| `GET` | `/chat/conversations/:id/messages` | List messages |
| `POST` | `/chat/conversations/:id/messages` | Send a turn; streams over WS |
| `DELETE` | `/chat/conversations/:id/messages/stream` | Cancel an in-progress turn |
| `GET` | `/chat/conversations/:id/spec-draft` | Live spec-draft state |
| `POST` | `/chat/conversations/:id/minimize` | Park the session (arms the idle-kill timer) |
| `POST` | `/chat/conversations/:id/restore` | Cancel the idle-kill timer |

### Setup (API / MCP only)

The app UI has no setup wizard: adding a project assembles its workspace in the background (see `POST /api/projects` and `POST /api/projects/:id/assemble-retry`). These per-project routes remain mounted for the MCP `specrails_setup` tool and other API callers. The `enrich/*` and `setup/start`+`setup/message` endpoints back the legacy AI-enriched flow.

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/setup/install-config` | Write `.specrails/install-config.yaml` to the project |
| `POST` | `/setup/install` | Run `npx specrails-core init --from-config <file>` (the pinned Core range `CORE_PACKAGE_SPEC` from `server/core-package.ts` — currently `specrails-core@^6.0.0` — is resolved by SetupManager, overridable via `SPECRAILS_CORE_BIN`) |
| `POST` | `/setup/start` | Legacy setup-chat session start |
| `POST` | `/setup/message` | Legacy setup-chat turn |
| `POST` | `/enrich/start` | Legacy AI-enrich session start |
| `POST` | `/enrich/message` | Legacy AI-enrich turn |
| `GET` | `/setup/checkpoints` | Checkpoint state + last log lines |
| `POST` | `/setup/abort` | Abort the in-progress install |

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
| `GET` | `/settings` | Project settings, including `allowSubagents` (default `true`), `subagentRuntime` (default `null`), `reviewerFamilySuggestionDismissed` (default `false`), `reviewWipLimit` (default `null` = no limit), `agentAuditRetentionDays` (default `30`), `jiraPostClarifications` (default `false`) and `baselineOnTouch` (default `false`) |
| `PATCH` | `/settings` | Update. `reviewWipLimit` is an integer from 1 to 100 or `null` (otherwise `400` and nothing is written). `allowSubagents` must be a boolean; `subagentRuntime` is `null` or `{ provider, model, effort: string \| null }` (strictly validated); `reviewerFamilySuggestionDismissed` must be a boolean. A change to either refreshes the sub-agent policy of the project's open agent sessions. A change to `worktreeEnvPassthrough` (names only) re-warms the project's login-shell recovery. `agentAuditRetentionDays` must be an integer between 1 and 3650. `jiraPostClarifications` and `baselineOnTouch` must be booleans (see [existing-project anchoring](existing-project-anchoring.md)) |
| `GET` | `/core/phase3-capabilities` | `{ architectClarifications, specTrace, baselineOnTouch, rulesInventory }` booleans from the active Core's `runtime api` (all `false` when Core is unavailable). The settings UI gates each switch on its flag |
| `GET` | `/rules` | Project rules inventory (`.specrails/rules.json`, workspace first, then the repository): `{ supported, running, state: 'missing' }`, `{ ..., state: 'invalid', file, message }` or `{ ..., state: 'ok', file, modifiedAt, inventory: { generatedAt, gates, rules[{ id, index, text, source, status: enforcedBy\|automatable\|humanOnly\|unclassified, enforcedBy, proposedCheck }], counts, classification, dropped } }`. `supported` is Core `rulesInventory: 1`; `running` covers the automatic run after setup too; `lastRun: { trigger: setup\|manual, ok, exitCode, output, at }` (absent until a run in this app session) |
| `POST` | `/rules/inventory` | Re-run Core's inventory (`specrails-core rules inventory --root <repo> [--artifact-root <dir>]`). `200 { ok: true, exitCode, output, ...read }`, `502` when the command failed (same body with `ok: false`), `409 rules_inventory_unsupported` without the capability, `409 rules_inventory_running` while one runs for the project |
| `POST` | `/rules/specs` | Body `{ id }` (Core rule id) or `{ index }`: turn an `automatable` rule into a spec (source `rules`, labels `rules`, `automation`, with non-goals). `201 { ticket }`, `400` invalid index or `rule_not_automatable`, `404 rules_missing` / `rule_not_found`, `409 rules_inventory_unsupported` |
| `GET` | `/env-passthrough/status` | Value-free resolution status of every configured `worktreeEnvPassthrough` name: `{ loginShellRecovery, timeoutMs, checking, names: [{ name, status, shell, checkedAt, exitCode }] }`. `status` is `inherited`, `recovered`, `not-defined`, `probe-timeout`, `probe-failed`, or `pending` for a name never checked. Probes first only when a missing name has no valid cached result. Never returns values |
| `POST` | `/env-passthrough/recheck` | Probe the login shell now (asynchronously, `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS`, default 10 s), then return the same payload as the status route |
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

## `/api/projects/:projectId/flow/*`

Flow mode ([guide](flow-mode.md)): build with an agent in an isolated worktree,
then hand the worktree to a rail. Thin routes over the
[Flow module](../../server/modules/flow/README.md). Every response carries the
Flow as `{ id, conversationId, ticketId, state, branch, worktreePath, baseSha,
headSha, coreSessionId, railIndex, deliveryId, step, createdAt, updatedAt }`;
`state` is `active` / `paused` / `handed_off` / `delivered` / `discarded` /
`needs-review` and `step` names an unfinished saga step (`start:*`, `handoff:*`).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/flow/availability` | `{ available, reason, missing[] }`. Available only when Core sessions are usable and Core advertises `flowSessions` and `deriveChange`. |
| `POST` | `/flow` | Start. Body `{ conversationId, idea, title?, flowId?, repositoryId?, ticketId? }`. With `ticketId` the Flow starts from that EXISTING spec (idea optional): no placeholder; the spec is labelled In Flow and seeds the first turn; `400 invalid_ticket_id` / `spec_not_found`, `409 spec_closed` / `spec_in_flow` / `spec_on_rail` / `spec_running` before anything is written. The mission must be pinned to this project and its provider must have a Core session driver on a host with `flowSessions`. Creates the placeholder spec, reserves the worktree and returns `201 { flow }`. Idempotent by `flowId`. `409 flow_already_open` (with `flowId`) when the conversation has an open Flow; `409 feature_unavailable` (with `missing`) without the capabilities; `409 repository_has_no_commits` when the repository has an unborn HEAD (nothing is created; the placeholder spec is removed; the client offers `POST /api/projects/:projectId/git/initial-commit`, which runs only `git commit --allow-empty -m "Initial commit"` in the primary repository against an empty scratch index (zero files, nothing staged) and answers `201 { sha, repositoryId }`, `409 repository_has_commits`, `409 git_identity_missing` or `409 repository_is_not_git`); `400 conversation_not_pinned` / `idea_required` (without `ticketId`). |
| `GET` | `/flow/by-conversation/:conversationId` | `{ flow }`: the open Flow, else the latest one, else `null`. |
| `GET` | `/flow/open` | `{ flows: [{ id, conversationId, state, branch }] }`: the project's conversations in Flow mode (active, paused, needing review) — the mission list's "In Flow" mark. No worktree paths. |
| `GET` | `/flow/:flowId` | `{ flow }`; `404 flow_not_found`. |
| `POST` | `/flow/:flowId/pause` | Closes the Flow's Core session (a running Flow turn is stopped); worktree and spec stay. Idempotent. |
| `POST` | `/flow/:flowId/resume` | Reopens the session lazily on the next turn. `409 flow_worktree_missing` when the worktree disappeared. Idempotent. |
| `POST` | `/flow/:flowId/discard` | Closes the session, removes the Flow worktree and branch and deletes the placeholder spec. `409 illegal_transition` after a hand-off and for a `needs-review` Flow. Idempotent. |
| `POST` | `/flow/:flowId/close` | Ends a `needs-review` Flow WITHOUT deleting anything: branch, any surviving worktree and the spec stay; the Flow becomes `closed` (terminal; `discarded` means the worktree and branch were removed), the spec's `metadata.flow.state` becomes `closed` (no "In Flow" label) and the history gets a `left/closed` boundary. `409 illegal_transition` from any other open state. Idempotent. |
| `POST` | `/flow/:flowId/hand-off` | Body `{ railIndex, loopId?, aiEngine?, model?, reasoning_effort? }`; `loopId` defaults to `factory:flow-spec` (never the rail's default loop). Commits the worktree (HEAD frozen), closes the session, assigns the Flow spec to a free rail and launches it with `flowId`. Returns `202 { flow, loopRunIds, deliveryId }`. A refused launch keeps its status and code (`409 rail_not_empty`, `409 flow_worktree_mismatch`, `409 pr_decision_pending`…) and the Flow returns to `paused`. |
| `POST` | `/flow/by-delivery/:deliveryId/return` | Back to Flow: the Flow → Spec delivery stopped with requested changes (`implementation_failed` / `review_changes_requested`) gives its adopted worktree back. One delivery-owned transaction removes the `rail_worktrees` row, closes the delivery as `discarded` / `returned_to_flow` and sets the Flow `paused` with the review as its next-turn briefing; then the session reopens (`active`, or `paused` when it cannot open). Returns `{ flow }`. Idempotent by delivery. `404 flow_not_found`; `409 flow_return_not_allowed`, `flow_return_busy`, `flow_return_worktree_mismatch`, `flow_worktree_missing`. |
| `POST` | `/flow/by-delivery/:deliveryId/relaunch` | The same return, then the ordinary hand-off on the stopped delivery's rail and engine choices: Flow → Spec runs again on the same worktree and re-derives the existing change. Returns `202 { flow, loopRunIds, deliveryId }`; refusals as for `return` and `hand-off`. |
| `GET` | `/flow/:flowId/diff` | `{ branch, baseSha, headSha, files: [{ path, status, additions, deletions }], totals: { files, additions, deletions } }` — working tree against the Flow base, overlay and `node_modules` excluded. Empty once the Flow is no longer open. |
| `GET` | `/flow/:flowId/cost` | `{ flowId, costUsd, turns, unpricedTurns, tokensIn, tokensOut }` — provider-billed cost of the Flow's turns only; turns without billed cost are counted in `unpricedTurns`, never estimated. |

WebSocket: `flow.state` `{ projectId, conversationId, flowId, flow, timestamp }`
on every committed state change (project-scoped).

The launched `factory:flow-spec` loop exists only on a Core with `deriveChange: 1`
(`409 engine_unsupported` otherwise; `400 flow_id_required` without `flowId`).
When its delivery reaches review the Flow settles: spec rewrite, Jira create and
review transition as durable effects ([settlement](flow-mode.md#settlement)). The
delivery's review packet carries `derivation` and `flowSettlement`.

---

## `/api/projects/:projectId/rails/*`

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | List rails. Also returns `reviewWip { limit, pending: [{ deliveryId, railIndex, ticketIds, decision, since }], reached }` (the review WIP limit and the deliveries that count against it) |
| `PUT` | `/:railIndex/tickets` | Assign tickets to a rail. Body `{ ticketIds: number[], mode?, profileName?, aiEngine? }`. An omitted `mode` keeps the rail's stored mode; `mode` must be `implement` / `freestyle` / `loop` (400 otherwise), with `batch-implement` / `batch` normalized to `implement`. |
| `PUT` | `/:railIndex/profile` | Set the rail's default profile |
| `PUT` | `/:railIndex/engine` | Set the rail's AI engine override. Body `{ aiEngine }` (string — one of the project's providers — or `null` to clear) |
| `PUT` | `/:railIndex/name` | Set the rail's display name. Body `{ name }` (string or `null` to clear back to the default label); 400 if longer than 60 characters |
| `POST` | `/:railIndex/launch` | Launch the rail. Body `{ mode?, loopId?, profileName?, aiEngine?, model?, reasoning_effort?, originConversationId?, originSurface?, interactive?, flowId? }`. `flowId` (sent by the Flow hand-off, never by the dashboard) adopts that Flow's frozen worktree: the rail must carry exactly the Flow spec (`409 flow_rail_mismatch`), the Flow must be waiting for the launch (`409 flow_handoff_not_ready`), the launch must be isolated (`409 flow_requires_isolation`), relaunch/revision/target PR/follow-up/base options are refused (`400 flow_handoff_incompatible`) and a mount/branch/HEAD discrepancy returns `409 flow_worktree_mismatch`. `loopId: 'factory:flow-spec'` without `flowId` returns `400 flow_id_required`. `runCapUsd` (a number > 0 caps this run's provider-reported cost: it pauses and asks through the budget gate; `0` waives the default; absent keeps the project/app default) is accepted on a fresh launch and stored with the run. `mode` is `implement` / `freestyle` / `loop` (the removed Batch mode's `batch-implement` / `batch` are accepted as input aliases and normalized to `implement`); a factory `loopId` maps to its canonical rail mode (`factory:batch` resolves to `factory:implement`). `model` and `reasoning_effort` are validated against the effective adapter/model (Kimi effort is K3-only). Kimi + a loop containing a Decider returns a capability error before the first step. Claude alone advertises persistent in-job stdin; `interactive` remains wire-compatible. Returns `202 { jobId, railIndex, mode }`; a missing provider CLI fails before a job starts. While the project or app-wide daily budget is exhausted, this route and `/relaunch` return `409 { error: 'daily_budget_exceeded', scope, period?, budgetUsd, spentUsd, resetsAt, detail, action }` and spawn nothing (`period` is `week` / `month` for the longer caps and absent for the daily budget, so the body predating caps is unchanged). `POST /loop-runs` and `POST /loop-runs/:id/resume` return the same body. Resume also continues a `budget_paused` run in place; a run paused at its per-run soft cap answers `409` with `period: 'run'` (`resetsAt: null`) until the resume body carries the person's choice: `{ runCap: 'ignore' }` (continue without the cap) or `{ runCapUsd: n }` (raise it; it must end above what the run spent). `POST /loop-runs` also accepts `runCapUsd` (a number > 0 caps that run, `0` waives the default). When the project's `reviewWipLimit` is reached and the launch would open a new delivery, this route and `/relaunch` return `409 { error: 'review_wip_limit_reached', limit, pending: [{ deliveryId, railIndex, ticketIds, since }], detail, action }` and spawn nothing. Continuations of an existing delivery (`revisionOfDeliveryId`, Relaunch of a recorded delivery, `targetPrNumber`, `followUp`, or a rail that still owns an active delivery) are exempt.A repository that must be worktree-isolated (e.g. a multi-repository launch) but has no commits yet returns `409 { error: 'repository_has_no_commits', detail }` before any delivery row, branch or worktree exists; a single-repository launch without commits keeps the shared-checkout fallback (`isolationUnavailable: 'no-commits'`). |
| `POST` | `/:railIndex/stop` | Stop the rail's running job (cancels every job the rail registered) |
| `POST` | `/:railIndex/relaunch` | Relaunch a settled source. Body `{ sourceId: deliveryId or 'run:<runId>', originConversationId?, originSurface? }`. Uses its recorded specs and admitted options, restores empty assignments after preflight and atomically replaces an undelivered failed generation. Returns the same `202` launch response. Reused/removed rails, active/stale sources, missing specs/workflow and delivered work needing recovery return actionable errors. Request-side workflow overrides are ignored. |
| `GET` | `/pr-deliveries/:id/packet[?repositoryId=]` | The plain-language [review packet](review-packet.md) with the pre-resolved Accept ladder. 404 when `SPECRAILS_REVIEW_PACKET=false`. |
| `GET` | `/pr-deliveries/:id/changes[?repositoryId=&source=]` | Changes tab list (read-only). `{ prDeliveryId, repositoryId, changes }`; `changes` is `{ available: true, source, sources: [{ id: 'delivery' \| 'ticket:<id>', ticketId, branch }], base, head, baseSha, headSha, root, rootKind: 'worktree' \| 'repository', files: [{ path, oldPath, status: added\|modified\|deleted\|renamed\|copied\|typechange, additions, deletions, binary, hash }], truncated, totals, annotations }` or `{ available: false, reason: not_a_repository\|no_branch\|head_missing\|base_missing\|git_failed, sources, annotations }`. The comparison is the delivery head (settled sha, else the branch) against its merge-base with the base branch. `source` picks one unit's branch when there is no assembled branch (`400` on a malformed value). At most 2000 files (`truncated`). `hash` changes whenever the file's diff does (viewed-mark invalidation). `annotations` are reviewer findings (anchored when Core contract 5.9 named a location), review-brief risks and untested files, and follow-up comments; `location` is `null` when the source named no place. |
| `GET` | `/pr-deliveries/:id/changes/file?path=&full=1[&repositoryId=&source=]` | One file's parsed diff: `{ prDeliveryId, diff: { path, oldPath, status, binary, hunks: [{ header, oldStart, oldLines, newStart, newLines, lines: [{ type: context\|add\|delete, oldNo, newNo, text, noNewline? }] }], truncated, totalLines } }`. Capped at 4000 lines unless `full=1` (60,000). `path` must be a path of the listing (`404 file_not_in_changes`, `400` without it); it is never passed to git as a free pathspec. `409` with the unavailable `reason` when the comparison cannot be made. |

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
| `GET` | `/search?q=&lang=` | Search page titles and headings (levels 2–4) in one language, English fallback per page. `{ results: [{ category, categoryName, slug, title, heading, anchor }] }`, titles first, at most 8; `heading`/`anchor` are null on a title match, `anchor` is null for a heading without an explicit anchor. Empty `[]` for a query that is blank or longer than 80 chars |
| `GET` | `/:category/:slug` | Fetch one document (`{ title, content, category, slug }`) |

Headings may carry an explicit, locale-independent anchor, `## Title {#anchor}`. The server removes it from page titles; the client renders it as the heading id (`doc-<anchor>`) and never shows it. In-app "Learn more" hints address a section by `category/slug#anchor` (see [`client/src/features/README.md`](../../client/src/features/README.md#contextual-help-learn-more)).

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
| `daily_budget_exceeded` | project | Project budget hit; queue paused. Carries `period: 'week' \| 'month'` for the weekly / monthly cap (absent = daily) |
| `desktop_daily_budget_exceeded` | app | App-wide budget hit (same optional `period`) |
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

### Setup (API / MCP install flow)

Emitted by the legacy per-project `/setup/*` install flow (MCP `specrails_setup`). Background workspace assembly after `POST /api/projects` reports through the app-level `project.assemble_progress` event instead.

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

- **Surface drift**: this file is hand-maintained against the route declarations in `server/*-router.ts`, the per-domain `server/project-router-{jobs,spending,settings,terminals,tickets,chat,setup}.ts` family, `server/modules/code/runtime/code-explorer-router.ts`, and `server/jira-router.ts`. The app adds endpoints regularly; if a route exists in code but not here, please open an issue.
- **Stability**: routes under `/api/*` and `/api/projects/:projectId/*` are considered stable. A few legacy setup endpoints (`setup/start`, `setup/message`, `enrich/*`) back a flow the UI does not expose and remain only for forward compatibility.
