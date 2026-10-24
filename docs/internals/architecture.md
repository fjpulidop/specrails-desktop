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

The app SQLite (`desktop.sqlite`) stores only project metadata. All per-project data lives in an isolated `jobs.sqlite` under the project's slug directory — not just jobs and chat, but rails, tickets, agent profiles/versions, AI invocations (cost analytics), telemetry pointers, file provenance, terminal settings/marks, and more (see the `MIGRATIONS` array in `server/db/migrations.ts`). Projects can be removed and re-added without losing history, and the registry can be wiped without touching project data.

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
| `SetupManager` | Background workspace assembly for added projects (plus the legacy API/MCP install flow) |
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
| `db.ts`, `db/` | Stable persistence facade with separate connection, migrations and domain repositories; see [source boundaries](source-architecture.md) |
| `modules/execution/runtime/queue-manager.ts` | Legacy job queue: spawn provider CLI processes serially per project |
| `modules/loops/runtime/loop-run-manager.ts` | Loop runs: the default rail execution path, concurrent across rails |
| `modules/conversations/runtime/chat-manager.ts` | Chat/Explore: spawn provider CLI for conversational turns |
| `setup-manager.ts` | Silent workspace assembly (`startSilentAssemble`) plus the legacy API/MCP install and `/setup` chat |
| `config.ts` | Command discovery: scan `<project>/.claude/commands/sr/*.md` |
| `hooks.ts` | Pipeline event handler: process phase transition events |
| `modules/accounting/runtime/spending.ts` | Cost/analytics aggregation (single source of truth) |
| `modules/accounting/runtime/ai-invocations.ts` | `recordInvocation` — writes one billable row per AI CLI call |
| `modules/accounting/runtime/pricing.ts` | Rate-card cost fallback for providers without native billing |
| `modules/accounting/runtime/result-event.ts` | `finaliseInvocationResult` — combines adapter result + pricing |
| `modules/accounting/runtime/telemetry-receiver.ts` | OTLP/JSON receiver mounted at `/otlp` |
| `modules/accounting/runtime/desktop-analytics.ts` | App-level analytics aggregated across all projects |
| `modules/accounting/runtime/metrics.ts` | Per-project health metrics |
| `docs-router.ts` | Serve the embedded docs portal (`/api/docs`) |
| `path-resolver.ts` | Resolve a usable PATH for GUI-launched desktop spawns |
| `types.ts` | Shared TypeScript interfaces |

