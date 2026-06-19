# Customising the app

Every setting you can change, grouped by where you'll find it.

## Themes

Open **Desktop Settings** (gear icon at the bottom of the Arc sidebar) → **Appearance**.

Five built-in themes:

| Theme | Vibe |
|-------|------|
| **SpecRails** *(default)* | Brand theme — deep navy-indigo with saturated cyan accents |
| **Dracula** | The original — dark purple-tinted with vivid neon accents |
| **Aurora Light** | Premium light — Linear-inspired indigo on warm off-white |
| **Obsidian Dark** | Premium dark — near-black blue-tinted with electric accents |
| **Matrix** | Phosphor terminal — soft mint on green-tinted near-black |

The selection is app-wide (one theme across all projects) and applies instantly:

- All UI components recolour live.
- The terminal panel reconfigures without losing scrollback or shell integration.
- Recharts charts in Analytics recolour live.
- Syntax-highlighted code blocks recolour live.

There's an inline anti-FOUC script in `client/index.html` so a page refresh never shows a flash of the wrong theme.

The active theme persists to `desktop_settings.ui_theme` on the server and mirrors to `localStorage` so the desktop app and browser stay in sync if you use both.

> Want a sixth theme? It's a small contribution — see `client/src/lib/themes.ts` and [internals/architecture.md](internals/architecture.md) for the contract.

## Sidebars

Both sidebars cycle through the same three states with their pin icon:

- **Pinned-open** — always wide.
- **Pinned-collapsed** — always a narrow strip of icons.
- **Unpinned** *(default)* — collapsed strip that expands on hover.

Keyboard shortcuts:

| Shortcut | Action |
|----------|--------|
| `Cmd+B` / `Ctrl+B` | Cycle the **right** project sidebar (Chat) |
| `⌥⌘B` / `Ctrl+Alt+B` | Cycle the **left** Arc sidebar |

State is per-machine (local UI preference, not synced).

> Press `?` anywhere for the full keyboard-shortcuts cheatsheet. `Cmd+K` / `Ctrl+K` opens the command palette; `Cmd+J` / `Ctrl+J` toggles the terminal panel.

## Per-project settings

Open **Settings** from the project navbar (top right of any project page).

### Budget

| Setting | Behaviour |
|---------|-----------|
| **Daily budget (USD)** | The queue auto-pauses when this project's spend for the current calendar day exceeds the cap. Blank = no cap. |
| **Per-job cost alert (USD)** | OS notification when a single job in this project exceeds this amount. Blank = disabled. |

