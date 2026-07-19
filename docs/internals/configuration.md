# Configuration

Reference for configuring specrails-desktop: app-wide settings, per-project settings, the authentication token, environment variables, CLI flags, and the `~/.specrails/` data directory.

Everything here is verified against `main`. The app server binds to `127.0.0.1` only and rejects any non-localhost origin, so all of this is local-first by design.

> **Providers at a glance.** A project can run **Claude, Codex, Gemini, Kimi,
> or any compatible combination**. All four are enabled by default and chosen
> when you add the project. Each has its own adapter default:
>
> | Provider | CLI binary | Default model | Emergency rollback |
> |----------|-----------|---------------|--------------------|
> | Claude Code | `claude` | `sonnet` | — |
> | Codex CLI | `codex` | `gpt-5.5` | `SPECRAILS_CODEX_BETA=0` |
> | Gemini CLI | `gemini` | `gemini-3.5-flash` | `SPECRAILS_GEMINI_BETA=0` |
> | Kimi Code | `kimi` | `k3` | — |
>
> The provider set is **immutable after the project is created**.

---

## Authentication

The app is protected by a **mandatory** API token — there is no "off" switch and no UI to set it.

- On first run the server generates a token (two concatenated random UUIDs) and writes it to `~/.specrails/desktop.token` with mode `0600`. The same file is reused on every subsequent start.
- Every `/api/*` route requires the token via an `Authorization: Bearer <token>` or `X-Desktop-Token: <token>` header. The only exceptions are `GET /api/health` and `GET /api/token`.
- WebSocket upgrades carry the token as the `desktop-token.<token>` subprotocol.
- The browser client fetches the token same-origin from `GET /api/token`, so you never type it in.

Two more layers keep the app local-only:

- **Loopback bind** — the server listens on `127.0.0.1` exclusively (`server.listen(port, '127.0.0.1')`).
- **CORS allow-list** — only `localhost`, `127.0.0.1`, `tauri.localhost`, and `tauri://localhost` origins are accepted; anything else gets a `403`.

To rotate the token, stop the app, delete `~/.specrails/desktop.token`, and start again — a fresh token is generated.

---

## App settings

App settings apply across all projects. Open them from the **left sidebar → Settings**, or via the Command Palette (`Cmd/Ctrl+K`) → **Desktop Settings**. They are persisted in `~/.specrails/desktop.sqlite` under the `desktop_settings` key/value table.

The Global Settings page is organised into the sections below (it also surfaces a read-only **Registered Projects** list, an **Onboarding** replay button, and a **Desktop Information** diagnostics block, which carry no stored settings):

| Section | What it controls | Stored key / default |
|---------|------------------|----------------------|
| **Appearance** | App-wide UI theme. Five built-ins: `specrails` (default), `dracula`, `aurora-light`, `obsidian-dark`, `matrix`. | `ui_theme` = `specrails` |
| **Language** | App-wide UI language (hot-switch, no restart). Eight built-ins: `en`, `es`, `fr`, `de`, `pt`, `it`, `zh`, `ja`. | `ui_language` (unset = follow the OS language; only an explicit pick is persisted) |
| **Mobile Access** | Enable the mobile-companion gateway, pair/revoke devices, and rotate the device cert identity. | — (loopback + token still enforced server-side) |
| **specrails-tech** | Base URL for the external specrails-tech agents service. | `specrails_tech_url` = `http://localhost:3000` (the `SPECRAILS_TECH_URL` env var is only a fallback when this setting is unset — the stored setting wins) |
| **Budget & Alerts** | App-wide daily spend cap (queues auto-pause when exceeded) and a per-job cost alert threshold. | `desktop_daily_budget_usd`, `cost_alert_threshold_usd` (both unset by default = no cap / no alert) |
| **OS Notifications** | Desktop notification preferences for long-running jobs and budget events. | — |
| **Outbound Webhooks** | HTTP webhooks fired on `job.completed`, `job.failed`, `job.canceled`, `daily_budget_exceeded`, and `desktop_daily_budget_exceeded`. | webhooks table (a hook created without an explicit events list defaults to `["job.completed","job.failed","job.canceled"]`) |
| **Code section** | Plain-language file-summary language (`en` / `es`) and the monthly summary budget cap. | `summary_language` = `en`, `summary_monthly_budget_usd` = `5.00` |
| **Terminal Panel** | App-wide defaults for the integrated terminal (font, render mode, copy-on-select, shell integration, image rendering, long-command threshold). | `terminal.*` keys |