Provider, terminal, profile, plugin, code-explorer, and explore subsystems each live in their own modules — see [Feature subsystems](#feature-subsystems).

---

## Client architecture

```
client/src/
├── App.tsx                     # Mounts DesktopProvider + DesktopApp unconditionally
├── components/                 # App shell and shared primitives
│   ├── ArcSidebar.tsx          # Collapsible Arc-style left sidebar (projects, Loops, Plugins, …) — see Sidebar shell
│   ├── ProjectLayout.tsx       # Per-project three-panel wrapper
│   ├── ProjectRightSidebar.tsx # Project nav (Jobs, Analytics, Agents, Code, …)
│   ├── TitleBar.tsx            # Custom frameless titlebar (desktop)
│   └── WelcomeScreen.tsx       # Zero-state landing
├── features/<capability>/      # One folder per capability: pages/, components/, hooks/, lib/
│   ├── dashboard/pages/DashboardPage.tsx     # Specs board + Rails board
│   ├── analytics/pages/AnalyticsPage.tsx     # Per-project cost analytics (+ DesktopAnalyticsPage)
│   ├── agents/pages/AgentsPage.tsx           # Agent profiles + catalog
│   ├── code/pages/CodePage.tsx               # Code explorer
│   ├── jobs/pages/JobDetailPage.tsx          # Full log viewer for a single job (+ JobsPage)
│   ├── settings/pages/                       # SettingsPage (project route), GlobalSettingsPage
│   └── projects/components/                  # AddProjectDialog, OnboardingWizard (product tour)
├── hooks/
│   ├── useDesktop.tsx          # DesktopProvider context: project list, active project
│   ├── useProjectCache.ts      # Stale-while-revalidate per-project cache
│   └── useSharedWebSocket.tsx  # Single WS connection, per-project filtering
├── lib/
│   ├── api.ts                  # getApiBase(): dynamic API prefix per active project
│   └── route-memory.ts         # Per-project URL route save/restore
└── locales/<lang>/*.json       # i18n strings for the 8 supported locales
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

### Sidebar shell

The left `ArcSidebar` and the right sidebar (`ProjectRightSidebar` on the board, `AgentWorkspaceSidebar` in Agent Mode) share one behaviour contract:

- **Modes** live in `context/SidebarPinContext.tsx`: `pinned-open`, `pinned-collapsed`, `unpinned`, persisted per side in `localStorage`. A new user starts with the left sidebar **pinned open** and the right one **unpinned**. `effectiveLeftMode` / `effectiveRightMode` render a pinned-open sidebar as unpinned when the window is at most 1100px wide (`NARROW_WINDOW_QUERY`), without rewriting the stored choice. Sidebars read the effective mode; pin buttons show the stored one.
- **Overlay, never reflow.** Each sidebar is an in-flow `<aside>` wrapper plus an absolutely positioned panel (`z-30`). The wrapper reserves the expanded width only when pinned open (`useResizableSidebar(..., { docked })` writes both widths imperatively, also during a drag); a hover- or focus-expanded unpinned panel grows over the content with `shadow-xl` while the wrapper stays at the 44px rail.
- **Hover intent and focus** (`hooks/useSidebarHoverIntent.ts`): open after 150ms of hover, close 250ms after the pointer leaves, open while keyboard focus is inside, collapse on blur only when focus and pointer have both left. A portalled flyout that belongs to a sidebar (the Builder panel) carries `data-sidebar-flyout` so focus moving into it keeps the rail open. A resize drag never collapses the panel.
- **Rows** are plain containers holding a real `<button>` (select) with the row actions as sibling buttons; actions reveal on hover *and* `focus-within`. Destructive confirmations ("Remove?" / "Delete?") stay armed for 5 s.
- **Mission roll-up.** A project, Home ("Unassigned missions") or Favorites group whose tree is not on screen shows the attention mark of its missions (warning triangle for a failed run, dot for a waiting decision), an unread dot, and an accent icon while an agent works; on the collapsed rail the attention mark is a badge on the project's monogram tile.
- **Right-side button.** `lib/sidebar-layout.ts` (`isGlobalRoute`, `hasRightSidebar`) decides whether a right sidebar is mounted; `App.tsx` and the title bar share it, so the title bar never shows a button for a sidebar that is not on screen.
- **Shortcuts:** `⌘B` / `Ctrl+B` cycles the left sidebar, `⌥⌘B` / `Ctrl+Alt+B` the right one (`hooks/useKeyboardShortcuts.ts`).
- **Workspace panes** (Agent Mode Jobs / Files / Analytics) are mutually exclusive (`AgentWorkspaceContext`); the conversation column keeps a 360px floor.

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

- **The legacy job queue is serial per project.** Each `ProjectContext` has exactly one `QueueManager` with a single `_activeJobId`; `_drainQueue()` early-returns while a job is active, so the next queued job waits behind the current one.
- **Rails run concurrently.** With Loops enabled (the default), each rail launch is a `LoopRunManager` run, not a queued job, so several rails in one project run at the same time. Repo-mutating runs get their own git worktree (default-on; `SPECRAILS_RAIL_WORKTREES=0` restores the shared cwd), and a launch whose tickets are already in flight on another rail is refused with `409 tickets_in_flight`.
- **Projects never contend.** Each project has its own `QueueManager` and loop runs. There is no "max concurrent jobs" setting; the only automatic queue-pause is budget-based (daily budget / per-job cost alert).
- **Cancelling a job** sends `SIGTERM`, waits **5 seconds**, then `SIGKILL`. (The terminal panel's 2-second shutdown grace is a separate subsystem.)
- A zombie-job watchdog terminates a stuck job after a default of **30 minutes**, overridable via `WM_ZOMBIE_TIMEOUT_MS`.
- Log lines stream back over WebSocket in real time.

---

## Feature subsystems

The app is more than the job pipeline. Each subsystem owns its modules; this is a map, not a duplication of [`CLAUDE.md`](../../CLAUDE.md).

| Subsystem | Server modules | Notes |
|-----------|---------------|-------|
| **Multi-provider adapters** | `server/providers/{types,claude-adapter,codex-adapter,gemini-adapter,kimi-adapter,registry,index}.ts`, `server/provider-selection.ts` | **Four first-class providers — Claude, Codex, Gemini, and Kimi — enabled by default** behind a `ProviderAdapter` contract. Claude reports native cost and supports persistent stdin; Codex (`≥ 0.128.0`) and Gemini (`≥ 0.11.0`) expose estimated usage; Kimi (`≥ 0.27.0`) runs CLI-only prompt-mode JSONL, resumes through terminal hints, uses `.kimi-code` skills/MCP, and leaves absent cost/tokens unavailable. A project can install any subset; `providers[]` is a JSON column, the first entry is primary. Per-invocation provider is late-bound. Provider availability is gated by executable detection, Core target compatibility, and the existing Codex/Gemini emergency switches. See [`adding-a-provider.md`](adding-a-provider.md), [`../codex.md`](../codex.md), [`../gemini.md`](../gemini.md), and [`../kimi.md`](../kimi.md). |
| **Spending analytics** | `server/modules/accounting/runtime/spending.ts`, `server/modules/accounting/runtime/ai-invocations.ts`, `server/modules/accounting/runtime/pricing.ts` | `recordInvocation` writes an `ai_invocations` row per AI CLI call across twelve surfaces (`job`, `loop`, `quick-spec`, `explore-spec`, `ai-edit`, `smash`, `file-summary`, `chat-sidebar`, `spec-launcher`, `proposal`, `agent-studio`, `setup`); mission turns record to the app-level `agent_invocations` ledger and are folded into a pinned project's spending. Powers the Analytics page and `spending.invalidated`. |
| **Agent profiles** | `server/modules/agents/runtime/profile-manager.ts`, `server/modules/agents/runtime/profiles-router.ts` | Declarative JSON in `.specrails/profiles/*.json`, snapshot-per-job, `SPECRAILS_PROFILE_PATH` env injection. Requires `specrails-core ≥ 4.1.0` in general and the Core 4.12 Kimi target for Kimi roles (the app installs Core 6: `CORE_PACKAGE_SPEC` in `server/core-package.ts`). Claude and Kimi advertise profile support; other adapters force legacy/no-profile mode. |
| **Plugins (Integrations)** | `server/plugin-manager.ts`, `server/plugins/` | Bundled-only, MCP-based, additivity invariant, surgical `.mcp.json` merge, `plugin.*` WS events. Serena ships today. |
| **Terminal panel** | `server/modules/terminals/runtime/terminal-manager.ts` | `node-pty` sessions over the dedicated `/ws/terminal/:id` socket, OSC shell-integration marks. See [`../terminal.md`](../terminal.md). |
| **Code explorer** | `server/modules/code/runtime/code-explorer-router.ts`, `server/modules/code/runtime/file-provenance.ts`, `server/modules/code/runtime/file-summary-manager.ts` | A non-developer-friendly file tree + Monaco viewer with plain-language AI summaries and *touched-by-AI* provenance chips per ticket/job, plus opt-in in-app editing of existing files (overwrite-only via `PUT /file` — no create/rename; refuses binaries `415`, enforces a 2 MB cap `413`, `404` on a missing path, respects deny-list/`.gitignore`). |
| **Pipeline telemetry** | `server/modules/accounting/runtime/telemetry-receiver.ts` + QueueManager OTEL injection | Opt-in OTLP/JSON signals to `POST /otlp/v1/{traces,metrics,logs}`; blobs compacted after 7 days; diagnostic ZIP export. |
| **Explore acceleration + Contract Refine** | `server/modules/conversations/runtime/explore-cwd-manager.ts`, `server/modules/specs/runtime/contract-refine-runner.ts` | App-managed Explore spawn cwd for fast first-token; optional post-commit Contract Layer enrichment. Kill switches: `SPECRAILS_EXPLORE_CONTRACT_REFINE`, `SPECRAILS_EXPLORE_LEGACY_CWD`. |
| **Tickets / drafts** | `server/modules/specs/runtime/ticket-store.ts` | Spec tickets (incl. `draft` status) backing the Specs board and Save-as-Draft flow. |
| **Jira integration** | `server/jira/*` (`jira-sync-manager`, `jira-client`, `jira-materializer`, `jira-status-resolver`, `jira-db`, `jira-credential-store`), `server/jira-router.ts` | Optional per-project sync that backs a project's specs with a Jira board (Cloud or Data Center). Desktop is the sync layer — specrails-core reads the materialized cache unchanged and stays read-only. Inbound polling + a durable outbox handle write-back (`transition`, `comment`, `update`, and `create` — durable promotion of a local ticket enqueued by `enqueuePromote`, idempotent on its key and on an existing link, sharing `promoteTicketToJira`'s create-link-flip logic; created issues carry an invisible `sh.specrails.created-from` property, so a retry recovers an issue whose create response was lost instead of creating a duplicate); the encrypted token lives on-device. Routes under `/api/projects/:id/jira/*` (gated by `SPECRAILS_JIRA_SECTION`, 404 when off); project-scoped WS events `jira.synced`, `jira.sync_error`, `jira.auth_expired`, `jira.outbox_changed`, `jira.degraded`. See [`../jira-integration-plan.md`](../jira-integration-plan.md). |
| **Theme system** | `server/desktop-router.ts` (`GET/PATCH /api/theme`) | Five built-in themes (`dracula`, `aurora-light`, `obsidian-dark`, `matrix`, `specrails`), default `specrails`, persisted app-wide with an anti-FOUC inline script. |

Most client feature sections are gated by VITE flags, and they share one polarity: `VITE_FEATURE_TERMINAL_PANEL`, `VITE_FEATURE_AGENTS_SECTION`, `VITE_FEATURE_EXPLORE_PREMIUM_UX`, and `VITE_FEATURE_CODE_EXPLORER` are all **opt-out** — default ON, set the flag to `false` to hide that section. See [`configuration.md`](configuration.md) for the full flag and settings reference.

---

## Project add and workspace assembly

There is no setup wizard in the app UI. `POST /api/projects` (`server/desktop-router.ts`) registers the project with the auto-detected providers, answers `201`, and then calls `SetupManager.startSilentAssemble` in the background (skipped when the workspace is already populated):

1. **Assemble** — one specrails-core `init` per detected provider, sequential, with per-provider failure isolation. The bundled Core is preferred (`spawnBundledCoreInit` in `server/offline-assemble.ts`, offline, with the bundled OpenSpec); without a bundle the fallback is `npx` with `CORE_PACKAGE_SPEC` from `server/core-package.ts` (currently `specrails-core@^6.0.0`, a deliberately pinned major range). `SPECRAILS_CORE_BIN` overrides the binary locally. Local (OpenAI-compatible) engines have no Core target and are skipped.
2. **Relocation** — the framework lands in `~/.specrails/projects/<slug>/workspace` (`workspacePathFor`), never in the user's repository.
3. **Progress** — the app-level `project.assemble_progress` WS event (`{projectId, provider, status}`) drives the sidebar indicator; a failure never rolls back registration, and `POST /api/projects/:id/assemble-retry` re-runs only the failed providers.

After a Core update swap, `reseedStaleWorkspaces` (`server/framework-reseed.ts`) re-assembles stale workspaces. The legacy per-project `/setup/*` and `/enrich/*` routes (`server/project-router-setup.ts`) stay mounted for the MCP `specrails_setup` tool and API callers; their AI turns record under the `setup` spending surface.

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