The daily counter is the sum of completed-job cost since midnight, so it resets at the start of each calendar day. When the cap is hit you see a "Daily budget exceeded — spent $X of $Y. Queue is paused." banner on the project (plus a toast). Resume by raising or clearing the budget (and waiting for the next day if you've genuinely spent it).

### Rail pre-prompt

A custom instruction appended to every **Implement** and **Batch-implement** rail job, after the ticket context and before execution. Use it for stable project guidance that should accompany every rail run (e.g. "keep migrations backward compatible, add tests for every change"). Leave it blank for none.

### Ultracode pre-prompt

The instruction sent to Claude for **Ultracode** rails (Claude-only). Ultracode skips the OpenSpec pipeline — it hands Claude this pre-prompt plus the spec text and lets it implement autonomously. The spec text is appended automatically after the pre-prompt. Leave it blank to use the built-in default.

### Telemetry

Opt-in OpenTelemetry capture for rail runs.

| Setting | Behaviour |
|---------|-----------|
| **Enable pipeline telemetry** | Default OFF. When ON, every rail spawn gets OTLP env vars injected. Each rail's traces/metrics/logs are captured to a `.ndjson.gz` blob. |

When telemetry is on, the **Diagnostic ZIP** button appears on every job's detail page. The ZIP contains `job-metadata.json`, `telemetry.ndjson`, `logs.txt`, `summary.md`, and per-job snapshots of the agent profile and active plugins.

Retention: raw blobs > 7 days old are compacted at startup (file deleted, aggregates kept).

Scope: rails only. The sidebar chat, Explore, AI Edit, and the setup wizard are not instrumented (telemetry env injection happens only in the queue manager).

### Terminal panel

Hot-reload semantics: font family/size, copy-on-select, long-running command threshold, and notify-on-completion apply **live** to existing sessions on save. Render mode, shell integration, and image rendering apply on **the next spawned session**.

| Setting | Default | What it does |
|---------|---------|--------------|
| Font family | `'DM Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace` | Terminal font |
| Font size | 12 px | Cmd+= / Cmd+- live-zooms within a session |
| Copy on select | off | Auto-copy when text is selected |
| Render mode | auto | `auto` picks WebGL when available; falls back to canvas on context loss |
| Shell integration | on | Inject OSC 133 / 1337 shim per shell |
| Image rendering | on | Decode Sixel + iTerm2 inline images (`@xterm/addon-image`) |
| Long-running command threshold | 60 s | Trigger a notification after this duration |
| Notify on completion when unfocused | on | Emits a desktop notification when a long-running command finishes and the window isn't focused |

Project overrides win per-field; missing fields fall back to app defaults; missing app defaults fall back to built-ins.

See [terminal.md](terminal.md) for the full reference of keyboard shortcuts and shell integration.

## App-wide settings

Open **Desktop Settings** from the Arc sidebar. These apply across every project.

| Section | What it does |
|---------|--------------|
| **Appearance** | Theme picker — see above. |
| **Language** | UI language picker. Eight locales (English, Spanish, French, German, Portuguese, Italian, Chinese, Japanese). Hot-switches the whole app — no restart. First run follows your OS language until you pick one explicitly. |
| **Code section** | Defaults for the Code section: the plain-language file-summary language (English or Spanish) and a monthly summary budget cap in USD. Hidden when the Code section is disabled. |
| **Registered Projects** | The project registry. Re-resolve, rename, or remove projects. |
| **specrails-tech** | Base URL for the external specrails-tech agents service (default `http://localhost:3000`). |
| **Budget & Alerts** | App-wide daily budget (a global spend cap across all projects — queues auto-pause when exceeded) plus a per-job cost alert threshold. Distinct from the per-project budget. |
| **OS Notifications** | Native desktop notifications when jobs complete or fail. Notifications only fire when the tab isn't focused. Filter on all / completed-only / failed-only. |
| **Outbound Webhooks** | Notify external tools (Slack, Zapier, CI/CD) on app events. Requests are signed with `X-Specrails-Signature` when a secret is set. |
| **Terminal Panel** | The same terminal fields as per-project, applied app-wide as defaults. Per-project values override them. |
| **Onboarding** | Re-run the welcome tour. |
| **Desktop Information** | Version, paths, and diagnostics. |

## Authentication

There is no token to configure — the app manages it for you.

On first run the app generates a token and persists it to `~/.specrails/desktop.token` (mode `0600`). Every `/api/*` route requires it (the only exceptions are `/api/health` and `/api/token`), and WebSocket upgrades carry it as a subprotocol. The browser client fetches the token same-origin, so you never see it.

The app binds to `127.0.0.1` only, so it's never exposed to your network. To rotate the token, stop the app, delete `~/.specrails/desktop.token`, and start it again — a fresh token is generated on the next boot.

## Providers

The app works with **three interchangeable AI providers — Claude, Codex, and Gemini — all enabled by default.** When you add a project you pick which provider(s) to install (you can install any subset; the first one becomes the project's default). The engine pickers on Add Spec, the rail header, and the terminal's "Open AI CLI" button appear automatically whenever more than one provider is installed.

You normally don't configure anything here — providers are selected per project in the UI. The only knobs are the **emergency rollback** env vars below (one per provider), which force a provider back to "unavailable" without redeploying. See [codex.md](codex.md) and [gemini.md](gemini.md) for each provider's setup, auth, and limitations.

## Environment variables

Most settings live in the UI. A few app-level switches are env-only because they're guardrails ops people want to flip without opening the dashboard.

> **How values are read** (the rules differ by flag type):
> - **Section gates** (`SPECRAILS_*_SECTION`, `SPECRAILS_TERMINAL_PANEL`, `SPECRAILS_CODE_EXPLORER`, …) are ON unless set to the **exact string `false`**.
> - **Provider rollbacks** (`SPECRAILS_CODEX_BETA`, `SPECRAILS_GEMINI_BETA`) disable on the **exact string `0`** only — `false`/`off` do *not* disable them.
> - **Kill switches** (`SPECRAILS_SMASH`, `SPECRAILS_EXPLORE_CONTRACT_REFINE`) accept `0` / `false` / `off`.
> - **Opt-in hatches** (`SPECRAILS_EXPLORE_LEGACY_CWD`, `SPECRAILS_ALLOW_LOCAL_WEBHOOKS`) enable on the **exact string `1`**.

### Server-side (read at app startup or by spawned children)

| Variable | Effect |
|----------|--------|
| `SPECRAILS_CORE_BIN` | Override the `specrails-core` binary (default: `npx --yes --prefer-online specrails-core@^4.8.0` — the 4.8.0 floor is the release that ships the Gemini provider target) |
| `SPECRAILS_TECH_URL` | Override the specrails-tech proxy base URL |
| `SPECRAILS_AGENTS_SECTION=false` | Hide the Agents section from every project |
| `SPECRAILS_PLUGINS_SECTION=false` | Hide the Integrations section from every project |
| `SPECRAILS_JIRA_SECTION=false` | Hide the Jira integration and 404 its routes |
| `SPECRAILS_TERMINAL_PANEL=false` | Disable the bottom terminal panel everywhere |
| `SPECRAILS_CODE_EXPLORER=false` | Disable the Code section server-side |
| `SPECRAILS_INTERACTIVE_JOBS=false` | Reject the interactive-ultracode toggle and the per-job message/finalize routes |
| `SPECRAILS_BROWSER_CAPTURE=false` | Disable Add-Spec-from-browser capture |
| `SPECRAILS_CODEX_BETA=0` | Emergency rollback — disable the Codex provider (only the exact string `0`; the legacy `SPECRAILS_HUB_CODEX_BETA` is read as a fallback **only when `SPECRAILS_CODEX_BETA` is unset**) |
| `SPECRAILS_GEMINI_BETA=0` | Emergency rollback — disable the Gemini provider (default unset = enabled; only the exact string `0` disables; **no legacy fallback name**) |
| `SPECRAILS_SMASH=0` | Kill switch for SMASH spec decomposition (`0` / `false` / `off`; endpoints return 409) |
| `SPECRAILS_EXPLORE_CONTRACT_REFINE=0` | App-wide kill switch for Contract Refine (auto-fire + retry endpoint; accepts `0` / `false` / `off`) |
| `SPECRAILS_EXPLORE_LEGACY_CWD=1` | Force Explore spawns to use the project root instead of the app-managed `explore-cwd/` |
| `SPECRAILS_FILE_SUMMARY_MODEL` | Override the model used for Code-section file summaries. Per-provider overrides take precedence: `SPECRAILS_FILE_SUMMARY_MODEL_CLAUDE` (Claude) and `SPECRAILS_FILE_SUMMARY_MODEL_CODEX` (Codex); the generic var is the fallback |
| `SPECRAILS_ALLOW_LOCAL_WEBHOOKS=1` | Allow outbound webhooks to target loopback / private-network addresses |

### Client-side (Vite — set at build time)

These feature flags are **default ON**. Set the flag to `false` to hide the feature.

| Variable | Effect |
|----------|--------|
| `VITE_FEATURE_TERMINAL_PANEL=false` | Hide the bottom terminal panel |
| `VITE_FEATURE_AGENTS_SECTION=false` | Hide the Agents section |
| `VITE_FEATURE_CODE_EXPLORER=false` | Hide the Code section |
| `VITE_FEATURE_JIRA=false` | Hide the Jira integration UI (settings section + spec badges) |
| `VITE_FEATURE_INTERACTIVE_JOBS=false` | Hide the interactive-ultracode UI (rail "Interactive" toggle + in-job chat + Finalize) |
| `VITE_FEATURE_EXPLORE_REVIEW=false` | Disable the Review step in the Explore shell |
| `VITE_FEATURE_EXPLORE_PREMIUM_UX=false` | Disable the "Conectando…/Pensando…/Consultando código…" pills above the Explore streaming bubble |

> **Port:** the app doesn't read an env var for its port — use the `--port <n>` global flag: `specrails-desktop --port 5000 start`.

Set them in the shell that launches the app. Desktop app users can set them in their shell rc files since the desktop app inherits the launchd PATH and env.

> **Not env vars:** a few `SPECRAILS_*` names you might spot in the source are *not* settings you can flip. `SPECRAILS_DIR` is a code constant; `SPECRAILS_PROFILE_PATH`, `SPECRAILS_PLUGINS_ACTIVE`, and `SPECRAILS_PLUGINS_SNAPSHOT` are values the app injects *into* the AI CLI it spawns. Setting them yourself has no effect. The desktop-only `SPECRAILS_IS_DESKTOP` / `SPECRAILS_BUNDLED_RUNTIMES_PATH` are set by the packaged app, never by you.

## Resetting the app

To wipe all app state (project registry, settings, theme) but keep your project source code intact:

```bash
specrails-desktop stop
rm -rf ~/.specrails/desktop.sqlite* ~/.specrails/projects/
specrails-desktop start
```

The `desktop.sqlite*` glob also removes the SQLite WAL/SHM sidecars. This deletes the project registry and every per-project SQLite. Your project directories on disk and their `.specrails/` folders (specs, profiles, plugins) are untouched. `desktop.token` and `manager.pid` regenerate harmlessly on the next start.

For a more surgical reset (e.g. clear job history for one project but keep the registration), see [internals/operations-runbook.md](internals/operations-runbook.md).

## Backup

Everything the app knows is in `~/.specrails/`. Back it up:

```bash
tar -czf specrails-backup-$(date +%F).tar.gz -C ~ .specrails
```

Restore by extracting the archive in `~/`.

Per-project specs, profiles, and plugins live in your project directories (`<project>/.specrails/`), so they ride along with `git`.

## Where to go next

- [Tracking cost](tracking-cost.md) — set a daily budget so you can stop checking the bill.
- [Terminal panel](terminal.md) — fine-tune the bottom panel.
- [Operations runbook](internals/operations-runbook.md) — port conflicts, stale PID files, recovery procedures.