> There is **no** global provider-model setting. The default is the adapter
> default (`sonnet`, `gpt-5.5`, `gemini-3.5-flash`, or Kimi `k3`) resolved at
> spawn time. Kimi low/high/max effort is valid only for K3.

**Port is not a live setting.** `desktop_settings` does store a `port` value, but it is display-only. The port the server actually binds is taken from the `--port` argv (default `4200`); changing the stored value does not rebind a running server. Set the port with `--port <n>` on `specrails-desktop start`.

---

## Project settings

Project settings apply to a single project. Open them from the project's **Settings** entry in the right sidebar (route: `/settings`). The page is titled **Project Settings** and has these sections:

| Section | What it controls |
|---------|------------------|
| **Pipeline Telemetry** | Opt-in toggle that injects OpenTelemetry env vars into pipeline job spawns so they emit OTLP signals back to the app. Off by default. |
| **Rail Pre-prompt** | Text prepended to every rail launch for this project. |
| **Freestyle pre-prompt** | Text prepended to Freestyle-mode launches (Claude and Kimi advertise this autonomous rail mode). |
| **Budget** | Per-project daily spend cap (with queue auto-pause) and a per-job cost alert threshold. |
| **Terminal Settings** | Per-project overrides for the terminal panel defaults (project override → app default → built-in). |

> The project's **provider(s)** — **Claude, Codex, Gemini, Kimi, or any
> compatible combination** — are chosen when you add the project and are
> **immutable after creation**. All four are enabled by default; there is no
> provider switch in Project Settings.

---

## CLI

The `specrails-desktop` CLI is documented in full in [../cli.md](../cli.md). Quick reference:

### Global flags

These can appear in any position and are stripped before the command runs.

| Flag | Description | Default |
|------|-------------|---------|
| `--port <n>` | Connect to (or start) the app on port `<n>` | `4200` |
| `--project <name\|path>` | Target a specific registered project (by name or path) | auto-detect from `cwd` |
| `--version`, `-v` | Print the CLI version and exit | — |
| `--help`, `-h` | Print usage and exit | — |
| `--status` | Print server status and exit | — |

> Project auto-detection is an **exact canonical-path match** (`realpathSync(cwd)` compared against registered project paths). It does **not** walk up parent directories — running from a subdirectory of a registered project will not match. Use `--project` to target a project from anywhere.

### Server management

```bash
specrails-desktop start                  # Start the app server (daemonized)
specrails-desktop stop                   # Stop the app server
specrails-desktop list                   # List all registered projects
specrails-desktop add <path>             # Register a project by absolute path
specrails-desktop remove <project-id>    # Unregister a project by ID
```

### Running work

```bash
specrails-desktop implement "#42"                  # Queue /specrails:implement for spec #42
specrails-desktop batch-implement "#40" "#41" "#43"  # Queue one batch job over several specs
specrails-desktop "any raw prompt"                 # Pass a raw prompt straight to the AI CLI
specrails-desktop /specrails:health-check          # Pass any slash command directly
```

> **Always quote issue refs.** An unquoted `#` starts a shell comment, so `batch-implement #40 #41` silently drops the refs. Quote each one: `"#40" "#41"`.

**Known verbs** (automatically prefixed with `/specrails:`): `implement`, `batch-implement`, `why`, `get-backlog-specs`, `auto-propose-backlog-specs`, `propose-spec`, `refactor-recommender`, `health-check`, `compat-check`, `enrich`. Any other first argument is passed as a raw prompt.

### Port override example

```bash
specrails-desktop --port 5000 start
specrails-desktop --port 5000 implement "#42"
```

---

## Environment variables

A few env vars are read directly by the app. The two most useful operational ones:

