# Operations Runbook

Common operational procedures for running, recovering, and updating specrails-desktop. Everything here is verified against the shipped code. The app binds to `127.0.0.1` only.

For the full data-directory layout, every CLI flag, env vars, and app/project settings, see [Configuration](configuration.md).

## Starting the app

```bash
# Start the app server (daemonized — it detaches and returns once ready)
specrails-desktop start

# Start on a non-default port (the --port flag may appear in any position)
specrails-desktop --port 5000 start
```

`start` daemonizes the server, which then writes its own PID to `~/.specrails/manager.pid` and appends its stdout/stderr to `~/.specrails/desktop.log`. The default port is `4200`.

## Stopping the app

```bash
specrails-desktop stop
```

`stop` reads the PID file and sends `SIGTERM`. If the PID file is stale (no such process), it prints `[specrails-desktop] server is not running (stale pid file)` and removes the file for you — so you rarely need to delete `manager.pid` by hand.

## Status / health check

The first thing to run when something looks wrong:

```bash
# Is the app up? On what URL/PID? How many projects?
specrails-desktop status

# Same, against a custom port
specrails-desktop --port 5000 status

# Terser manager status (script-friendly probe)
specrails-desktop --status
```

The two forms print different output. The `status` **subcommand** prints `server: running (pid <n>) on http://127.0.0.1:<port>`, the project count, and each project name. The `--status` **flag** prints a shorter `manager: running (v<version>)` / `mode: super` / `projects: <count>` block (no PID, no project names) — handy as a scripted up/down probe. Both exit non-zero when the app is not running.

> `specrails-desktop --jobs` is **not** functional against the running server — the server does not expose a cross-project `/api/jobs` route, so the command prints a message that jobs history requires a manager with SQLite persistence and exits `1`. Browse job history per project in the app's **Jobs** page instead.

> **Offline CLI fallback.** When you run a command and no manager is up, the CLI prints `manager not running — invoking claude directly` and spawns a local `claude` process to handle it. This fallback **always uses `claude`** — it never spawns `codex`, `gemini`, or `kimi`, regardless of a project's primary provider — and it writes **nothing** to Analytics (no `ai_invocations` row; cost/tokens are only echoed to your terminal). Start the manager (`specrails-desktop start`) to route through your project's real provider and capture the run.

## App data location

All app data lives under `~/.specrails/` (the path is hardcoded to your home directory — there is no override env var):

```
~/.specrails/
  desktop.sqlite    # App-level SQLite: project registry + desktop_settings
  desktop.token     # Auto-generated API token (mode 0600)
  manager.pid       # PID of the running server (removed on a clean stop)
  desktop.log       # Server stdout/stderr (appended on each start)
  projects/
    <slug>/
      jobs.sqlite   # Per-project job history, invocations, telemetry pointers
```

