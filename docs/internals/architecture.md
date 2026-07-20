# Architecture

This document describes the technical architecture of specrails-desktop: its layers, data layout, request flow, authentication, and the subsystems that make up the app. It is the entry point to the other internals docs — see the [See also](#see-also) block at the bottom. (The authoritative version lives in `package.json`; this doc is verified against `main`.)

---

## Three-layer monorepo

```
specrails-desktop/
├── server/       → Express 5 + WebSocket + SQLite (TypeScript, CommonJS)
├── client/       → React 19 + Vite + Tailwind v4 (TypeScript, ESM)
├── cli/          → specrails-desktop CLI bridge (TypeScript, CommonJS)
└── src-tauri/    → Tauri v2 desktop shell (Rust + bundled server sidecar)
```

Server and CLI compile to **CommonJS** (root `tsconfig.json`). The client is **ESM** with its own `client/tsconfig.json`. The client has its own `package.json` and `node_modules`, so two separate `npm install` calls are required (root + `client/`).

The server persists with **better-sqlite3** (synchronous SQLite) and serves over **Express 5**; the WebSocket layer uses **ws**.

### Everyday commands

```bash
npm run dev          # server (4200) + client (4201) concurrently
npm run dev:server   # server only (tsx watch)
npm run dev:client   # Vite dev client only
npm run build        # production build: server → client → CLI
npm run typecheck    # tsc --noEmit for server and client
npm test             # vitest (server + CLI) + core-compat check
```

Tests use vitest with `:memory:` SQLite databases.

---

## Data layout

```
~/.specrails/
  desktop.sqlite          # project registry (id, name, path, slug, provider…)
  desktop.token           # auth token, mode 0600 (auto-generated on first run)
  registry.json           # repo-realpath → workspace map shared with specrails-core (artifact relocation)
  manager.pid             # server PID for clean shutdown
  framework/<version>/<provider>/   # bundled specrails-core framework, materialized once
  framework/current        # symlink → active framework version (atomic swap on app update)
  projects/
    <slug>/
      jobs.sqlite         # per-project: jobs, rails, tickets, invocations, …
      jobs/<jobId>/       # per-job snapshots (profile.json, plugins.json, …)
      workspace/          # relocated spawn cwd (artifactRoot); ./project link → repo
      telemetry/          # OTEL blobs (compacted after 7 days)
      explore-cwd/        # app-managed Explore spawn cwd (CLAUDE.md + ./project link)
      terminals/          # per-session shell-integration shims
```

> **Artifact relocation + bundled framework (pre-release, branch `feat/relocate-artifacts-to-home`).** Relocated projects spawn AI-CLIs from `projects/<slug>/workspace` (with `SPECRAILS_REPO_DIR` pointing at the repo) instead of the repo, so imported repos stay pristine; the framework is bundled and symlinked instead of installed per-project via `npx`. See the **Artifact relocation + bundled framework** section in `CLAUDE.md` and the three internal docs: `global-artifacts-relocation-evaluation.md`, `global-artifacts-alignment-contract.md`, `bundled-framework-build-plan.md`.

The app SQLite (`desktop.sqlite`) stores only project metadata. All per-project data lives in an isolated `jobs.sqlite` under the project's slug directory — not just jobs and chat, but rails, tickets, agent profiles/versions, AI invocations (cost analytics), telemetry pointers, file provenance, terminal settings/marks, and more (see the `MIGRATIONS` array in `server/db.ts`). Projects can be removed and re-added without losing history, and the registry can be wiped without touching project data.

> The data root is hardcoded to `os.homedir()/.specrails`. There is no environment override for the data directory.
>
> **Rebrand migration:** installs upgraded from the Specrails Hub era are migrated automatically — on startup the server renames a legacy `hub.sqlite` (plus its `-wal`/`-shm` sidecars) to `desktop.sqlite` and a legacy `hub.token` to `desktop.token` before opening them, so no data or token is lost.

---

## Super-mode architecture

Super mode is the **only** supported mode — a single Express process manages every registered project. There is no legacy single-project runtime, and no mode detection.

```
┌─────────────────────────────────────────────────────┐
│  Express Server (port 4200, 127.0.0.1 only)         │
│                                                     │
│  ProjectRegistry                                    │
│  ├── Project A → ProjectContext { db, queue, chat,  │
│  ├── Project B →   chatManager, setupManager, cwd } │
│  └── Project C → …                                  │
│                                                     │
│  Routes:                                            │
│  /api/*                  → app-level operations    │
│  /api/projects/:id/*     → project-scoped actions   │
│  /otlp/v1/*              → OTLP telemetry receiver   │
└─────────────────────────────────────────────────────┘
```

### Per-project isolation

Each project in the `ProjectRegistry` gets its own `ProjectContext`:

| Resource | Description |
|----------|-------------|
| `db` | SQLite connection to `projects/<slug>/jobs.sqlite` |
| `QueueManager` | Serialized job queue for this project (one active job at a time) |
| `ChatManager` | Isolated conversation manager (Explore + sidebar chat) |
| `SetupManager` | Wizard state for projects being onboarded |
| `cwd` | Absolute path to the project directory on disk |

The `boundBroadcast` closure injects `projectId` into all WebSocket messages, so managers don't need per-project constructor arguments.

---

## Key server modules

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Entry point: PATH resolution, auth bootstrap, port binding, router mounts, WS server |
| `auth.ts` | Token bootstrap + `requireAuth` middleware + WS upgrade token check |
| `desktop-db.ts` | App-level SQLite: project registry CRUD, app settings |
| `project-registry.ts` | `ProjectRegistry` class: load/unload per-project `ProjectContext` |
| `desktop-router.ts` | `/api/*` routes: projects, settings, themes, specrails-tech proxy, cross-project analytics |
| `project-router.ts` | `/api/projects/:id/*` routes: all project-scoped operations |
| `db.ts` | Per-project SQLite: schema (`MIGRATIONS`) + queries |
| `queue-manager.ts` | Job queue: spawn provider CLI processes serially per project |
| `chat-manager.ts` | Chat/Explore: spawn provider CLI for conversational turns |
| `setup-manager.ts` | Setup wizard: orchestrate `specrails-core` install + `/setup` chat |
| `config.ts` | Command discovery: scan `<project>/.claude/commands/sr/*.md` |
| `hooks.ts` | Pipeline event handler: process phase transition events |
| `spending.ts` | Cost/analytics aggregation (single source of truth) |
| `ai-invocations.ts` | `recordInvocation` — writes one billable row per AI CLI call |
| `pricing.ts` | Rate-card cost fallback for providers without native billing |
| `result-event.ts` | `finaliseInvocationResult` — combines adapter result + pricing |
| `telemetry-receiver.ts` | OTLP/JSON receiver mounted at `/otlp` |
| `desktop-analytics.ts` | App-level analytics aggregated across all projects |
| `metrics.ts` | Per-project health metrics |
| `docs-router.ts` | Serve the embedded docs portal (`/api/docs`) |
| `path-resolver.ts` | Resolve a usable PATH for GUI-launched desktop spawns |
| `types.ts` | Shared TypeScript interfaces |

Provider, terminal, profile, plugin, code-explorer, and explore subsystems each live in their own modules — see [Feature subsystems](#feature-subsystems).

---

## Client architecture

```
client/src/
├── App.tsx                     # Mounts DesktopProvider + DesktopApp unconditionally
├── components/
│   ├── TabBar.tsx              # Project tab switcher
│   ├── ProjectLayout.tsx       # Per-project three-panel wrapper
│   ├── ProjectNavbar.tsx       # Left/right sidebar pin + collapse toggles
│   ├── ArcSidebar.tsx          # Collapsible Arc-style left sidebar
│   ├── ProjectRightSidebar.tsx # Project nav (Jobs, Analytics, Agents, Code, …)
│   ├── TitleBar.tsx            # Custom frameless titlebar (desktop)
│   ├── CommandGrid.tsx         # Command launcher
│   ├── RecentJobs.tsx          # Job history card list
│   ├── ProjectHealthWidget.tsx # Per-project health indicators
│   ├── AddProjectDialog.tsx    # Register project modal (provider multi-select)
│   ├── WelcomeScreen.tsx       # Zero-state landing
│   └── SetupWizard.tsx         # Configure / Install / Done onboarding wizard
├── hooks/
│   ├── useDesktop.tsx          # DesktopProvider context: project list, active project
│   ├── useProjectCache.ts      # Stale-while-revalidate per-project cache
│   ├── useSpecGenTracker.tsx   # Quick-spec generation state (localStorage)
│   ├── usePipeline.ts          # Pipeline phase state
│   └── useSharedWebSocket.tsx  # Single WS connection, per-project filtering
├── pages/
│   ├── DashboardPage.tsx       # Specs board + Rails board + pipeline state
│   ├── AnalyticsPage.tsx       # Per-project cost analytics
│   ├── DesktopAnalyticsPage.tsx # Cross-project spending roll-up
│   ├── AgentsPage.tsx          # Agent profiles + catalog
│   ├── CodePage.tsx            # Code explorer: file tree + Monaco viewer + edit (flag-gated)
│   ├── SettingsPage.tsx        # Per-project settings
│   ├── GlobalSettingsPage.tsx  # App settings
│   └── JobDetailPage.tsx       # Full log viewer for a single job
└── lib/
    ├── api.ts                  # getApiBase(): dynamic API prefix per active project
    ├── pending-specs.ts        # Quick-spec state persistence (localStorage)
    └── route-memory.ts         # Per-project URL route save/restore
```

### App bootstrap

`App.tsx` mounts `DesktopProvider` and `<DesktopApp />` **unconditionally** — there is no mode detection and no fallback layout. The client fetches its auth token same-origin from `/api/token` and then loads the project registry.

### API base routing

`getApiBase()` (from `lib/api.ts`) always returns `${API_ORIGIN}/api/projects/<activeProjectId>` and **throws** when no active project is set — it never returns a bare `/api`. `DesktopProvider` updates the active project (via `setActiveProjectId`) on project switch; all API calls must go through `getApiBase()` rather than hardcoding `/api/projects/...`.

### Per-project tab switch pattern

On project switch:
1. `useDesktop` updates `activeProjectId`.
2. `useProjectCache` returns cached data immediately (no flicker).
3. A background fetch refreshes the cache for the new project.
4. Never reset to empty state — always show the last-known data while loading.

State-bearing hooks key off `activeProjectId` as a `useEffect` dependency. `useSpecGenTracker` (via `lib/pending-specs.ts`) and `lib/route-memory.ts` persist Quick-spec progress and the active URL route per project to `localStorage`, surviving refreshes and project switches.

---

## Authentication

The app is local-first but **always authenticated** — auth is mandatory, not optional.

- On first run the server generates a token (two concatenated `randomUUID()`s) and persists it to `~/.specrails/desktop.token` with mode `0600` (`server/auth.ts`).
- `app.use('/api', requireAuth)` protects every `/api/*` route. The exceptions are `GET /api/health` and `GET /api/token` (both mounted before the middleware), plus `/api/docs` (the docs portal handlers respond before the auth fallthrough).
- `requireAuth` accepts the token as an `Authorization: Bearer <token>` header **or** an `X-Desktop-Token: <token>` header.
- WebSocket upgrades are authorized by `authorizeUpgrade`: the browser client sends the token as a subprotocol `desktop-token.<token>`; the CLI can pass it as a `Bearer` header.

There is no UI to set or clear the token and it is not an app setting. The browser client fetches it same-origin from `/api/token`, which is why that one route is public.

---

## WebSocket protocol

A single WebSocket connection at `ws://127.0.0.1:4200/ws` multiplexes all application messages. Terminal PTY output flows over a dedicated `/ws/terminal/:id` socket so high-throughput terminal data cannot starve the event stream.

Every project-scoped message includes a `projectId` field; app-level messages (`desktop.project_added`, `desktop.project_removed`, `desktop.projects`) have none.

### Connect handshake

The **only** frame the server sends on connect is `desktop.projects` (the full project registry) — `server/index.ts` pushes it inside `wss.on('connection', …)`. There is no rich per-connection dashboard snapshot pushed automatically. After connecting, a client subscribes to a project (sends a subscribe frame with `projectId`); per-project state then arrives as the project broadcasts it — notably the `queue` snapshot and per-job `exit` replay. A new client should code against `desktop.projects`, not against an `init` frame.

> **`init` is defined-but-unused.** A `type:'init'` shape exists as a TypeScript interface in `server/types.ts`, but no code path emits it in Super mode — it is a legacy shape, not a live frame. Do not wire a client to receive it.

### Representative message types

Canonical shapes live in `server/types.ts`. The core dashboard messages:

| Type | Scope | Payload (key fields) |
|------|-------|----------------------|
| `desktop.projects` | app | `{ projects }` — full registry, the **on-connect** frame |
| `queue` | project | `{ jobs, activeJobId, paused, timestamp, projectId }` — full queue snapshot |
| `log` | project | `{ source: 'stdout'\|'stderr', line, timestamp, processId, projectId }` |
| `phase` | project | `{ phase, state, timestamp, projectId }` |
| `exit` | project | `{ code, signal, early }` — process exit replay on the WS upgrade |
| `desktop.project_added` | app | `{ project }` |
| `desktop.project_removed` | app | `{ projectId }` |

Job lifecycle is reported by the message types `job_started`, `job_completed`, `job_failed`, and `job_canceled`. Feature subsystems add many more (`spending.invalidated`, `plugin.*`, `file.*`, `rail.job_started/completed/stopped`, `explore.contract_refine_failed`, chat/refine/SMASH/proposal streams). See [`api-reference.md`](api-reference.md) for the full outbound-event catalogue.

### Client filtering pattern

WS handlers use a ref to avoid stale closures:

```tsx
const activeProjectIdRef = useRef(activeProjectId)
useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

// In a WS message handler:
if (msg.projectId && msg.projectId !== activeProjectIdRef.current) return
```

App-level messages (no `projectId`) are processed by all handlers.

---

## Process spawning and concurrency

`QueueManager` and `ChatManager` spawn the project's provider CLI (`claude`, `codex`, `gemini`, or `kimi`) as subprocesses, always with `cwd` set so the process runs in the correct directory. The exact binary and argv are chosen by the resolved `ProviderAdapter` — managers never branch on the provider id (see [Multi-provider adapters](#feature-subsystems)).

- **Within a project, jobs run strictly one at a time.** Each `ProjectContext` has exactly one `QueueManager` with a single `_activeJobId`; `_drainQueue()` early-returns while a job is active, so the next rail job queues behind the current one.
- **Parallelism is across projects only** — each project has its own `QueueManager`, so jobs in different projects run simultaneously. There is no "max concurrent jobs" setting; the only automatic queue-pause is budget-based (daily budget / per-job cost alert).
- **Cancelling a job** sends `SIGTERM`, waits **5 seconds**, then `SIGKILL`. (The terminal panel's 2-second shutdown grace is a separate subsystem.)
- A zombie-job watchdog terminates a stuck job after a default of **30 minutes**, overridable via `WM_ZOMBIE_TIMEOUT_MS`.
- Log lines stream back over WebSocket in real time.

---

## Feature subsystems

The app is more than the job pipeline. Each subsystem owns its modules; this is a map, not a duplication of [`CLAUDE.md`](../../CLAUDE.md).

| Subsystem | Server modules | Notes |
|-----------|---------------|-------|
| **Multi-provider adapters** | `server/providers/{types,claude-adapter,codex-adapter,gemini-adapter,kimi-adapter,registry,index}.ts`, `server/provider-selection.ts` | **Four first-class providers — Claude, Codex, Gemini, and Kimi — enabled by default** behind a `ProviderAdapter` contract. Claude reports native cost and supports persistent stdin; Codex (`≥ 0.128.0`) and Gemini (`≥ 0.11.0`) expose estimated usage; Kimi (`≥ 0.27.0`) runs CLI-only prompt-mode JSONL, resumes through terminal hints, uses `.kimi-code` skills/MCP, and leaves absent cost/tokens unavailable. A project can install any subset; `providers[]` is a JSON column, the first entry is primary. Per-invocation provider is late-bound. Provider availability is gated by executable detection, Core target compatibility, and the existing Codex/Gemini emergency switches. See [`adding-a-provider.md`](adding-a-provider.md), [`../codex.md`](../codex.md), [`../gemini.md`](../gemini.md), and [`../kimi.md`](../kimi.md). |
| **Spending analytics** | `server/spending.ts`, `server/ai-invocations.ts`, `server/pricing.ts` | `recordInvocation` writes an `ai_invocations` row per AI CLI call across six surfaces (`job`, `quick-spec`, `explore-spec`, `ai-edit`, `smash`, `file-summary`); powers the Analytics page and `spending.invalidated`. |
| **Agent profiles** | `server/profile-manager.ts`, `server/profiles-router.ts` | Declarative JSON in `.specrails/profiles/*.json`, snapshot-per-job, `SPECRAILS_PROFILE_PATH` env injection. Requires `specrails-core ≥ 4.1.0` in general and the Core 4.12 Kimi target for Kimi roles (the app-wide install floor is `^4.12.0`). Claude and Kimi advertise profile support; other adapters force legacy/no-profile mode. |
| **Plugins (Integrations)** | `server/plugin-manager.ts`, `server/plugins/` | Bundled-only, MCP-based, additivity invariant, surgical `.mcp.json` merge, `plugin.*` WS events. Serena ships today. |
| **Terminal panel** | `server/terminal-manager.ts` | `node-pty` sessions over the dedicated `/ws/terminal/:id` socket, OSC shell-integration marks. See [`../terminal.md`](../terminal.md). |
| **Code explorer** | `server/code-explorer-router.ts`, `server/file-provenance.ts`, `server/file-summary-manager.ts` | A non-developer-friendly file tree + Monaco viewer with plain-language AI summaries and *touched-by-AI* provenance chips per ticket/job, plus opt-in in-app editing of existing files (overwrite-only via `PUT /file` — no create/rename; refuses binaries `415`, enforces a 2 MB cap `413`, `404` on a missing path, respects deny-list/`.gitignore`). |
| **Pipeline telemetry** | `server/telemetry-receiver.ts` + QueueManager OTEL injection | Opt-in OTLP/JSON signals to `POST /otlp/v1/{traces,metrics,logs}`; blobs compacted after 7 days; diagnostic ZIP export. |
| **Explore acceleration + Contract Refine** | `server/explore-cwd-manager.ts`, `server/contract-refine-runner.ts` | App-managed Explore spawn cwd for fast first-token; optional post-commit Contract Layer enrichment. Kill switches: `SPECRAILS_EXPLORE_CONTRACT_REFINE`, `SPECRAILS_EXPLORE_LEGACY_CWD`. |
| **Tickets / drafts** | `server/ticket-store.ts` | Spec tickets (incl. `draft` status) backing the Specs board and Save-as-Draft flow. |
| **Jira integration** | `server/jira/*` (`jira-sync-manager`, `jira-client`, `jira-materializer`, `jira-status-resolver`, `jira-db`, `jira-credential-store`), `server/jira-router.ts` | Optional per-project sync that backs a project's specs with a Jira board (Cloud or Data Center). Desktop is the sync layer — specrails-core reads the materialized cache unchanged and stays read-only. Inbound polling + a durable outbox handle write-back; the encrypted token lives on-device. Routes under `/api/projects/:id/jira/*` (gated by `SPECRAILS_JIRA_SECTION`, 404 when off); project-scoped WS events `jira.synced`, `jira.sync_error`, `jira.auth_expired`, `jira.outbox_changed`, `jira.degraded`. See [`../jira-integration-plan.md`](../jira-integration-plan.md). |
| **Theme system** | `server/desktop-router.ts` (`GET/PATCH /api/theme`) | Five built-in themes (`dracula`, `aurora-light`, `obsidian-dark`, `matrix`, `specrails`), default `specrails`, persisted app-wide with an anti-FOUC inline script. |

Most client feature sections are gated by VITE flags, and they share one polarity: `VITE_FEATURE_TERMINAL_PANEL`, `VITE_FEATURE_AGENTS_SECTION`, `VITE_FEATURE_EXPLORE_PREMIUM_UX`, and `VITE_FEATURE_CODE_EXPLORER` are all **opt-out** — default ON, set the flag to `false` to hide that section. See [`configuration.md`](configuration.md) for the full flag and settings reference.

---

## Setup wizard flow

When a project is added without specrails-core, the setup wizard runs. The client renders a **3-step** indicator: **Configure → Install → Done**.

1. **Configure** — confirm path and pick provider(s) and model presets. (Multi-provider projects get one Configure step per provider.)
2. **Install** — the app writes `.specrails/install-config.yaml` and runs `npx --yes --prefer-online specrails-core@^4.12.0 init --yes --from-config <tempPath>`, streaming the log. The package spec is the constant `CORE_PACKAGE_SPEC` — a deliberately pinned major range (the floor is `4.12.0`, the release that ships the Kimi provider target), so a future core `5.x` doesn't auto-land. Override the binary locally with `SPECRAILS_CORE_BIN`. For multi-provider projects each provider's install runs sequentially.
3. **Done** — per-provider completion summary.

`SetupManager` (server) owns wizard state; `DesktopProvider` (client) tracks which projects are in setup via `setupProjectIds`. The wizard does spawn a real AI CLI for the `/setup` chat, but that spawn is deliberately left uninstrumented (it writes no `ai_invocations` row).

---

## Desktop app layer

The **Tauri v2** desktop app wraps the Vite-built React client as a native macOS/Windows app.

- **Server sidecar** — `scripts/build-sidecar.mjs` compiles the Express server to a standalone binary. Tauri bundles it and manages its lifecycle.
- **Frameless window** — `tauri.conf.json` sets `decorations: false` on all platforms; the custom titlebar (drag region, window controls) is rendered in `TitleBar.tsx`. On macOS the native traffic-light controls are handled there.
- **GUI-launch PATH** — when launched from Finder/Dock the embedded server inherits a minimal launchd PATH, so `server/path-resolver.ts` resolves a usable PATH before any subprocess spawns (prepending well-known package-manager dirs, or the bundled runtime dirs in desktop mode).
- **Bundled runtimes** — in desktop mode the Tauri host sets `SPECRAILS_IS_DESKTOP=1` and `SPECRAILS_BUNDLED_RUNTIMES_PATH=<resource_dir>/runtimes` (only when a non-empty `runtimes/` dir is bundled), so the app can run without a system Node/Git. When no bundled runtimes are present it falls back to the system PATH.

### Desktop commands

```bash
npm run dev:desktop      # tauri dev (development desktop app)
npm run build:desktop    # build:server + client build + build:sidecar + tauri build
npm run generate-icons   # tauri icon src-tauri/icons/icon.svg
```

> There is no `npm run tauri` script — `npm run tauri dev` / `npm run tauri build` fail with "Missing script: tauri".

macOS desktop builds are signed + notarized. Windows builds (x64 and arm64) ship **unsigned** in v1 (SmartScreen "More info → Run anyway"). See [`../platforms/windows.md`](../platforms/windows.md) and [`../platforms/macos.md`](../platforms/macos.md).

---

## Ports

| Port | Service |
|------|---------|
| `4200` | Express server (API + WebSocket), bound to `127.0.0.1` (overridable via `--port`) |
| `4201` | Vite dev server (proxies `/api` and `/hooks` to 4200) |

---

## Security model

- **Loopback-only bind** — the server listens on `127.0.0.1` and is not exposed to a network.
- **Mandatory token auth** — every `/api/*` route and every WebSocket upgrade requires the app token (see [Authentication](#authentication)). The token lives in `~/.specrails/desktop.token` (mode `0600`).
- **Origin check** — a CORS middleware rejects cross-origin (non-localhost `Origin`) requests with `403`.
- **Parameterized SQL** — all SQLite operations use parameterized queries; user input is never string-interpolated into SQL.
- **Path validation** — project paths are validated as existing directories on registration.

---

## See also

- [API reference](api-reference.md) — REST routes and the full WebSocket event catalogue
- [Configuration](configuration.md) — env vars, feature flags, app/project settings
- [Agent profiles](profiles.md) — profile schema, resolution order, snapshot-per-job
- [Adding a provider](adding-a-provider.md) — the `ProviderAdapter` contract
- [Codex](../codex.md) / [Gemini](../gemini.md) / [Kimi](../kimi.md) — per-provider user guides
- [OpenSpec workflow](openspec-workflow.md) — the spec-driven change lifecycle
- [Operations runbook](operations-runbook.md) — running, upgrading, and recovering the app
