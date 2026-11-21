# API reference

REST and WebSocket endpoints exposed by the app server. The server binds to `127.0.0.1` only (loopback); the default port is `4200` but it can be overridden with `--port <n>` on the server command line.

> **New here?** This page is the contract the desktop UI, the CLI, and the mobile gateway all speak to the local server. **You normally never call these endpoints directly — the app does it for you.** Read on only if you are scripting against the server, writing an integration, or debugging. Everything is local-only: there is no cloud API.

The app registers four AI provider CLIs — **Claude, Codex, Gemini, and Kimi**
— all enabled by default. Endpoints that accept `provider` / `aiEngine` take
`claude`, `codex`, `gemini`, or `kimi`, validate project membership, then
enforce the requested surface's adapter capabilities. See the
[Kimi adapter](../../server/providers/kimi-adapter.ts) for its exact matrix.

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
| `POST` | `/repositories/clone` | Clone a GitHub repository. Body `{ url, destination }`; `201 { path }`. Accepts GitHub HTTPS/SSH URLs or `owner/repo`, without embedded credentials. Destination must be a new absolute folder under an existing parent. `400` invalid input, `409 clone_destination_exists`, `502 clone_failed`. Uses local Git credentials non-interactively, times out after five minutes, aborts on client disconnect, and removes its own failed checkout. A successful clone is retained; registration via project/repository routes is a separate step. |
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
| `GET` | `/available-providers` | Provider catalogue used by the Add Project dialog (no-provider warning), mission and provider pickers. Registry-driven map (`{ claude, codex, gemini, kimi, tiers, providerIssues, launchDescriptors }`) reporting which CLIs are usable. Codex/Gemini are surfaced unless forced off by `SPECRAILS_CODEX_BETA=0` / `SPECRAILS_GEMINI_BETA=0` (both enabled by default). Kimi is reported unavailable, with a machine-readable `providerIssues.kimi`, when the CLI is missing/unusable, is older than 0.27.0, or the installed Core lacks the Kimi target. The bounded readiness probe is intentionally non-billing and cannot prove account authentication; a login/configuration problem is surfaced by the first model turn. `launchDescriptors` exposes each external CLI command; the app does not bundle a Kimi daemon/server. The PATH and Kimi probes run as async child processes, are shared by concurrent requests and are reused for 60 s or until the next detection cycle (`GET /providers/detected?refresh=1`); local-engine availability answers from the last detection snapshot and refreshes it in the background |
| `GET` | `/meta` | Versions a client negotiates with: `{ apiVersion, appVersion, coreVersion, contractSchemaVersion, channel, updateManifestUrl }`. `coreVersion` is the Core in use (active framework, else the located contract's Core, else the bundled one); `contractSchemaVersion` is the integration contract's `schemaVersion`; unknown values are `null`. `channel` is the update channel (`latest` or `stable`) and `updateManifestUrl` the Tauri updater manifest it reads |
| `GET` | `/core-compat` | specrails-core version compatibility probe |
| `GET` | `/core-update/status` | Core update status without network access. Includes `channel`, `resolvedDistTag` (`latest`/`stable`/`null`) and `channelFallback` (`true` when `stable` was requested but Core has no `stable` dist-tag, so `latest` was used). A version cached for another channel is never offered |
| `POST` | `/core-update/check` | Resolve the channel's npm dist-tag (`stable` → `stable`, falling back to `latest` only on a 404 for the tag) and return the refreshed status |
| `POST` | `/core-update/update` | Install the checked version (or `{ version }`). `202`; progress over the `core_update.progress` WebSocket event |
| `GET` | `/setup-prerequisites` | Tool checks (`node`/`npm`/`npx`/`git`, optionally `uv`). Add `?diagnostic=1` to nest a `diagnostic` object: `{ pathSegments, pathSources, loginShellStatus, whichResults, nodeEnv, platform }` |

### Settings, budget, theme

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/settings` | App-wide settings, including `allowSubagents` (default `true`), `autoContinueRuns` (default `true`: [automatic continuation](#failure-diagnosis)), `subagentRuntime` (default `null`), `updateChannel` (`latest` default, or `stable`), the running `version` (`unknown` when unreadable), `runningPort` (the port this instance listens on; `port` is the persisted setting) and `databasePath` (this instance's desktop database, home shortened to `~`; Settings ▸ About shows both) |
| `PUT` | `/settings` | Update any subset of `{ port?, specrailsTechUrl?, costAlertThresholdUsd?, allowSubagents?, autoContinueRuns?, subagentRuntime?, updateChannel? }`; `autoContinueRuns` must be a boolean. `updateChannel` must be `latest` or `stable` (otherwise `400` and nothing is written); it selects the Desktop updater manifest and the Core npm dist-tag. `subagentRuntime` is `null` (same as the mission agent) or `{ provider, model, effort: string \| null }` for missions without a project; an invalid value returns `400`. `allowSubagents` is the app-wide "Allow sub-agents" setting for missions without a project. It must be a boolean (otherwise `400` and nothing is written), and a change refreshes the policy of open sessions |
| `GET` | `/machine-installs` | Remembered machine-wide install approvals: `{ approvals: [{ command, manager, tool, approvedAt, lastUsedAt, uses }] }` ([machine-installs](../../server/modules/machine-installs/README.md)). A run that needs one of these exact commands installs it without asking |
| `DELETE` | `/machine-installs` | `{ command }` revokes one approval (`404` when none, `400` without a command); returns the remaining `approvals`. The next run that needs it asks again |
| `GET` | `/mission-connectors` | Connectors in missions: `{ detectedAt, claudeAccountListStale, measuring, providers: [{ provider, detected, connectors: [{ name, kind: 'account-connector' \| 'mcp-server', enabled, lock?, status?, transport?, size? }], userServersNeedToolSearch? }] }` for `claude`, `codex`, `gemini`, `kimi`. Cached for 10 minutes; `?refresh=1` re-detects (runs `claude mcp list`, 30 s timeout). `lock` is `specrails-duplicate`, `disabled-in-provider`, `external-mcp` or `unsupported` |
| `PATCH` | `/mission-connectors` | One toggle `{ provider, name, enabled: boolean }` into the app-wide deny-list; returns the view. `400` with `unknown_provider`, `invalid_name`, `invalid_enabled` or `invalid_body`. Applies on the next mission turn |
| `POST` | `/mission-connectors/measure` | Starts each stdio user server once (`initialize` + `tools/list`) and stores `size: { tools, tokens, measuredAt }`; returns the view |
| `GET` | `/budget` | App-wide budget config |
| `PATCH` | `/budget` | Update the app-wide budgets: `{ desktopDailyBudgetUsd?, desktopWeeklyBudgetUsd?, desktopMonthlyBudgetUsd?, runCapUsd?, costAlertThresholdUsd? }` (`null` clears, a number > 0 sets; a bad weekly / monthly / run value is `400 { error: 'invalid_cap', field }`). `GET /budget` reports the same fields |
| `GET` | `/budget/caps` | Budget panel read model, app-wide: `{ generatedAt, spend: { day, week, month }, projection, config, caps }`. `spend.<period>` is `{ startsAt, resetsAt, usd, estimatedUsd, byProvider: [{ provider, usd, estimatedUsd, invocations, turns }] }` over the LOCAL period (week starts Monday); `projection` is `{ estimate: true, trailingDays, avgDailyUsd, monthToDateUsd, remainingDays, projectedUsd }` or `null` without a completed day of history; `config` is `{ day, week, month, run }`; `caps` lists the configured app-wide caps `{ scope, period, budgetUsd, spentUsd, exhausted, resetsAt }`. App-wide spend is every project's ledger plus every app-ledger turn (missions, Intent, Home and Blueprint chats), the same sum the app-wide caps enforce |
| `GET` | `/theme` | Current UI theme (defaults to `specrails`) |
| `PATCH` | `/theme` | Set UI theme. Body `{ theme }`; one of `dracula`, `aurora-light`, `obsidian-dark`, `matrix`, `specrails`. 400 on an unknown value |
| `GET` | `/language` | Current UI language; `{ language: null }` when the user never chose one (the client then follows the OS language) |
| `PATCH` | `/language` | Set UI language. Body `{ language }`; one of `en`, `es`, `fr`, `de`, `pt`, `it`, `zh`, `ja`. 400 on an unknown value |
| `GET` | `/code-explorer-settings` | `{ language, monthlyBudgetUsd }` (summary language `en`/`es`, default budget $5) |
| `PATCH` | `/code-explorer-settings` | Update `{ language?, monthlyBudgetUsd? }` |
| `GET` | `/terminal-settings` | App-wide terminal panel defaults |
| `PATCH` | `/terminal-settings` | Update app-wide terminal defaults |
| `GET` | `/attention-prefs` | Attention notifications (Settings ▸ Notifications): `{ enabled, categories: { question, review, failed, budget, done }, sound, dockBadge, mutedProjects: string[] }`. Defaults: everything on, `sound: false`, `dockBadge: true`, nothing muted. Stored as JSON under `desktop_settings` key `attention_notifications`; a corrupt row falls back to the defaults field by field |
| `PATCH` | `/attention-prefs` | Partial update: any of `enabled`, `sound`, `dockBadge` (booleans), `categories` (merged per category, booleans), `mutedProjects` (replaces the list; unique non-empty ids ≤ 200 chars, at most 500). Returns the whole record and broadcasts it as WS `desktop.attention_prefs` `{ prefs, timestamp }` so every window applies it. An unknown field or a wrong type is `400 { error: 'validation_failed', field, message }` and nothing is written |

### Analytics (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/analytics?period=&from=&to=` | Cross-project aggregated spending (the Desktop Analytics page; supports a custom `from`/`to` range): `{ period, kpi, projectBreakdown, costTimeline, byCategory }`. App-ledger turns (missions, Intent, Home and Blueprint chats) count in every figure — cost, estimated part, priced/unpriced counts, timeline and the five-category `byCategory` split. A turn pinned to a loaded project adds to that project's row (`agentTurns`); the rest form one `kind: 'app'` row with id `app:home-blueprint`. Job counts stay job-only |
| `GET` | `/recent-jobs?limit=` | Recent jobs across all projects (1–50) |

### Failure diagnosis

A run that ended `failed`, `blocked` or `stalled` carries one typed record explaining why. It is persisted in `loop_runs.failure_diagnosis` when the run settles (migration 84) and served read-only by:

- `GET /api/projects/:projectId/jobs/:id` as `job.failureDiagnosis`;
- `GET /api/projects/:projectId/loop-runs/:id` as `loopRun.failureDiagnosis` (a delivery card reads its last run's);
- `GET /api/inbox` as `diagnosis` on failed / blocked items.

Shape: `{ kind, confidence, phase, rounds, resetAt, resetsAt?, detail, resumablePhase, blocker, incompleteTasks?, role?, provider?, model?, missingSteps?, strongerModel?, source, remedies }`. `resetsAt` (only on `provider_limit`) is the ISO instant the refusing window resets when Core reported a typed usage-limit refusal (contract 5.14); `resetAt` stays the provider's own words.
`kind` is `tests_failed`, `provider_limit`, `environment`, `port_in_use`, `blocked`, `timeout`, `tool_inactivity`, `crash`, `incomplete_tasks` (approved tasks left unticked; `incompleteTasks` lists at most 20), `spec_invalid`, `workflow_protocol` (a role's model ended its turn, and Core's one corrective turn, without the required OpenSpec steps: `role`, `provider`, `model` and `missingSteps` from Core contract 5.16, or `role` and `missingSteps` read from an older Core's fixed sentence; remedies `resume`, `retry`, `open-logs`; `strongerModel` `{provider, model, label}` is the provider's default model when its catalog marks the model that ran `small`, otherwise null) or `unknown`; `confidence` is `high` or `low` (a low-confidence record is always `unknown`); `source` is `core` (the classification of Core contract 5.8) or `desktop` (derived from the loop's stall reason, the provider-limit signal, Core's fixed blocker sentences, `completion.blocker` or the Implement recipe's own end reasons in `completion.reasons`; a low-confidence Core record never hides one of those); `remedies` are ranked ids from `resume`, `retry`, `edit-spec`, `fix-environment`, `open-logs`, `continue-to-review`, `retry-with-browser`. A run finished before the column existed reads as `unknown`/low, and a successful run has none. Module: [`server/modules/recovery`](../../server/modules/recovery/README.md).

`POST /api/projects/:projectId/loop-runs/:id/remedy` body `{ remedy: 'continue' | 'continue-to-review' }` (`'retry-with-browser'` is accepted as `continue`) continues a failed, stopped or paused definition run and keeps its work. `continue`: a paused run resumes in place; unfinished tasks fork at the last `developer` visit with fresh `implementationAttempts`/`unblockAttempts`; a spent implementation-attempt budget forks at `developer` the same way; a spent correction budget forks at `correction-budget` with `correctionAttempts: 0`; a correction stall (the fixer changed nothing, typically a failure it could not reproduce) forks at the latest `verify` visit with `correctionAttempts: 0`, so the same candidate is verified again (a pass goes on to review, a failure back to the fixer with the flaky-test guidance). The stall is read from the end node the diagnosis names, Core's summary ("Automatic correction changed nothing." / "Automatic corrections ran out.") or the end reason in `completion.reasons`. Anything else (a stop, a crash, a host blocker) forks at the latest visit of the step that failed or stopped (the diagnosis' step, else the interrupted write, else the first unfinished root step; a run that ended cleanly at a failure `end` goes on from the one work step that end reports through conditions and assigns, else `developer`, else the last work step it ran), in the same worktree; only a ledger with no step at all answers `remedy_not_applicable`. The cause's guidance is queued as an operator instruction on the target run before it resumes (unfinished tasks: the exact tasks with `$SPECRAILS_BROWSE` and the install rule; `environment`: what was missing and how to install it; a taken port: use `$PORT`; a stall: change approach; a crash, timeout or usage limit: nothing). `continue-to-review` turns the unticked tasks into human checks (the `[human]` tag on a Core advertising `humanTasks`, otherwise ticked, both listed in `$vars.humanChecks`) and forks at the last `unblock-tasks`/`tasks` visit. Fork request ids are derived from the run, so a retried click forks once. Each continuation is recorded in `run_continuations` (migration 96: `run_id`, `source_run_id`, `remedy`, `mode`, `from_step`, `cause`, `guidance`, `automatic`). `201`/`202 { loopRunId, remedy, mode: 'fork' | 'resume', fromStep, resumed, guided? }`; `400 invalid_remedy`; `409 runtime_fork_owns_worktree { loopRunId }` (a later attempt already took over), `remedy_not_applicable`, `runtime_run_active`, a daily-budget rejection or `runtime_fork_rejected`; `503 runtime_status_unavailable`. `copy-env-files` (offered first on an `environment` diagnosis that names a missing `.env` / `APP_KEY` while the project setting `worktreeEnvFiles` is off) turns that setting on, copies the project's gitignored env files into the run's worktree(s) (one per repository, matched by Git common directory) and then continues exactly like `continue`, its guidance naming the copied paths (never values): same responses plus `envFilesEnabled: true, envFilesCopied: string[]`; `409 env_files_unavailable` (no project repository has an env file; nothing changed).

A remedy body may instead pick a resolution: `{ optionId }` continues with one option of the run's stored AI analysis (its kind and guidance are read from `job_failure_analyses`, never from the request; `continue-with-guidance` and `mark-human-check` continue with the option's guidance, `continue-to-review` runs that remedy), or `{ instruction }` (1-4000 characters) continues with the person's own words. Both add the guidance after the cause's; a picked resolution replaces the analysis' steps. Responses as above plus `option` (the label); `400 invalid_resolution | invalid_option | invalid_instruction | option_runs_on_client` (`edit-spec`, `change-model`, `start-over` run on the client), `404 option_not_found`. When the run's latest verification shows flaky tests (see `readVerificationTests`), Continue's guidance names them and asks for deterministic tests, not longer timeouts. `GET /loop-runs/:id/attempts` adds `resolution: { attempts, costUsd, costEstimated, repeated, times } | null`: the chain's spend up to this run and whether it keeps stopping for the same cause (two consecutive attempts with the same kind and failing checks, or three budget stops in a row at one step); automatic continuation refuses a repeat.

A run that settled on a provider's usage limit continues on another provider with `{ remedy: 'continue', switch: { provider, model?, effort?, remember? } }` (optionally with an `optionId` of kind `change-model`, whose label and guidance go with it): the choice is checked against the run's `providerSwitch` offer and the provider catalogs (`409 switch_unavailable` without an offer, `409 shares_quota` for the limited provider or one sharing its quota, `400 invalid_provider | invalid_model | invalid_effort | invalid_switch`). The next attempt forks from the same step as Continue (its own fork request) with the offer's roles moved (Core `forkRouteOverrides`; a retained Core with only `routeOverrides` moves them on the fork's first resume), `remember` also saves the routes as the project's role routes, and the response adds `provider`, `model`, `effort`.