| Variable | Description |
|----------|-------------|
| `SPECRAILS_TECH_URL` | Fallback specrails-tech base URL. Resolution order is the `specrails_tech_url` app setting **first**, then this env var, then `http://localhost:3000` — so a stored app setting takes precedence over this var. |
| `WM_ZOMBIE_TIMEOUT_MS` | Zombie-job detection timeout in milliseconds (default `1800000` = 30 min). This is a stuck-job watchdog, **not** a hard "kill after N minutes" cap. |

### Provider rollback gates

Both extra providers are **enabled by default** and only need these levers if you want to turn one off app-wide (an emergency rollback — no redeploy needed):

| Variable | Effect |
|----------|--------|
| `SPECRAILS_CODEX_BETA=0` | Disables the Codex provider (only the exact string `0` disables it; `1`/`true`/unset = enabled). The legacy name `SPECRAILS_HUB_CODEX_BETA` is honoured as a fallback when this is unset. |
| `SPECRAILS_GEMINI_BETA=0` | Disables the Gemini provider (only the exact string `0`). Unlike Codex, Gemini has **no legacy `SPECRAILS_HUB_*` fallback name**. |

A disabled provider stops appearing in Add Project and is rejected by the create-project API; existing projects that already use it are unaffected on disk.

Provider credentials are not stored by Desktop. Each CLI authenticates on its
own: Claude through its login/config, Codex via `codex login`, Gemini through
its native key/config, and Kimi via `kimi login` or user-managed
`~/.kimi-code/config.toml`. See [Kimi](../kimi.md), [Codex](../codex.md), and
[Gemini](../gemini.md).

For the full catalogue of feature flags and kill switches (`SPECRAILS_*` server gates, `VITE_FEATURE_*` client flags, `SPECRAILS_CODEX_BETA`, `SPECRAILS_GEMINI_BETA`, `SPECRAILS_EXPLORE_*`), see [../customizing.md](../customizing.md#environment-variables).

---

## `~/.specrails/` directory structure

```
~/.specrails/
  desktop.sqlite          # App-level SQLite: project registry + desktop_settings
  desktop.token           # Auto-generated API token (mode 0600)
  manager.pid             # PID of the running specrails-desktop server process
  desktop.log             # Server stdout/stderr (appended on each start)
  projects/
    <project-slug>/
      jobs.sqlite         # Per-project job history, invocations, telemetry pointers
      jobs/<jobId>/       # Per-job snapshots (profile.json, plugins.json) — chmod 400
      telemetry/          # OTEL blobs (<jobId>.ndjson.gz) when telemetry is on
      explore-cwd/        # App-managed cwd for Explore Spec turns
      terminals/          # Per-session shell-integration shim dirs
      codex-home/         # Per-project CODEX_HOME (Codex projects only)
      browser-profile/    # Persistent browser-capture profile
      attachments/        # Spec attachments, keyed by ticket
      user-mcp.json       # Materialised user-approved MCP config (chmod 600)
```

**Slug generation.** The slug is derived from the project directory name: lowercased, every run of non-alphanumeric characters collapsed to a single hyphen, and leading/trailing hyphens stripped. Example: `My App v2!` → `my-app-v2`.

**Backup.** To back up all app data, copy `~/.specrails/`. Your project source code lives in your repos, not here.

**Reset.** To clear project registrations and job history:

```bash
specrails-desktop stop
rm -rf ~/.specrails/desktop.sqlite ~/.specrails/projects/
```

> This leaves `desktop.token`, `manager.pid`, and `desktop.log` in place. For a full wipe (including the API token), `rm -rf ~/.specrails`. Either way, your project source and specrails-core installations are untouched.

---

## Further reading

- [Getting started](../getting-started.md) — user-facing install guide
- [Architecture](architecture.md) — server modules, data flow, WebSocket protocol
- [CLI reference](../cli.md) — every command and flag in detail
- [Customising the app](../customizing.md) — feature flags, env vars, keybindings
- [Codex](../codex.md) — using the Codex CLI provider
- [Gemini](../gemini.md) — using the Gemini CLI provider
- [Adding a provider](adding-a-provider.md) — wiring a new AI CLI adapter