See [Configuration](configuration.md#specrails-directory-structure) for the complete per-project subtree (telemetry blobs, explore-cwd, terminals, attachments, etc.) and how the `<slug>` is derived.

> **Auth token caveat.** `~/.specrails/desktop.token` gates every `/api/*` request and WebSocket upgrade, except the two public bootstrap routes (`GET /api/health` and `GET /api/token`) that `requireAuth` is mounted after, so the local client can fetch its token. Deleting the token file (or doing a full `rm -rf ~/.specrails`) regenerates a fresh token on the next start, which can leave an already-open browser tab or CLI on the old token — reload the app after a token reset. See [Configuration → Authentication](configuration.md#authentication).

## Log files

The app already daemonizes and writes its output to `~/.specrails/desktop.log` on every `start` — you do not need to redirect anything yourself.

```bash
# Follow the live log
tail -f ~/.specrails/desktop.log

# Show the last 200 lines
tail -n 200 ~/.specrails/desktop.log
```

The log file is opened in append mode, so it accumulates across restarts. Truncate or rotate it manually if it grows large.

## Backups

To back up all app data, copy the whole directory while the app is stopped:

```bash
specrails-desktop stop
cp -r ~/.specrails/ ~/specrails-backup-$(date +%Y%m%d)/
```

Your project source code and each project's `.specrails/` folder (specs, profiles, plugins) live in your repos, not here — they are not part of this backup.

## Troubleshooting

### Port already in use

```bash
# Find the process bound to the port (use your custom port if not 4200)
lsof -i :4200

# Stop the app cleanly
specrails-desktop stop

# Last resort: kill by recorded PID
kill "$(cat ~/.specrails/manager.pid)"
```

If you run the app on a custom port, point `lsof` and `status` at that port (`--port <n>`).

### Server won't start after a crash

A clean `stop` already clears a stale PID file. If a crash left one behind and `start` still refuses:

```bash
rm ~/.specrails/manager.pid
specrails-desktop start
```

### Registry database reset (loses project registrations)

> **Warning:** `desktop.sqlite` is the project registry *and* the app-settings store. Deleting it unregisters **every** project and resets all app settings. Your project source and each project's specrails-core install are untouched, but you must re-add each project afterward.

```bash
# Back up first, then reset
cp ~/.specrails/desktop.sqlite ~/.specrails/desktop.sqlite.bak
specrails-desktop stop
rm -f ~/.specrails/desktop.sqlite*   # the * also removes the write-ahead-log sidecar files (desktop.sqlite-wal, desktop.sqlite-shm)
specrails-desktop start              # re-creates an empty registry

# Re-register each project
specrails-desktop add /path/to/project-a
specrails-desktop add /path/to/project-b
```

### Disable a misbehaving provider or feature (recovery levers)

If a single provider or feature is breaking the app, you can turn it off with an environment variable and restart — no reinstall, no data loss. Set the var in the environment the server starts in, then `specrails-desktop stop && specrails-desktop start`.

- **Disable a provider** (it disappears from Add Project / engine pickers): `SPECRAILS_CODEX_BETA=0` or `SPECRAILS_GEMINI_BETA=0`. Both are enabled by default and only the **exact string `0`** disables them (`1` / `true` / unset all keep the provider on).
- **Disable a spec-enrichment feature**: `SPECRAILS_EXPLORE_CONTRACT_REFINE` (Contract Refine) and `SPECRAILS_SMASH` (SMASH) are kill switches that turn off on `0`, `false`, or `off`.

These are the most common ops escape hatches; see [Configuration → Environment variables](configuration.md#environment-variables) for the complete list of gates and flags.

### Per-project reset (keeps the registration)

To clear one project's job history, invocations, and telemetry pointers while keeping it registered, delete just that project's `jobs.sqlite` with the app stopped:

```bash
specrails-desktop stop
rm -f ~/.specrails/projects/<slug>/jobs.sqlite*
specrails-desktop start
```

The `<slug>` matches the project's directory name, lowercased with non-alphanumeric runs collapsed to hyphens (e.g. `My App v2!` → `my-app-v2`). The project's registration in `desktop.sqlite` and its on-disk `.specrails/` assets are left intact; the per-project DB is re-created empty on next start.

## Updates

For an npm-installed server:

```bash
npm update -g specrails-desktop
specrails-desktop stop && specrails-desktop start
```

The desktop app self-updates via Tauri's passive updater — no manual step needed.

## Desktop app

These commands require the **Rust toolchain** and `@tauri-apps/cli` (a devDependency), in addition to a checked-out repo with both `npm install` trees (root + `client/`).

### Development

```bash
npm run dev:desktop
```

Runs `tauri dev` — a hot-reloading desktop window backed by the dev server.

### Production build

```bash
npm run build:desktop
```

This single script chains the full pipeline: `build:server` → client build → `build:sidecar` → `tauri build`. There is **no** `npm run tauri` script — `npm run tauri dev` / `npm run tauri build` fail with `Missing script: tauri`.

The macOS build is signed + notarized. The Windows x64 and arm64 builds ship **unsigned** in v1 (users see a SmartScreen warning → "More info → Run anyway"). See [Windows](../platforms/windows.md) and [macOS](../platforms/macos.md) for platform specifics.

### Build the server sidecar only

```bash
npm run build:sidecar
```

Bundles the Express server (and the `node-pty` native module) into the standalone sidecar that Tauri ships. `build:desktop` runs this for you; run it on its own only when iterating on server code for a desktop build.

### Regenerate app icons

```bash
npm run generate-icons
```

Regenerates every icon size (PNG/ICNS/ICO) from `src-tauri/icons/icon.svg` via `tauri icon`. Requires the Rust toolchain + `@tauri-apps/cli`. Run after any icon design change.

## Further reading

- [Configuration](configuration.md) — full data layout, app/project settings, auth token, env vars
- [CLI reference](../cli.md) — every command and flag in detail
- [Architecture](architecture.md) — server modules, data flow, WebSocket protocol
- [macOS](../platforms/macos.md) · [Windows](../platforms/windows.md) — platform-specific operations