`GET /api/projects/:projectId/loop-runs/:id/attempts` → `{ chain, continuable, resolution, providerSwitch }`. `chain` is null for a run without lineage, else `{ runId, attempt, attempts: [{ runId, attempt, status, outcome, startedAt, finishedAt, fromStep, continuations, costUsd, costEstimated }] }`, oldest first (attempts number from 1 in start order along `loop_runs.fork_of`). `continuable`: a settled (not successful) or paused definition run that no adopted fork took over. `providerSwitch` (null otherwise): a continuable run that settled on a usage limit (diagnosis `provider_limit`, a refusal line naming the CLI in its detail or log tail, or an AI analysis of category `provider_limit`) whose retained Core can move routes, as `{ providerId, roles, targets: [{ provider, model, effort }], via: 'fork' | 'resume' }` (the pause switch's targets: never the limited provider, one sharing its quota or one refusing too).

**Attempt chains.** Runs continued from one another are one unit. An attempt with an adopted fork (`definition_fork_operations.adopted = 1`) is *superseded*: the inbox, the live board and `GET /jobs` (and so the command palette's recents) never list it on its own; the chain speaks through its latest attempt, which carries `attempt: { number, of }` (`GET /jobs` rows also `firstRunId`; `GET /jobs?attempts=all` lists superseded attempts too). One SQL rule serves every surface: `supersededAttemptSql` in [`run-attempts.ts`](../../server/modules/loops/runtime/run-attempts.ts).

**Automatic continuation.** When a definition run completes `failed`, `blocked` or `stalled` with a high-confidence cause more work can fix (unfinished tasks, an `environment` blocker of kind `toolchain` or `setup`, `crash`/`timeout`/`tool_inactivity`, a stall), Desktop continues it once, like the person's Continue, records the continuation as `automatic` and appends *Specrails continued automatically: …* to the run's log. Never for a usage limit, `spec_invalid`, a credential, secret, policy, budget or quota wording, a person's stop, `max-cost`/`max-iterations`, an unknown cause, a failure identical to the attempt it continued, or a second time in the same chain. App setting `autoContinueRuns` (`GET/PUT /api/settings`, default `true`). Rules: `autoContinueVerdict` in [`recovery/continuation.ts`](../../server/modules/recovery/continuation.ts); coordinator: [`project-context-auto-continue.ts`](../../server/project-context-auto-continue.ts).

### Provider quota and launch preflight (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/provider-quota` | The machine's provider quota, never probes: `{ providers: [{ providerId, level, usedPercent, windowId, rejectedUntil, rejectedIndefinitely, windows: [{ id, usedPercent, resetsAt, windowMinutes, observedAt, source }], observedAt }] }`. `level`: `unknown` \| `ok` \| `warning` (≥80 %) \| `critical` (≥90 %) \| `rejected`; `rejectedUntil` is when every refusing window has reset. Built from Core session `provider.rate-limit` events, Core runtime `agent-event` kind `rate-limit`, Desktop's own Claude `rate_limit_event` frames, prose refusals and the subscription reader. Changes are pushed as the app-level WS message `provider_quota.updated` `{ providers, timestamp }`; a run-observed window also updates the subscription rows and pushes `subscription_usage.updated` `{ snapshot }`. Module: [`server/modules/provider-quota`](../../server/modules/provider-quota/README.md). |
| `GET` | `/launch-preflight?projectId=&providers=[&fresh=1]` | The "Launch all" checks, in parallel and bounded: `{ chips, blocking, checkedAt }`. Chips: `{ id: 'disk', kind: 'disk', state, freeBytes }` (fail < 1 GiB, warn < 5 GiB at the project's worktrees), `{ id: 'provider:<id>', kind: 'provider', state, providerId, status }` (`claude auth status` / `codex login status` exit code: `signed-in` \| `signed-out` \| `missing` \| `unknown`), `{ id: 'github', kind: 'github', state, status }` (`gh auth status`) and `{ id: 'quota:<id>', kind: 'quota', state, providerId, level, usedPercent, rejectedUntil }`. `state`: `ok` \| `warn` \| `fail` \| `unknown`; a `fail` chip sets `blocking`. `providers` lists each rail's engine (empty = the project's primary). Sign-in is cached for a minute (`fresh=1` re-checks). Module: [`server/modules/launch-preflight`](../../server/modules/launch-preflight/README.md). |

### Runs paused at a usage limit

A loop run (legacy steps or a Core workflow) refused on the provider's usage limit pauses instead of failing: `loop_runs.status = 'paused'`, `restart_reason = 'limit_paused'`, and a `queue_state` record `limit_pause:<runId>` `{ providerId, resumeAt, autoResume, message, pausedAt, switchable }` that survives a restart (a Core run is then retained paused and resumed at `resumeAt` through the retained-run path). It resumes by itself at `resumeAt` when `autoResume` (default on; never during sleep or a dark wake), and retries the refused step. At most three limit pauses per run, then it settles `stalled` / `provider_limit` as before.

- `GET /api/projects/:projectId/jobs/:id` adds `loopPauseKind: 'limit_paused'` and `loopPauseLimit`; `GET /api/projects/:projectId/loop-runs/:id` adds `loopRun.limitPause`.
- A loop run's job also carries `heldMs`: the time it spent held (a question, an approval, a restart, a limit or the budget), summed at each resume from its last recorded event (`loop_runs.held_ms`, migration 97). The run window's elapsed time leaves it out.

**Held runs.** A loop run that stopped without settling keeps `jobs.status = 'running'` (it still owns its tickets and worktree). `GET /jobs` and `GET /jobs/:id` add `hold: { kind, step, since, resumeAt? }` to such a job: `kind` is `restart` (the app restarted while it worked, also reported from the first request after boot, before startup recovery reconciled the row), `interrupted`, `provider_limit`, `budget`, `question`, `approval` or `paused`; `step` is the workflow step that was working (`developer`) and `since` when it stopped (its last recorded event). A job without `hold` genuinely works. Clients show the job through its hold and never as running.
- `POST /api/projects/:projectId/loop-runs/:id/limit` body `{ action: 'resume' }` (202), `{ action: 'auto', enabled }` (200 `{ limit }`) or `{ action: 'switch', provider }` (202, legacy loop steps; 409 `shares_quota` for a provider sharing the quota, `switch_unavailable` when the run offers no switch). A Core run whose pause carries `switchRoles`/`switchTargets` (retained Core with `routeOverrides`) takes `{ action: 'switch', provider, model?, effort?, remember? }`: 202 `{ loopRunId, provider, model, effort }`; 400 `invalid_provider` (not offered/installed), `invalid_model`, `invalid_effort`, `invalid_remember`; 409 `shares_quota`, `provider_limited` (the target is refusing too), `switch_unavailable`. `POST …/resume` resumes a live limit pause too.
- `POST /api/projects/:projectId/loop-runs/:id/pause` — the person's Pause of a running Core definition run: Core finishes the step in progress and parks at the next step boundary (no step is interrupted); the run then holds as `hold: { kind: 'paused', byYou: true }` (`loopPauseKind: 'user_paused'`), gives its capacity slot back and never resumes by itself, a restart included. `202 { loopRunId, pausing: true, requestId }`; `200 { paused: true }` when already paused; `409` `pause_unsupported` (legacy engine or a retained Core without `pauseRuns`), `pause_held`, `pause_not_running`, `pause_not_ready`, `pause_rejected`. `POST …/resume` continues it in place (the same attempt, no fork). `GET /jobs/:id` adds `pauseControl: 'pause' | 'pausing' | 'resume'` while the run offers it. WS: `loop.pause_requested` / `loop.pause_request_ended` `{ loopRunId }`, then `loop.run_paused` with `pauseKind: 'user_paused'`.
- WS: `loop.run_paused` with `pauseKind: 'limit_paused'` and `limit`; `loop.limit_pause` `{ loopRunId, limit }` when the automatic resume is toggled; `loop.provider_limit` adds `resumeAt` when known.
- The inbox lists the run as `kind: 'budget'`, `action: 'resume-run'`, `detail: 'usage_limit:<provider>:<resumeAt or empty>'`.

### Failure analysis

The AI reading of why a failed job stopped, shown under the diagnosis in **Failure reasons**. It complements the diagnosis and never changes it.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/projects/:projectId/jobs/:id/failure-analysis?language=es` | The saved analysis for that language: `{ status: 'ready', analysis, provider, model, createdAt, stale }`, else `{ status: 'none' }`. `404` unless the job `failed` or was `canceled`. |
| `POST` | `/api/projects/:projectId/jobs/:id/failure-analysis` | Body `{ language, force? }`. Returns the saved analysis while the log, language and prompt version are unchanged (`force` asks again); otherwise one call runs, deduped per job. `422 no_log`; `502 { error: 'analysis_failed', detail }` carries the provider's own error. |

The call reads the last 400 log lines (24k characters) plus the job metadata and diagnosis, on the provider **and model that ran the job** (a loop run's `loop_runs.provider/model`), one turn and no tools. `analysis` is `{ headline, cause, category, failedStep, evidence, nextSteps, nextStepActions? }`; `nextStepActions` is aligned with `nextSteps` and names the remedy a step maps to (`{ kind: 'continue' | 'continue-to-review' | 'edit-spec' | 'change-model', step?, role? }`) or `null` for plain advice (prompt version 3). Prompt version 4 adds `options` (2-4): `{ id, kind, label, does, consequence, risk?: 'low' | 'medium' | 'high', recommended?, guidance }` with `kind` one of `continue-with-guidance`, `continue-to-review`, `mark-human-check`, `edit-spec`, `change-model`, `start-over`, limited to the kinds the run can execute; the evidence then carries `context` (`failingTests`, `flakyTests`, `attempts`, `optionKinds`). Analyses saved before version 4 have no options. `category` is `provider_limit`, `missing_artifact`, `configuration`, `tests`, `environment`, `agent_error`, `interrupted`, `incomplete_tasks` or `other`, and `evidence` keeps only lines that appear verbatim in the log. Saved in `job_failure_analyses` (migration 93). Each call is recorded in `ai_invocations` with surface `failure-analysis` and `surface_ref_id` = the job, so it shows in Analytics.

### Needs-you inbox (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/inbox` | Read-only projection of what waits for the person, across every registered project: `{ items, projects, generatedAt }`. Each item: `id` (`<projectId>:<kind>:<sourceId>`), `projectId`, `projectName`, `kind` (`review` \| `question` \| `failed` \| `blocked` \| `budget` \| `jira`), `title`, `detail`, `at`, `version` (changes when the state changes), `action` (`open-review` \| `open-run` \| `resume-run` \| `retry-jira` \| `raise-cap`), `subjectId` (delivery id, loop-run id, Jira outbox id, or `<scope>:<period>` for a cap), `conversationId`, `diagnosis` (a failed / blocked run's [failure diagnosis](#failure-diagnosis), else `null`; a provider limit or environment problem is listed as `blocked`), and — only on a reached spend cap (`kind: 'budget'`, `action: 'raise-cap'`, id `<projectId>:budget:cap-<scope>-<period>`) — `cap: { scope, period, budgetUsd, spentUsd, resetsAt }`. A delivery or run item also carries `railIndex` (when known) and a delivery item its `decision` (the state a remote PR decision must echo back). An app-wide cap is listed once, under the first project. Newest first, at most 50 per project. Each project is read through its own database and a failing project is skipped; nothing is cached or stored. Snooze, Done and the unseen marks are per viewer and never reach the server. Module: [`server/modules/inbox`](../../server/modules/inbox/README.md). |

### Live board (app-wide)

| Method | Path | Description |
|---|---|---|
| `GET` | `/live-board` | Read-only projection of every run across every registered project: `{ generatedAt, day: { from, to }, projects: [{ projectId, projectName, count }], cards, lanes, totals }`. A card: `id` (`<projectId>:<source>:<sourceId>`, or the inbox item id for an inbox item that is not a run), `projectId`, `projectName`, `kind` (`rail` \| `loop` \| `intent` \| `job`, `null` for a Jira update or a spend cap), `status` (the domain status, mapped by the client to its run-state vocabulary: `{ source: 'job', status }`, `{ source: 'loop-run', status, outcome, restartReason }`, `{ source: 'delivery', decision, statusCode, paused?, queued? }` (`queued: { waitingFor, position }` while the run waits for capacity), `{ source: 'intent', state }` or `{ source: 'attention' }`), `column` (`needs` \| `working` \| `done`; `needs` holds every inbox item, reviews included), `urgency` (0–2), `at`, `title`, `phase` (current step or phase id), `question`, `steps` (`{ done, total }` or `null`), `provider`, `model`, `startedAt`, `finishedAt`, `costUsd` (an attempt chain's card: every attempt added up, as analytics counts it), `costEstimated` (at least part is a rate-card estimate), `costEstimatedUsd` (that estimated part, `null` when none), `costTodayUsd` (a chain's: every attempt's spend today, counted once), `attempt` (a continued run: `{ number, of, costUsd, costEstimated }`, the latest attempt's place and its own cost), `railIndex`, `ticketIds`, `conversationId` (the mission that launched it), `jobId` (the run detail it opens), `deliveryId`, `attention` (the [inbox](#needs-you-inbox-app-wide) item that speaks for it, unchanged, else `null`) and, on a delivery card, `mergePreview` (`{ status, conflictFileCount, siblingConflictCount, baseAdvancedBy }`, the delivery's last [merge preview](#apiprojectsprojectidrails), or `null` before one was computed; a throttled background refresh announces changes with `rail.merge_preview`). Cards come ordered by column, then by each column's order (needs you oldest first; in progress running then queued, oldest first; done most recent first). `lanes`: one per mission, `{ conversationId, title, provider, projectIds, cardIds, todayCostUsd, urgency }`, most urgent first, the lane without a mission (`conversationId: null`) last. `totals`: `{ needsYou, inProgress, doneToday, costTodayUsd, costTodayEstimated }` (each the count of its column; paused runs count in `inProgress`) (today's spend is the `/api/state` figure). The inbox items are the `/api/inbox` projection itself, so both agree; "Done today" is the local day. Each project is read through its own database, a failing project is skipped, at most 120 cards per project; nothing is cached or stored (the merge preview is the delivery capability's own last result). Module: [`server/modules/live-board`](../../server/modules/live-board/README.md). |
| `GET` | `/capacity` | The machine's run admission ([capacity module](../../server/modules/capacity/README.md)): `{ enabled, limits: { maxRuns, maxRunsPerProject, perProvider, cpuBusyLimit, minAvailableMemoryMb, quotaReservePercent }, active: [{ runId, projectId, provider, since }], queued: [{ runId, projectId, provider, waitingFor, since, position }], perRunPercent: { <provider>: number \| null } }`; `{ enabled: false }` with `SPECRAILS_RUN_ADMISSION=off`. A queued run's job carries `hold: { kind: 'queued', waitingFor, position }` and `loop.run_queued` announces it (`loop.run_resumed` when it starts). |

### Restart continuity (app-wide)

| Method | Path | Description |
|---|---|---|
| `GET` | `/continuity/resume-offers` | `{ offers, runs, bootedAt }`. `offers`: mission turns a previous process left interrupted and that still apply, `{ conversationId, title, startedAt, stoppedAt, provider, sessionId, trigger }` (`trigger`: `quit` \| `update` \| `crash`). `runs`: `{ projectId, runId }` of the loop runs a graceful restart interrupted. Nothing is resumed by this API. Module: [`server/modules/continuity`](../../server/modules/continuity/README.md). |
| `POST` | `/continuity/resume-offers/settle` | `{ conversationIds: string[], runs?: true }` — the person resumed or dismissed these offers (and decided about the runs). `{ settled }`. 400 on a malformed body. |
| `POST` | `/continuity/shutdown-intent` | `{ trigger: 'update' }`, sent right before an update restart so interrupted turns are offered back as `update`. |
| `GET` | `/continuity/active-work` | `{ missions, runs, total }`: mission turns in flight (plus Core sessions with live sub-agents) and running jobs/loop runs across projects. Used by the update card's "Install when nothing is running". |

### Resources (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/resources` | Read-only CPU/memory of everything the server launched, from one process-table read (cached 500 ms): `{ measuredAt, supported, totals: { cpuPercent, memoryBytes, processCount }, categories, history }`. `categories` (non-empty ones only, in this order): `missions` (agent sessions of desktop missions and project chats), `rails` (loop/rail runs, labelled `Rail N · <loop> · #ticket`, including a Core definition run's runtime process and its provider CLIs, and queued jobs labelled with their command), `background`, `terminals`, then the server's remaining children by command line: `agent-cli` (claude/codex/gemini/kimi without a known owner), `mcp` (MCP bridge, local runner, MCP servers), `git`, `other`, and `server` (the server process itself). Each is `{ id, cpuPercent, memoryBytes, processCount, items: [{ label, projectId?, projectName?, chatId?, runId?, cpuPercent, memoryBytes, processCount }] }`; every process is counted once, under the first owner that reaches it. `history` holds up to 100 totals points kept in memory only while a client polls (reset after 30 s without requests). `supported: false` when the process table cannot be read. Shown by the status-bar Resources control; see [terminals › App resources](../../server/modules/terminals/README.md#app-resources). |
| `GET` | `/resources/ports` | Listening TCP ports of run worktrees, read on demand (`lsof` on macOS, `/proc` on Linux; cached 3 s, rescanned after a background process announces a URL): `{ supported, scannedAt, ports, leases }`. Each port is `{ port, host, pid, command, cwd, confidence, squatting, worktreePath, assigned: { start, end } \| null, run }` where `confidence` is `cwd` (the process works in the worktree), `command` (it or an ancestor names the worktree) or `none`, and `squatting` marks a foreign process inside a run's leased block. `run` is `{ projectId, projectName, railIndex, ticketId, branch, runId }` from the rail ledger, or null. Only run-owned or squatting listeners are listed. `leases` are the live blocks `{ worktreePath, start, end, run }`. `supported: false` on Windows. See [terminals › Run worktree ports](../../server/modules/terminals/README.md#run-worktree-ports). |

### Retained run worktrees (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/worktrees/retained` | Run worktrees kept on disk across every project: rail ledger rows in `needs-review`, or any terminal row whose mount survived, plus Intent sessions in `needs-review` (listed only). Rows sharing a mount collapse to the newest; a mount any row is still building in is left out. `{ generatedAt, projects: [{ projectId, projectName, error? }], items }`. Each item: `{ id, kind: 'rail' \| 'intent', projectId, projectName, railIndex, ticketId, ticketTitle, runId, branch, worktreePath, state, pr: { url, number, decision, deliveryState } \| null, lastActivityAt, idleDays, head, trackedChanges, untrackedFiles, ignoredAtRisk (first 20), ignoredAtRiskCount, unpushedCommits, evaluation: { label: 'nothing-to-lose' \| 'waiting-for-you', reasons, removable, removeBlocker, branchDeletable } }`. A `null` count means Git could not read it, and that is never treated as clean. Git reads are bounded at 4 worktrees in flight per project. |
| `POST` | `/worktrees/retained/sizes` | Body `{ items: [{ projectId, id }] }` (≤ 200). Returns `{ items: [{ projectId, id, size }] }` where `size` is `{ status: 'scanning' }`, `{ status: 'done', bytes, scannedAt }`, `{ status: 'failed', scannedAt }`, or `null` for an unknown item. Paths are resolved server-side. The first call queues a `du -sk` (an async walk on Windows), with 2 scans in flight at most, and results are reused for 10 min. |
| `POST` | `/worktrees/retained/remove` | Body `{ items: [{ projectId, id, head, deleteBranch }] }` (≤ 100; `head` is the 40/64-hex HEAD the person confirmed, otherwise `400`). Runs one item at a time, each under its repository lock. The server gathers the evidence again and keeps the worktree when it is no longer removable, or `changed` when HEAD moved. The release path (`releaseRailWorktrees` with `acceptIgnoredBaseCopies` and `reclaimTerminalMounts`) then re-proves cleanliness and HEAD/ref, quarantines authorized overlay or ignored paths, stops leftover processes and runs Git's non-force removal. The branch is kept unless `deleteBranch` and the evaluation says `branchDeletable`, and is then deleted with `update-ref -d refs/heads/<b> <checked sha>`, only when no other checkout uses it. `{ results: [{ projectId, id, status: 'removed' \| 'kept' \| 'not-found', reason, branchDeleted, warnings }] }`. See [safe PR flow › Retained run worktrees](safe-pr-review-flow.md#retained-run-worktrees). |
| `GET` | `/worktrees/quarantines` | Safety archives (`<worktree>.specrails-overlay-quarantine-XXXXXX`) beneath each project's worktrees root (`~/.specrails/projects/<slug>/worktrees`, up to three levels deep). `{ generatedAt, projects: [{ projectId, projectName, error? }], items: [{ projectId, projectName, path, worktreeName, createdAt, fileCount, bytes, files: [{ path, kind: 'file' \| 'link' \| 'other', bytes }] (first 200), truncated }] }`, newest first. Links are listed, never followed. |
| `POST` | `/worktrees/quarantines/inspect` | Body `{ items: [{ projectId, path }] }` (1–200). `{ items: [{ projectId, path, status: 'present', quarantine } \| { projectId, path, status: 'missing' \| 'refused', reason }] }`. Used by the delivery notice to show only archives still on disk. |
| `POST` | `/worktrees/quarantines/remove` | Body `{ items: [{ projectId, path }] }` (1–100). Deletes each archive only when it is a real directory (not a link) named exactly like an archive whose resolved parent lies inside that project's own worktrees root; otherwise `refused` with `invalid` \| `missing` \| `not-a-quarantine` \| `outside-project`. Removal never follows links inside. Every attempt is logged. `{ results: [{ projectId, path, status: 'deleted' \| 'refused' \| 'failed', fileCount?, bytes?, reason?, error? }] }`. See [safe PR flow › Overlay kit on release](safe-pr-review-flow.md#overlay-kit-on-release). |

### Diagnostics (app-wide)

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/diagnostics/report` | Builds a redacted problem report and keeps it in memory for 15 min: `{ id, createdAtMs, fileName, files: [{ name, description, content, bytes }] }`. Nothing is uploaded. |
| `GET` | `/diagnostics/report/:id/zip` | `application/zip` with exactly the files of that preview; `404 report_expired` once it expired. |
| `GET` | `/diagnostics/crashes` | Crashes of the server the interface has not explained: `{ available, acknowledgedThroughMs, notices: [{ id, atMs, outcome, exitCode, signal, uptimeMs, wasReady, recentRestarts, maxRestarts }] }`. `available: false` outside the desktop app. |
| `POST` | `/diagnostics/crashes/ack` | `{ throughMs }` marks crashes up to that time as seen (never moves backwards or past the newest marker). |
| `GET` | `/diagnostics/stalls` | Event-loop stall snapshot: `{ thresholdMs, sampling, sinceMs, total, longestMs, recent: [{ atMs, durationMs, operation, utilization }] }`. |

See [server recovery and problem reports](server-recovery-and-diagnostics.md).

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

### Companion inbox decisions (`/v1/inbox*`, paired devices only)

The paired companion reads the [Needs-you inbox](#needs-you-inbox-app-wide) and runs a closed set of safe decisions through the Mobile Gateway (`/v1`, device bearer token, same project grant as every other `/v1` route). Each action is forwarded to the route the desktop UI itself uses, addressed to one project, and tier-checked with the MCP permission tiers (Settings ▸ MCP): a tier that is off answers `403 { error: "tier_disabled", tier, action }` and nothing is forwarded. See [companion inbox decisions](companion-inbox-decisions.md).

| Method | Path | Tier | Forwards to |
|--------|------|------|-------------|
| `GET` | `/v1/inbox` | none (read) | `GET /api/inbox`, narrowed to the device's granted projects; each item gains `companion: { actions: [{ id, tier, enabled }], runId?, sourceId?, railIndex?, expectedDecision? }` |
| `GET` | `/v1/projects/:pid/inbox/runs/:runId/question` | none (read) | `GET /agent-runtime/runs/:runId`; answers `{ pending, question?, requestedAt?, card? }` (`card`: the structured question card, see [run questions](run-questions.md)) |
| `POST` | `/v1/projects/:pid/inbox/answer` | `write` | body `{ runId, answer, optionId? }` (1-20000 chars; `optionId` must be a choice of the run's card, `400` otherwise) -> `POST /loop-runs/:runId/resume { answer, interruptId, optionId? }` (workflow runs) or `POST /agent-runtime/runs/:runId/resume { answer }`; `409 no_pending_question` when nothing waits |
| `POST` | `/v1/projects/:pid/inbox/resume` | `ai-spawn` | body `{ runId, runCap?: "ignore" \| runCapUsd?: number }` -> `POST /loop-runs/:runId/resume`; the budget `409` body is passed through so the phone can offer Continue / Raise |
| `POST` | `/v1/projects/:pid/inbox/retry` | `ai-spawn` | body `{ sourceId, railIndex }` (`sourceId` is a delivery id or `run:<id>`) -> `POST /rails/:railIndex/relaunch { sourceId }` |
| `POST` | `/v1/projects/:pid/inbox/create-pr` | `destructive` (pushes a branch) | body `{ prDeliveryId, expectedDecision: "on_review" }` -> `POST /rails/pr-decision { action: "create-pr" }`; the answer is narrowed to `{ ok, decision, prUrl, prState, detail }` |
| any | `/v1/projects/:pid/inbox/<anything else>` | n/a | `403 action_not_allowed_for_companion` (merge, discard, publish, force-push, settings, delete stay on Desktop) |

WebSocket: a device subscribed to the `inbox` topic receives a bare `{ type: "inbox.changed", projectId, reason }` when `rail.pr_state`, `rail.job_completed`, `rail.job_stopped`, `job.stuck`, `jira.outbox_changed` or `loop.run_paused|resumed|stopped|completed` fires for a project it may see; the phone re-reads `GET /v1/inbox`.

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
| `GET` | `/agent/conversations?archiveScope=active` | Non-trashed missions; scope is `active` (default), `archived` or `all`. Invalid or repeated scope returns 400. Rows expose nullable `archivedAt`. |
| `POST` | `/agent/conversations/:id/archive` | `{ conversation }`; idempotent, retains first timestamp and history. 404 unknown/trashed; 409 `{ error, code: 'MISSION_LIVE' }` for busy/reserved turns, background sessions/subagents or starting/running background processes. No work is stopped. |
| `POST` | `/agent/conversations/:id/unarchive` | `{ conversation }`; clears only archive state, idempotent. 404 unknown/trashed. |
| `POST` | `/agent/conversations/:id/branch` | `{ mode: 'empty' \| 'fork', throughMessageId }` → `201 { conversation }`. Inherits source settings without sending input. Fork copies committed history through the named source message, its attachments and provenance, with a new agent session. 400 invalid request; 404 unknown/trashed source or foreign/missing message; 409 `BRANCH_SNAPSHOT_FAILED` rolls back the new mission and files. |
| `POST` | `/agent/conversations/:id/side-questions` | "Ask about this". Body `{ selection, throughMessageId, question?, thread?: [{ role: 'user' \| 'assistant', content }], language? }` → `200 { answer, provider, model }`. One no-tool provider turn on the mission's provider and model (the provider default when the model is unavailable or the account rejects it), with the mission history bounded through `throughMessageId` (newest 12 messages, 17k chars). Writes no mission message, never touches the provider session and stores nothing about the side thread; records one `agent_invocations` row with `surface: 'side-question'` (Missions in analytics). An empty question asks for a plain explanation. 400 invalid or oversized request (selection > 8k chars, question > 4k, thread > 10 entries or 16k chars); 404 unknown/trashed mission or foreign message; 502 `SIDE_QUESTION_FAILED` with the provider's own message. A closed request aborts the call. |
| `DELETE` | `/agent/conversations/:id` | Requires archive for non-trashed missions (both DELETE variants return 409 `NOT_ARCHIVED` before cleanup otherwise). Soft delete: stops the live turn, closes the Core session and hides the mission (`deleted_at`); `{ ok, restorable: true }`. `?permanent=1` removes the row, history and attachments for good (`404` unknown id). Deleted missions are `404` on `GET /agent/conversations/:id` and `/send`, and absent from the list, search and mobile listings |
| `POST` | `/agent/conversations/:id/attachments` | Upload an attachment (multipart field `file`, 25 MB max; `{ attachment }`). Accepted: images, PDF and Excel by their reported type, or any file whose content is readable text (stored as `text/plain`, so `.md`, `.sql`, `.ts`, `.yaml`, `.log` all work). Anything else returns `400` `"<file>" is not a text file and cannot be attached` and stores nothing |
| `GET` | `/agent/conversations/trash?projectId=` | Deleted missions pinned to the project (all when omitted), newest deletion first: `{ items: [{ conversation, deletedAt, purgeAt }], retentionDays: 30 }`. Purges missions deleted more than 30 days ago first |
| `POST` | `/agent/conversations/:id/restore` | Undo a delete; idempotent. `{ ok, conversation }`, `404` when the mission no longer exists |
| `GET` | `/agent/conversations/:id` | Includes `session`: `{ residentPhase, processAlive, liveSubagents, subagents }`, or `null` when the mission never ran in Core. |
| `GET` | `/agent/conversations/:id/subagents` | `{ subagents, session }`. Each sub-agent has id, parent, kind, agent type, description, phase (`running`/`idle`/`failed`/`stopped`/`killed`/`interrupted`), reason, restarts, launching Core turn, timestamps, usage, tool uses, duration and result summary. Sub-agents Specrails launched on another provider carry `delegated: { driver, model }`; their usage is recorded as separate `subagent` invocations. |
| `GET` | `/agent/conversations/:id/subagents/:subagentId/events?after=&limit=` | Paged sub-agent transcript `{ events: [{ seq, channel, delta?, tool?, createdAt }], hasMore }`. `limit` is 1–1000. |
| `POST` | `/agent/conversations/:id/subagents/stop` | Body `{ subagentIds? }` (all when omitted). Returns `{ stopped }`; `502` when the session host is unavailable. |
| `POST` | `/agent/conversations/:id/session/rebuild` | Operator repair: replays the mission's Core journal into its sub-agent rows, events, resident state and cursor. Turns already recorded as messages/invocations are not duplicated; the replay is silent, then clients receive `agent_resident_state` and one `agent_subagent` per row. Returns `{ lastSeq, subagents }`; `409` while a turn runs or when the mission has no Core session; `502` when the host is unavailable. |
| `GET`/`POST` | `/agent/conversations/:id/limit-continue` | provider-quota: a mission turn refused on the usage limit leaves a `usage-limit` system row `{ kind, provider, resumeAt, message, at }` (broadcast `agent_system_row`) and an `agent_error` with `code: 'provider_limit'`. Missions never continue on their own: `POST { at: ISO }` schedules ONE ordinary continue turn at the reset (persisted in `desktop_settings`, re-armed after a restart, never during sleep or a dark wake), `{ at: null }` cancels; both return `{ at }` and broadcast `agent_limit_continue` `{ conversationId, at }`. `GET` returns `{ at }` (also in `GET /agent/conversations/:id` as `limitContinueAt`). |
| `POST` | `/agent/conversations/:id/session/renew` | "Start fresh with a summary". Writes a summary of the mission (one turn, no tools, the mission's provider/model/effort; one `agent_invocations` row with `surface: 'session-summary'`), stores it as a `session-summary` system row (broadcast `agent_system_row`), clears the provider session and the context snapshot (`agent_context_usage` null) and moves a Core mission to its next generation. Returns `{ messageId, summary }`. 409 `MISSION_BUSY` (turn running), `MISSION_IN_INTENT`, `MISSION_ARCHIVED`, `NOTHING_TO_SUMMARIZE`; 502 `SESSION_SUMMARY_FAILED` with the provider's message (nothing changed). |

Archived missions remain readable by ID. Send, queue edit and queue steer return
409 `{ error, code: 'MISSION_ARCHIVED' }` before creating input/message rows or
spawning work. Internal `sendMessage` also refuses archived admission
synchronously. Restore enables messaging again; cancellation stays available.

The mobile mission list is active-only (`deleted_at IS NULL` and
`archived_at IS NULL`). Known-ID history access retains project/device identity
checks; upstream send/queue conflicts enforce archived read-only behavior. The
mobile surface adds no archive operations.


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

Intent mode: `POST /agent/conversations/:id/send` also accepts `deliveryMode: 'interrupt'`, only while the conversation's Intent is active (`409 interrupt_requires_flow` otherwise). In an Intent session every mid-turn input reaches Core as `session.send { delivery: 'interrupt' }`, which cuts the running turn and runs the input next; the reply continues the same user turn. An Intent session turn on a host without `flowSessions` fails with `agent_error` code `flow_sessions_unavailable` (there is no legacy Intent transport). Intent turns are recorded in `agent_invocations` with `surface: 'flow'`.

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
| `GET` | `/jobs` | Job list (`?limit=&offset=&status=&attempts=all`). An attempt a later one continued is folded into its chain (`attempts=all` lists it); a continued run carries `attempt: { number, of, firstRunId }` |
| `GET` | `/jobs/export` | CSV/JSON export |
| `GET` | `/jobs/:runId/audit` | Agent actions of one run (job id or loop run id) as an attachment. `?format=jsonl` (default) or `csv`. Pending batched rows are flushed first; at most 100 000 rows, oldest first; `X-Agent-Actions-Rows` carries the count. `400` invalid format. See [agent actions audit](agent-actions-audit.md) |
| `GET` | `/agent-actions` | Project-wide agent actions export. `?format=jsonl\|csv&from=&to=` (ISO timestamps, inclusive). `400` for an invalid format, an unparsable timestamp or `from` after `to` |
| `GET` | `/jobs/compare` | Compare metrics between two jobs |
| `GET` | `/jobs/:id` | One job. Returns `{ job, events, phaseDefinitions }`; `job` is annotated with `hasTelemetry`, `tickets[]` (resolved from the command, powers the ticket header), `interactiveSettleMode` (`'finalize'` \| `'auto'` \| `null`) and `interactiveAcceptingTurns` (whether a resident session accepts turns right now — a between-steps loop run reports `'auto'`/`false` so the composer can phrase the waiting state) `failureDiagnosis` (`null`, or why a failed / stalled / blocked job stopped: see [failure diagnosis](#failure-diagnosis)) and `hold` (see below) |
| `DELETE` | `/jobs/:id` | Cancel a running or queued job |
| `DELETE` | `/jobs` | Purge completed jobs (optional `{ from, to }` window) |
| `PATCH` | `/jobs/:id/priority` | Re-rank a queued job |
| `POST` | `/jobs/:id/messages` | Send one more user turn to a running **interactive** job (queued behind the active turn). Body `{ text }`. Manager-agnostic: QueueManager is tried first, then the loop engine's active ai-step session. A loop run paused on a person also takes `{ text, interruptId, optionId? }` (an answer, `optionId` one of the question card's choices), `{ text: '', interruptId, approve: true }` or, when its card says `canReject`, `{ text: <reason>, interruptId, reject: true }` (see [run questions](run-questions.md)). `202` accepted, `400` missing text or a malformed `optionId` / `reject`, `403` interactive jobs disabled, `409` no active interactive session (unknown / non-interactive / finalized / a loop run between steps) |
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

Spending covers every AI call of the project. Recorded surfaces (`ai_invocations`): `job`, `loop`,
`quick-spec`, `explore-spec`, `ai-edit`, `smash`, `file-summary`, `chat-sidebar`, `spec-launcher`,
`proposal`, `agent-studio`, `setup`, `flow` (the Intent spec rewrite), `triage`, `failure-analysis`.
Two read-only **virtual surfaces** come from the app-level `agent_invocations` ledger (desktop DB) rows
pinned to the project (`project_id = :projectId`; Home turns are excluded): `mission` (Agent Chat /
Mission turns) and `intent` (Intent-mode turns, ledger surface `flow`). They count in every aggregate of
`/spending` and in `/invocations`; they live in a different ledger, so nothing is counted twice.
`recordInvocation` rejects them.

Every surface belongs to one spend **category** (the "why", `server/modules/accounting/runtime/spend-categories.ts`):

| Category | Surfaces | Why |
|----------|----------|-----|
| `implementation` | `job`, `loop` | Building specs with rails, loops and jobs |
| `missions` | `mission`, `intent`, `flow` | Talking to the agent and Intent mode |
| `specs` | `quick-spec`, `explore-spec`, `ai-edit`, `smash`, `spec-launcher`, `proposal`, `triage` | Writing and refining specs |
| `code` | `file-summary` | Explaining the code |
| `support` | `failure-analysis`, `setup`, `agent-studio`, `chat-sidebar` | Setup, diagnosis and side chats |

Shared query filters for `/spending`, `/invocations` and `/analytics/export`: `period` (`7d`\|`30d`\|`90d`\|`all`\|`custom`
with `from`/`to`), `surface` (CSV, recorded or virtual; unknown ids dropped), `category` (CSV; intersected
with `surface` when both are set, an empty intersection matches nothing), `provider`, `model` + `modelProvider`,
`status`, `minCostUsd`, `ticketId` (excludes every agent-ledger row: they carry no ticket), `tzOffsetMinutes`,
`sortBy` (`/invocations`).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/stats` | Summary (total jobs, tokens, cost) |
| `GET` | `/metrics` | Raw metrics |
| `GET` | `/spending` | Summary / timeline / by-category / by-surface / by-provider / by-model / top-tickets / `agentMissions` — powers the Analytics page. Agent-ledger rows count in the summary (cost, estimated, runs, tokens, priced/unpriced/usage coverage, previous-period delta), `dailyTimeline` (`missionCostUsd`; each day also carries `byCategory: { implementation, missions, specs, code, support }` summing to its `totalCostUsd`), `byProvider`, `byModel`, `bySurface`, `byCategory` and `scatter`; never in `topTickets` or `byMode`. `byCategory`: `[{ category, costUsd, estimatedCostUsd, count, tokens, unpricedCount, surfaces: [{ surface, costUsd, count, tokens }] }]`, all five categories, costliest first. `agentMissions`: `{ summary: { totalCostUsd, estimatedCostUsd, prevTotalCostUsd, turns, tokensIn, tokensOut, flowCostUsd, flowTurns }, topConversations: [{ conversationId, title, costUsd, estimatedCostUsd, turns, lastAt }] }` (top 5), filtered like the rest. An unreadable agent ledger degrades to the project ledger alone |
| `GET` | `/invocations` | Paginated raw rows of both ledgers, merged in the requested order. An agent-ledger row has `ledger: 'agent'`, `surface` `mission`\|`intent`, its agent `conversation_id`, `ticket_id: null` and the conversation title in `ticket_title`. `totalAvailable` counts both ledgers |
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
  "byCategory": [{ "category": "implementation", "costUsd": 9.10, "estimatedCostUsd": 0, "count": 31, "tokens": 412000, "unpricedCount": 0, "surfaces": [{ "surface": "job", "costUsd": 9.10, "count": 31, "tokens": 412000 }] }],
  "bySurface": [{ "surface": "job", "costUsd": 9.10 }, { "surface": "mission", "costUsd": 1.00 }],
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
| `GET` | `/budget/caps` | Budget panel read model: `{ generatedAt, spend, projection, config, appConfig, caps }` — see the app-wide `GET /api/budget/caps` for the shapes. `caps` holds every configured cap of this project AND the app-wide ones with the spend the gate counts (the project's ledger plus the mission / Intent turns pinned to it); `spend.<period>.byProvider` carries `turns` so a subscription provider can show turns instead of dollars. The projection is an estimate (average of the last 14 completed local days × days left in the month + month to date, integer cents), never a billed figure |
| `GET` | `/budget/what-if?from=<provider:model>&to=<provider:model>&days=30` | What-if pricing over recorded usage. Without `from`/`to`: `{ days, sources, targets, result: null }` (`sources` = models seen in the window with `{ invocations, recordedUsd, priced }`, `targets` = every model the local rate card prices). With both: `result` re-prices each invocation's recorded tokens on both models (`estimateCurrentUsd`, `estimateWhatIfUsd`, `deltaUsd = whatIf − current`, all estimates) and reports `repriced` / `skipped` invocations and `recordedUsd` apart. A model without a rate card yields `noPricing: { side, provider, model }` and null estimates, never a guess. `400 invalid_model_ref` on a malformed ref. Usage is recorded per model, not per profile role |
| `GET` | `/run-duration-range?loopId=\|command=` | Measured p25/median/p75 of this project's settled runs of a loop or job-command shape (`{ range, minSamples }`); `range` is `null` below 5 samples. Feeds the job story's "Runs like this have taken…" |
| `GET` | `/launch-forecast?loopId=\|command=&provider=` | Read-only launch forecast: `{ time, cost, minSamples, budget }`. Same samples as `run-duration-range`, narrowed to `provider`. `time` is `{ p25Ms, medianMs, p75Ms, sampleCount }`. `cost` is `{ lowUsd, highUsd, sampleCount }` (cents), built **only** from provider-reported costs (estimated costs and runs without a cost are excluded) and is an estimate, never a billed figure. Each is `null` below the 5-sample floor (render "Not enough history yet"). `factory:implement`/`factory:batch`/`factory:freestyle` read the `/specrails:implement`/`/specrails:freestyle` jobs; any other loop id reads `loop_runs`. `budget` is the tightest configured cap (daily, weekly or monthly; project or app-wide) `{ scope, period?, budgetUsd, spentUsd, exhausted, resetsAt }` (the same figures the launch gate enforces; `period` is absent for the daily budget) or `null`. `400` without `loopId`/`command` or on a malformed `provider` |

### Scoped search (⌘K)

The command palette's scopes. Missions (`@`) stay on `GET /api/agents/search`, files (`f:`) on `GET /code/find`
and docs (`?`) on `GET /api/docs/search`; these two are project-scoped and read only that project's data.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/search/specs` | `?q=` (required, single line, at most 200 characters, `400` otherwise), `?limit=` (default 8, max 30). Folded (case- and diacritics-insensitive) substring scan of the ticket store: title, short summary, description, labels, non-goals, addenda and comments, so it is never behind the file Core also writes. `#12`/`12` also matches by id. Live Intent placeholders are skipped. Returns `{ results: [{ id, title, status, priority, field, snippet }] }`, best field first (`field`: `id` \| `title` \| `summary` \| `label` \| `description` \| `nonGoal` \| `addendum` \| `comment`), then newest. `snippet` is `{ text, ranges: [[start, end], ...] }` (plain text plus character ranges to mark; never HTML) or `null` |
| `GET` | `/search/jobs` | Same `q`/`limit` rules. FTS5 trigram search (`bm25`, one row per job; queries under 3 characters use a bounded `LIKE` scan) over the job-log index of this project's database (migration 86, `server/db/job-search.ts`): job command, loop name, phase titles and the failure diagnosis kind/detail/host-blocker text. It never indexes events or token streams. Returns `{ results: [{ jobId, command, status, startedAt, field, snippet }] }` (`field`: `command` \| `loop` \| `phase` \| `failure` \| `detail`). `jobId` is also the loop-run id, so the client opens `/jobs/:jobId` |

The job-log index (`job_search_docs` + external-content `job_search_fts`) is derived data kept current at job create,
phase events and settle (`finishJob`, loop-run settle), cleaned on delete/purge, and bounded: 300 characters per
document, 30 phase documents per job, 30,000 documents per project (the oldest tenth is dropped when over). Migration 86
creates it and runs the same idempotent backfill (`rebuildJobSearchIndex`, newest 5,000 jobs). An indexing failure never
fails the write that triggered it.

### Tickets

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/tickets` | Filters: `?status=`, `?label=`, `?q=`. Optional paging: `?limit=` (0–200) with `?cursor=` (the previous `nextCursor`) or `?offset=` adds `matched`, `statusCounts`, `offset`, `limit`, `nextOffset`, `nextCursor` (`cursorStale` when the cursor predates the store revision; `400 invalid_cursor` when malformed). `?groupBy=status&perGroup=N` (0–50, default 5) answers `{ groups: [{ status, count, tickets }], revision, total, matched, perGroup }`. Without these the answer is unchanged |
| `GET` | `/tickets/:id` | One ticket |
| `POST` | `/tickets` | Create. Optional `nonGoals: string[]` ("Out of scope"; `400 nonGoals must be an array of strings` otherwise) and `intent` (`{ problem, outcome, hypothesis?, successSignals?, affects?, constraints?, openQuestions? }`, intent-mode; `400 intent.problem is required` / `intent.outcome is required` / `intent.<list> must be an array`) |
| `PATCH` | `/tickets/:id` | Update any subset of fields. `metadata` merges keys; `metadata.regressionOf` (delivery id string ≤ 200 chars, escaped-defect link) is validated on create/update/commit-draft (400 otherwise) and `null` removes it. `nonGoals` (string array; `[]` or `null` removes the field) is cleaned (list markers, blanks, duplicates; at most 20 items of 300 characters) and never written back to Jira. `intent` (object, `null` removes it) is validated and normalized the same way as on create, and is local-only too |
| `DELETE` | `/tickets/:id` | Soft delete: the spec moves to the trash sidecar `<store>.trash.json` (hidden from every list, search and Core read; `{ ok, revision, restorable: true }`, `404` unknown id, repeat deletes are idempotent). A deleted epic orphans its children. Attachments, the Explore draft conversation and the Jira link are kept until the entry is purged or deleted permanently. Broadcasts `ticket_deleted` |
| `GET` | `/tickets/trash` | Recently deleted specs, newest deletion first: `{ items: [{ ticket, deletedAt, purgeAt }], retentionDays: 30 }`. Purges entries older than 30 days first |
| `POST` | `/tickets/:id/restore` | Undo a delete: the spec returns under the same id (and re-adopts the children it orphaned). Idempotent (`alreadyLive: true`), `404` when it is in neither the board nor the trash. Broadcasts `ticket_created` |
| `DELETE` | `/tickets/trash/:id` | Delete permanently: removes the entry plus the cascade a hard delete used to run (attachments, the draft's orphan Explore conversation). `404` when not in the trash |
| `POST` | `/tickets/generate-spec` | Quick-mode generation. Body `{ idea, model?, contractRefine?, aiEngine?, attachmentIds?, pendingSpecId?, contextScope?, intent? }` (the spec text is `idea`, not `title`). `intent: true` (Add Spec → Intent): the response opens with the intent, stored on the new spec, and the spec is derived from it; an unusable intent leaves the spec without one. Streams progress over WS |
| `POST` | `/tickets/save-as-draft` | Persist an Explore conversation as a draft (idempotent on `conversationId`) |
| `POST` | `/tickets/from-draft` | Commit a draft (flip-in-place) or insert a new ticket. An explicit `nonGoals` list wins; otherwise a `## Out of Scope` section of the description moves into `nonGoals`. Optional `intent` (validated as on create; the first-party `commit_draft` sends the conversation's answered `intent-draft`). Optional `agentProvider`: the originating mission's provider, sent only by first-party `commit_draft`. It is validated, pins triage for the saved spec and is passed as `providerId` to Contract Refine; an uninstalled provider is ignored and an unsupported step is reported without running another provider |
| `POST` | `/tickets/from-prompt` | Create a ticket directly from a prompt |
| `POST` | `/tickets/:id/contract-refine` | Retry Contract Refine for an existing ticket. `202` scheduled, `404` unknown ticket, `409` when the effective provider cannot enforce the required tool policy (`contract_refine_unsupported_for_<provider>`; this includes Kimi), the kill switch is active (`feature_disabled_by_env`), or the ticket has no origin conversation. Kimi is rejected before spawn or mutation |
| `POST` | `/tickets/:id/triage` | Recalculate the [spec triage](spec-triage.md) (forced, even when the inputs hash is unchanged). `200 { triage }` with the stored `metadata.triage` record (`ready`, `unavailable` or `failed`), `400` invalid id, `404` unknown ticket, `409 { error: 'triage_not_applicable', reason }` for a cancelled spec, an epic or an Intent-held spec, `503 triage_unavailable` when the project has no triage service. The record is also broadcast as `ticket_updated` |
| `POST` | `/tickets/:id/smash` | SMASH an epic into sub-specs |
| `POST` | `/tickets/:id/smash/undo` | Undo a SMASH operation |
| `DELETE` | `/tickets/:id/children` | Delete all children of an epic |
| `POST` | `/tickets/:id/ai-edit` | Open an AI edit (Refine) session against the ticket |
| `DELETE` | `/tickets/:id/ai-edit` | Cancel an AI edit session |
| `POST` | `/tickets/:ticketId/attachments` | Upload an attachment (multipart). Tickets keep the fixed type allow-list (`400` `Unsupported file type: <mime>`). `?readableText=1` opts a pending Explore spec (UUID key) into the conversation rule (rich type or readable text, same `400` refusal message as the agent upload); it is ignored for numeric ticket ids |
| `GET` | `/tickets/:ticketId/attachments` | List attachments |
| `GET` | `/tickets/:ticketId/attachments/:attachmentId` | Download one |
| `DELETE` | `/tickets/:ticketId/attachments/:attachmentId` | Delete one |
| `DELETE` | `/tickets/:ticketId/attachments` | Delete all |
| `GET` | `/tickets/:ticketId/timeline` | The spec's lifecycle, a read-model over existing stores (no store of its own). Query: `?kinds=spec_edit,addendum,mission_turn,job,phase,audit,pr_event,review` (comma list, `400` for an unknown kind), `?limit=` (1-200, default 50), `?cursor=` (opaque, from `nextCursor`; `400` when malformed). Returns `{ ticketId, entries, nextCursor, counts, total }`, newest first; `counts` are per kind over the whole timeline so filter chips keep counting. An entry is `{ id, at, kind, event, params, title, summary, actor, tone: neutral\|ok\|failure\|review, provider, costUsd?, costKind?: billed\|estimated, costEstimatedUsd?, turns?, link, url?, count?, items? }`: `event`/`params` are a stable code the client localizes, `title` is the source text (or an English fallback), `link` is `{ place: spec\|mission\|job\|review, id }` for the client to turn into a place URL, `count`/`items` describe a collapsed group (phases per job, agent actions per job, mission turns per conversation). `costKind: estimated` means part of `costUsd` came from the pricing table; a run the provider reported no cost for carries no `costUsd`. Free text is passed through `redactProse`. `400` invalid id, `404` unknown ticket |
| `GET` | `/tickets/:ticketId/handoff` | The hand-off export: `?format=md\|html\|pr` (default `md`; `pr` is the concise Markdown PR description), `?locale=` (UI language, any of the 8; headings follow it, unknown falls back to `en`), `?planProviders=claude,codex` (providers billed through a plan: shown as turns, never dollars). Returns `{ format, filename, contentType, body, redactions, locale }`. Sections: summary, request, decisions (addenda, clarifications, reviewer verdicts), changes (delivery diff stats from the review packet's Changes read model), verification, cost (billed and estimated apart), open follow-ups (open addenda, unresolved findings). Every string and the finished document go through `redactProse`; `redactions` counts the changed strings. `400` invalid format or id, `404` unknown ticket |

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

## `/api/projects/:projectId/flow/*` (alias `/intent/*`)

Intent mode ([guide](intent-mode.md)): build with an agent in an isolated worktree,
then hand the worktree to a rail. Every route also answers under
`/api/projects/:projectId/intent/*` with the same handler and response; `/flow`
is the frozen original. Thin routes over the
[Intent module](../../server/modules/intent/README.md). Every response carries the
Intent as `{ id, conversationId, ticketId, state, branch, worktreePath, baseSha,
headSha, coreSessionId, railIndex, deliveryId, step, createdAt, updatedAt }`;
`state` is `active` / `paused` / `handed_off` / `delivered` / `discarded` /
`needs-review` and `step` names an unfinished saga step (`start:*`, `handoff:*`).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/flow/availability` | `{ available, reason, missing[] }`. Available only when Core sessions are usable and Core advertises `flowSessions` and `deriveChange`. |
| `POST` | `/flow` | Start. Body `{ conversationId, idea, title?, flowId?, repositoryId?, ticketId?, intent? }`. `intent` (the intent card's Explore; `400 invalid_intent`) is stored on the placeholder spec and seeds the first turn. With `ticketId` the Intent starts from that EXISTING spec (idea optional): no placeholder; the spec is labelled In Intent and seeds the first turn; `400 invalid_ticket_id` / `spec_not_found`, `409 spec_closed` / `spec_in_flow` / `spec_on_rail` / `spec_running` before anything is written. The mission must be pinned to this project and its provider must have a Core session driver on a host with `flowSessions`. Creates the placeholder spec, reserves the worktree and returns `201 { flow }`. Idempotent by `flowId`. `409 flow_already_open` (with `flowId`) when the conversation has an open Intent; `409 feature_unavailable` (with `missing`) without the capabilities; `409 repository_has_no_commits` when the repository has an unborn HEAD (nothing is created; the placeholder spec is removed; the client offers `POST /api/projects/:projectId/git/initial-commit`, which runs only `git commit --allow-empty -m "Initial commit"` in the primary repository against an empty scratch index (zero files, nothing staged) and answers `201 { sha, repositoryId }`, `409 repository_has_commits`, `409 git_identity_missing` or `409 repository_is_not_git`); `400 conversation_not_pinned` / `idea_required` (without `ticketId`). |
| `GET` | `/flow/by-conversation/:conversationId` | `{ flow }`: the open Intent, else the latest one, else `null`. |
| `GET` | `/flow/open` | `{ flows: [{ id, conversationId, state, branch }] }`: the project's conversations in Intent mode (active, paused, needing review) — the mission list's "In Intent" mark. No worktree paths. |
| `GET` | `/flow/:flowId` | `{ flow }`; `404 flow_not_found`. |
| `POST` | `/flow/:flowId/pause` | Closes the Intent's Core session (a running Intent turn is stopped); worktree and spec stay. Idempotent. |
| `POST` | `/flow/:flowId/resume` | Reopens the session lazily on the next turn. `409 flow_worktree_missing` when the worktree disappeared. Idempotent. |
| `POST` | `/flow/:flowId/discard` | Closes the session, removes the Intent worktree and branch and deletes the placeholder spec. `409 illegal_transition` after a hand-off and for a `needs-review` Intent. Idempotent. |
| `POST` | `/flow/:flowId/close` | Ends a `needs-review` Intent WITHOUT deleting anything: branch, any surviving worktree and the spec stay; the Intent becomes `closed` (terminal; `discarded` means the worktree and branch were removed), the spec's `metadata.flow.state` becomes `closed` (no "In Intent" label) and the history gets a `left/closed` boundary. `409 illegal_transition` from any other open state. Idempotent. |
| `POST` | `/flow/:flowId/hand-off` | Body `{ railIndex, loopId?, aiEngine?, model?, reasoning_effort? }`; `loopId` defaults to `factory:flow-spec` (never the rail's default loop). Commits the worktree (HEAD frozen), closes the session, assigns the Intent spec to a free rail and launches it with `flowId`. Returns `202 { flow, loopRunIds, deliveryId }`. A refused launch keeps its status and code (`409 rail_not_empty`, `409 flow_worktree_mismatch`, `409 pr_decision_pending`…) and the Intent returns to `paused`. |
| `POST` | `/flow/by-delivery/:deliveryId/return` | Back to Intent: the Intent → Spec delivery stopped with requested changes (`implementation_failed` / `review_changes_requested`) gives its adopted worktree back. One delivery-owned transaction removes the `rail_worktrees` row, closes the delivery as `discarded` / `returned_to_flow` and sets the Intent `paused` with the review as its next-turn briefing; then the session reopens (`active`, or `paused` when it cannot open). Returns `{ flow }`. Idempotent by delivery. `404 flow_not_found`; `409 flow_return_not_allowed`, `flow_return_busy`, `flow_return_worktree_mismatch`, `flow_worktree_missing`. |
| `POST` | `/flow/by-delivery/:deliveryId/relaunch` | The same return, then the ordinary hand-off on the stopped delivery's rail and engine choices: Intent → Spec runs again on the same worktree and re-derives the existing change. Returns `202 { flow, loopRunIds, deliveryId }`; refusals as for `return` and `hand-off`. |
| `GET` | `/flow/:flowId/diff` | `{ branch, baseSha, headSha, files: [{ path, status, additions, deletions }], totals: { files, additions, deletions } }` — working tree against the Intent base, overlay and `node_modules` excluded. Empty once the Intent is no longer open. |
| `GET` | `/flow/:flowId/cost` | `{ flowId, costUsd, turns, unpricedTurns, tokensIn, tokensOut }` — provider-billed cost of the Intent's turns only; turns without billed cost are counted in `unpricedTurns`, never estimated. |

WebSocket: `flow.state` `{ projectId, conversationId, flowId, flow, timestamp }`
on every committed state change (project-scoped).

The launched `factory:flow-spec` loop exists only on a Core with `deriveChange: 1`
(`409 engine_unsupported` otherwise; `400 flow_id_required` without `flowId`).
When its delivery reaches review the Intent settles: spec rewrite, Jira create and
review transition as durable effects ([settlement](intent-mode.md#settlement)). The
delivery's review packet carries `derivation` and `flowSettlement`.

---

## `/api/projects/:projectId/rails/*`

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | List rails. Also returns `reviewWip { limit, pending: [{ deliveryId, railIndex, ticketIds, decision, since }], reached }` (the review WIP limit and the deliveries that count against it). Optional paging: `?limit=` (≤ 100) with `?cursor=` or `?offset=` returns that page of rails, only their entries in `activeJobs` / `activeLoopRuns` / `prDeliveries`, plus `total`, `offset`, `limit`, `nextOffset`, `nextCursor`; `400 invalid_cursor` when malformed |
| `PUT` | `/:railIndex/tickets` | Assign tickets to a rail. Body `{ ticketIds: number[], mode?, profileName?, aiEngine? }`. An omitted `mode` keeps the rail's stored mode; `mode` must be `implement` / `loop` (400 otherwise), with `batch-implement` / `batch` / `freestyle` / `ultracode` normalized to `implement`. |
| `PUT` | `/:railIndex/profile` | Set the rail's default profile |
| `PUT` | `/:railIndex/engine` | Set the rail's AI engine override. Body `{ aiEngine }` (string — one of the project's providers — or `null` to clear) |
| `PUT` | `/:railIndex/name` | Set the rail's display name. Body `{ name }` (string or `null` to clear back to the default label); 400 if longer than 60 characters |
| `POST` | `/:railIndex/launch` | Launch the rail. Body `{ mode?, loopId?, profileName?, aiEngine?, model?, reasoning_effort?, originConversationId?, originSurface?, interactive?, flowId? }`. `flowId` (sent by the Intent hand-off, never by the dashboard) adopts that Intent's frozen worktree: the rail must carry exactly the Intent spec (`409 flow_rail_mismatch`), the Intent must be waiting for the launch (`409 flow_handoff_not_ready`), the launch must be isolated (`409 flow_requires_isolation`), relaunch/revision/target PR/follow-up/base options are refused (`400 flow_handoff_incompatible`) and a mount/branch/HEAD discrepancy returns `409 flow_worktree_mismatch`. `loopId: 'factory:flow-spec'` without `flowId` returns `400 flow_id_required`. `runCapUsd` (a number > 0 caps this run's provider-reported cost: it pauses and asks through the budget gate; `0` waives the default; absent keeps the project/app default) is accepted on a fresh launch and stored with the run. `mode` is `implement` / `loop` (the removed Batch mode's `batch-implement` / `batch` are accepted as input aliases and normalized to `implement`); a factory `loopId` maps to its canonical rail mode (`factory:batch` resolves to `factory:implement`). `mode: freestyle`/`ultracode` and the loop ids `factory:freestyle`, `factory:sdd-quick-openspec`, `factory:openspec`, `factory:revision` are retired: `400 { error: 'builtin_loop_retired', loopId?|mode, replacement: 'factory:implement', detail }`. `model` and `reasoning_effort` are validated against the effective adapter/model (Kimi effort is K3-only). Kimi + a loop containing a Decider returns a capability error before the first step. Claude alone advertises persistent in-job stdin; `interactive` remains wire-compatible. Returns `202 { jobId, railIndex, mode }`; a missing provider CLI fails before a job starts. While the project or app-wide daily budget is exhausted, this route and `/relaunch` return `409 { error: 'daily_budget_exceeded', scope, period?, budgetUsd, spentUsd, resetsAt, detail, action }` and spawn nothing (`period` is `week` / `month` for the longer caps and absent for the daily budget, so the body predating caps is unchanged). `POST /loop-runs` and `POST /loop-runs/:id/resume` return the same body. Resume also continues a `budget_paused` run in place; a run paused at its per-run soft cap answers `409` with `period: 'run'` (`resetsAt: null`) until the resume body carries the person's choice: `{ runCap: 'ignore' }` (continue without the cap) or `{ runCapUsd: n }` (raise it; it must end above what the run spent). `POST /loop-runs` also accepts `runCapUsd` (a number > 0 caps that run, `0` waives the default). When the project's `reviewWipLimit` is reached and the launch would open a new delivery, this route and `/relaunch` return `409 { error: 'review_wip_limit_reached', limit, pending: [{ deliveryId, railIndex, ticketIds, since }], detail, action }` and spawn nothing. Continuations of an existing delivery (`revisionOfDeliveryId`, Relaunch of a recorded delivery, `targetPrNumber`, `followUp`, or a rail that still owns an active delivery) are exempt.A repository that must be worktree-isolated (e.g. a multi-repository launch) but has no commits yet returns `409 { error: 'repository_has_no_commits', detail }` before any delivery row, branch or worktree exists; a single-repository launch without commits keeps the shared-checkout fallback (`isolationUnavailable: 'no-commits'`). |
| `GET` | `/:railIndex/launch-overlaps` | Conflict-aware launch (advisory): `{ overlaps: [{ railIndex, state: 'running' \| 'pending', title, files }] }`, the other rails of this project (running, or waiting for their merge) that share files with this rail's specs: the files the specs name plus the files their agents wrote. A launch's `202` carries the same `overlaps` (when any) and each run logs one `⚠ Likely overlap with rail N …` line. |
| `POST` | `/:railIndex/pr-ci` | PR CI loop (pr-ci-loop). Body `{ prDeliveryId, originConversationId?, originSurface? }`. Starts `factory:pr-ci` as a continuation of the delivery's attached PR (new generation on the PR branch; the previous one is superseded and restored on allocation failure) with the delivery's frozen engine/model/effort/profile. `403 pr_ci_disabled` (`SPECRAILS_PR_CI_LOOP=false`); `409 pr_ci_requires_pr_mode`, `engine_unsupported` (Core without `hostTasks`), `pr_delivery_not_active`, `pr_operation_in_progress`, `pr_ci_not_allowed` (not `pr_draft`/`pr_ready` with a PR; for a multi-repository delivery, a repository still under review without its PR), `pr_unverifiable`, `pr_fork_unsupported`, `pr_not_open` (each with the `prUrl` concerned: every PR under review of a multi-repository delivery is checked in its own repository); `404 pr_delivery_not_found`; then the launch route's own answers (budget, WIP, isolation). `POST /:railIndex/launch` with `loopId: 'factory:pr-ci'` returns `400 pr_ci_requires_delivery`. |
| `POST` | `/pr-ci-offer/dismiss` | "Not now" on a `pr-ci-offer` row. Body `{ prDeliveryId }`; `200` when the row was `offered`, `409 pr_ci_offer_not_pending` otherwise, `404` for an unknown delivery. |
| `POST` | `/pr-ci/admissions` | Mission-origin CI repair offer for a PR without a delivery. Body `{ prUrl, originConversationId }`. Resolves the PR against the project's repositories (origin remote), persists the host admission and posts the `pr-ci-offer` card; starts no agent, worktree or push. `200 { admissionId, state, repositoryId, prNumber, prUrl, headBranch, baseBranch }`. Refusals: `400 pr_url_invalid`, `origin_conversation_required`; `403 pr_ci_disabled`; `404 target_pr_not_found`; `409 engine_unsupported`, `pr_repository_not_in_project`, `pr_repository_ambiguous`, `pr_not_open` (closed/merged), `pr_fork_unsupported` (fork branches are not writable by Specrails), `target_pr_invalid`; `502 pr_github_unavailable` (authentication or connection failure, not a missing PR). |
| `POST` | `/pr-ci/admissions/:admissionId/start` | Explicit start from the card. Only the id travels; repository, PR, head and base come from the admission and are re-validated. `202 { admissionId, runId, loopRunIds, state: 'started' }`. `409 pr_ci_already_running` (with `runId`), `pr_ci_run_active` (a delivery is building on the PR, or an admission run for the delivery-backed start), `pr_changed`, `pr_ci_offer_dismissed`, `isolation_failed`, `engine_unsupported`, `pr_ci_requires_pr_mode`, the validation codes above and the daily-budget refusal; `403 pr_ci_disabled`; `404 pr_ci_admission_not_found`. |
| `POST` | `/pr-ci/admissions/:admissionId/dismiss` | "Not now" on a mission-origin offer: `200` when `offered`, `409 pr_ci_offer_not_pending` otherwise. |
| `GET` | `/pr-ci-availability` | `{ available }`: Loops, PR delivery, `SPECRAILS_PR_CI_LOOP` and the selected Core's `hostTasks` capability. |
| `GET` | `/pr-ci-status?deliveryId=` | `{ deliveryId, prs: [{ repository, prUrl, prNumber, state, total, pending, failing, headSha }] }`: live CI of a `pr_draft`/`pr_ready` delivery's open PR(s) from `gh pr view`, whether or not a CI loop ran (`state`: `green`, `red`, `pending`, `none`, `conflict`, `closed`, `unknown`). Cached 60 s per PR and project; empty `prs` before review. |
| `POST` | `/:railIndex/stop` | Stop the rail's running job (cancels every job the rail registered) |
| `POST` | `/:railIndex/relaunch` | Relaunch a settled source. Body `{ sourceId: deliveryId or 'run:<runId>', originConversationId?, originSurface? }`. Uses its recorded specs and admitted options, restores empty assignments after preflight and atomically replaces an undelivered failed generation. Returns the same `202` launch response. Reused/removed rails, active/stale sources, missing specs/workflow and delivered work needing recovery return actionable errors. Request-side workflow overrides are ignored. |
| `GET` | `/pr-deliveries/:id/packet[?repositoryId=]` | The plain-language [review packet](review-packet.md) with the pre-resolved Accept ladder. 404 when `SPECRAILS_REVIEW_PACKET=false`. |
| `GET` | `/pr-deliveries/:id/changes[?repositoryId=&source=]` | Changes tab list (read-only). `{ prDeliveryId, repositoryId, changes }`; `changes` is `{ available: true, source, sources: [{ id: 'delivery' \| 'ticket:<id>', ticketId, branch }], base, head, baseSha, headSha, root, rootKind: 'worktree' \| 'repository', files: [{ path, oldPath, status: added\|modified\|deleted\|renamed\|copied\|typechange, additions, deletions, binary, hash }], truncated, totals, annotations }` or `{ available: false, reason: not_a_repository\|no_branch\|head_missing\|base_missing\|git_failed, sources, annotations }`. The comparison is the delivery head (settled sha, else the branch) against its merge-base with the base branch. `source` picks one unit's branch when there is no assembled branch (`400` on a malformed value). At most 2000 files (`truncated`). `hash` changes whenever the file's diff does (viewed-mark invalidation). `annotations` are reviewer findings (anchored when Core contract 5.9 named a location), review-brief risks and untested files, and follow-up comments; `location` is `null` when the source named no place. |
| `GET` | `/pr-deliveries/:id/changes/file?path=&full=1[&repositoryId=&source=]` | One file's parsed diff: `{ prDeliveryId, diff: { path, oldPath, status, binary, hunks: [{ header, oldStart, oldLines, newStart, newLines, lines: [{ type: context\|add\|delete, oldNo, newNo, text, noNewline? }] }], truncated, totalLines } }`. Capped at 4000 lines unless `full=1` (60,000). `path` must be a path of the listing (`404 file_not_in_changes`, `400` without it); it is never passed to git as a free pathspec. `409` with the unavailable `reason` when the comparison cannot be made. |
| `GET` | `/merge-preview[?deliveryId=]` | Merge preview of the project's pending deliveries (`building`, `on_review`, `pr_draft`, `pr_ready`, `pr_failed`; primary-repository branches): `{ supported, previews: [{ deliveryId, railIndex, baseRef, baseSha, status, conflictFiles, conflictFileCount, baseAdvancedBy, siblings: [{ deliveryId, railIndex, files, fileCount }], reason, computedAt }] }`. `status` is `clean` \| `conflicts` \| `already_merged` (the merge result is the base: a squash or rebase merge already landed) \| `unknown`; `baseRef` is `origin/<base>` when it exists, else `<base>`; `baseAdvancedBy` counts base commits the branch lacks; `siblings` are pending deliveries on the same base whose changes conflict. Computed with `git merge-tree --write-tree` (Git ≥ 2.38, else `supported: false`) in a scratch object store, no checkout, no fetch; cached by commit sha. With `deliveryId`, only that delivery is returned (siblings still compare against all). See [delivery README](../../server/modules/delivery/README.md#merge-preview). |
| `POST` | `/worktree-preparation` | Body `{ count }` (0–3). The Launch all dialog opened: prepare up to `count` run checkouts of the primary repository from the current base guess and warm the fetch. Advisory: `{ preparing }` (with `warning` on failure, never an error status). `SPECRAILS_WORKTREE_PREPARATION=false` answers `{ preparing: 0 }`. |
| `POST` | `/worktree-preparation/release` | The dialog was dismissed: drop this project's unclaimed prepared checkouts. `{ released }`. |

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
> [Kimi adapter](../../server/providers/kimi-adapter.ts).

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
| `rail.merge_preview` | project | A background merge-preview refresh (triggered by the live board) found a changed preview; clients refetch `GET /rails/merge-preview` and the live board |

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
