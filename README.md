<div align="center">

# 🚄 specrails-desktop

### The local cockpit for shipping software with AI agents

**Shape work with Claude, Codex, Gemini, or Kimi → drag specs onto execution rails → watch the pipeline ship — all from one window, on your laptop.**

[![npm version](https://img.shields.io/npm/v/specrails-desktop?color=4f46e5&label=npm&logo=npm&logoColor=white&style=flat-square)](https://www.npmjs.com/package/specrails-desktop)
[![license](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white&style=flat-square)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black&style=flat-square)](https://react.dev)
[![Desktop](https://img.shields.io/badge/Desktop-Tauri-ffc131?logo=tauri&logoColor=black&style=flat-square)](https://tauri.app)
[![providers](https://img.shields.io/badge/agents-Claude%20%2B%20Codex%20%2B%20Gemini%20%2B%20Kimi-ff7a59?style=flat-square)](#-bring-your-own-agent)

[Quick start](#-quick-start) · [Features](#-what-you-can-do) · [Architecture](#%EF%B8%8F-how-its-built) · [Docs](#-documentation) · [Desktop app](#%EF%B8%8F-desktop-app)

</div>

---

## 🌟 What is this?

**Specrails Desktop** (`specrails-desktop`) turns *"I'll just let the AI do it"* into a workflow you can **see, steer, and trust**. It's the desktop app for specrails — a local-first dashboard and CLI that sits on top of [**specrails-core**](https://github.com/fjpulidop/specrails-core) and gives you **one window for all your projects**:

- 💬 Shape a spec in conversation with an AI, or generate one in a single shot.
- 🛤️ Drag specs onto **execution rails**, pick a **Loop** to run (built-in or your own), and ship — rails run in parallel inside a git-backed project, each isolated in its own worktree.
- 🤖 Watch the **Architect → Developer → Reviewer → Ship** pipeline stream live — and **talk to the running job**: ask questions or steer it mid-run from the built-in composer.
- 💰 See available **cost and activity metrics** this week, per provider and
  ticket; missing native usage (notably Kimi tokens/USD) stays visibly
  unavailable.

> 🔒 **100% local. Single user. No accounts. No telemetry leaves your machine.**
> Your code stays on your laptop — nothing moves unless **you** spawn an agent against it.

---

## ✨ What you can do

### 📝 Turn ideas into specs

| | |
|---|---|
| 🗣️ **Explore** | Describe what you want in a chat; a **live draft** rebuilds itself every turn. Save it as a *draft ticket* and resume later, or commit when it looks right. First-token latency is tuned to feel electric. |
| ⚡ **Quick** | Already know what you want? Generate a full spec in one shot — optionally enriched with a **Contract Layer** of exact names, data shapes, invariants, and a file-touch list when the selected provider can enforce the transform's no-tools boundary. Kimi intentionally fails closed for both Quick Spec and Contract Refine; use Explore or the Quick Launcher command instead. |
| 🌐 **From a website** | *Add Spec → From a website* opens an **embedded browser**. Navigate, hover-select an element or drag a rectangle, and the screenshot + DOM + applied CSS become attachments. The desktop build ships its own Chromium, so it works **offline**. |
| 💥 **SMASH** | Explode a big epic into a family of sub-specs in one click — children carry short summaries on their cards. This structured transform is unavailable for Kimi. |
| 🔁 **Continue Editing** | Reopen any draft / todo / backlog spec back in Explore, resuming the original conversation if there was one. Provider-specific AI Edit remains capability-gated; it is unavailable for Kimi. |
| 🪟 **Compare** | Drag a spec modal to the screen edge → a picker of your todo specs slides in on the other side. Pick one and review them **side by side**, tablet-style. |

### 🚀 Run the pipeline

| | |
|---|---|
| 🛤️ **Execution rails** | Each rail is an independent lane. Drag specs in, **pick a Loop**, and press Play. In git-backed projects, rails run in parallel inside isolated per-spec worktrees, so several lanes can build at once without touching your active working tree. Each rail carries its own **agent profile** and provider. |
| 🔁 **Loops** | A global, visual **Loop Builder** (n8n-style). The built-in loops — **Implement**, **Batch**, **Freestyle** — are what a rail runs by default, or build your own by chaining AI and shell steps. Providers with a safe pure-output boundary can also use a **Loop Decider** to repeat until a goal is met; Kimi runs loops that do not contain a Decider. See [Running pipelines](docs/running-pipelines.md). |
| 🧩 **Agent profiles** | A per-project, declarative catalog that tells the implement pipeline which agents to run and at what model — snapshotted per job so concurrent rails stay isolated. |
| 🔀 **Safe PR delivery (ask-first)** | Fresh work runs in an isolated **git worktree** off your designated integration branch (set it in *Settings → Integration branch*). When it finishes, nothing is pushed and no PR exists yet — the specs move to **On Review** and the app **asks you first**: **Create PR** (one combined draft PR across all the specs on the rail) or **Discard** (clean up, specs back to the backlog). If you relaunch a spec that is already in review with an open PR, specrails detects that active PR and continues its head branch instead of starting from the integration branch again. After a PR exists you can **Publish** (open the draft for your team's review) and **Check merge** — once your team merges it in GitHub, the specs flip to Done. specrails **never merges and never touches your working tree**. Projects without git degrade to shared-folder execution with no branch or PR card. Set `SPECRAILS_RAIL_DELIVER_PR=0` to fall back to local integration. |
| 📡 **Live job detail** | A premium ticket-identity header, live duration ticker, incremental turns/tokens, and authoritative cost on exit. Every Claude job is a **live session**: a chat composer on the job view lets you ask the running agent questions or steer it mid-run — messages queue while it streams, and the job still finishes its plan (Freestyle waits for your explicit **Finalize**; everything else wraps up on its own). |
| 🔌 **Plugins** | A per-project marketplace of MCP-based integrations (**Serena** semantic code-nav bundled today). Additive by design — installing plugin N+1 never disturbs plugin N. |

### 💸 Track every cent

| | |
|---|---|
| 📊 **Analytics** | Every AI invocation that actually runs is recorded for **Claude, Codex, Gemini, and Kimi**. Burn-rate hero, daily timeline, top tickets, model breakdown, cost-vs-turns scatter. Capability-gated Kimi actions that fail before spawn do not create an invocation. |
| 🧮 **Honest numbers** | Claude cost is provider-billed; **Codex and Gemini costs are estimated** from a local rate-card and clearly flagged with a `~`. Kimi's stream exposes no authoritative token or USD-cost envelope, so those fields remain unavailable rather than appearing as zero. |
| 📤 **Exports** | One-click CSV/JSON, plus per-ticket spending deep-links. |

### 🛠️ Make it yours

| | |
|---|---|
| 🖥️ **Terminal panel** | A real VS-Code-style bottom panel (`Cmd/Ctrl+J`) powered by `node-pty` + xterm.js — WebGL rendering, search, ligatures, image inline, drag-drop paths, and OSC 133 shell integration. |
| 🎨 **Themes** | Five built-ins — `specrails` (default), `dracula`, `aurora-light`, `obsidian-dark`, `matrix` — applied before React hydrates (no flash). |
| 🧭 **Code explorer** | A non-developer-friendly file tree + Monaco viewer with plain-language AI summaries and *"touched by AI"* provenance chips where the provider supports that safe transform, plus opt-in **in-app editing of existing files** (overwrite-only — no create/rename, blocks binaries, respects the deny-list/`.gitignore` and a size cap). Kimi file summaries and construction-story AI are disabled. |
| 💬 **Minimizable chats** | Park an Explore or AI-Edit session into a dock chip and pick it back up later — never lost across refreshes or project switches. |

---

## 🤖 Bring your own agent

specrails-desktop registers **Claude Code**, **Codex CLI**, **Gemini CLI**, and **Kimi Code** as first-class providers through a shared `ProviderAdapter` contract. All four are enabled by default; each adapter advertises its real capabilities, so unsupported safety-sensitive actions fail closed instead of silently weakening their policy.

| | 🟣 Claude Code | 🟢 Codex CLI | 🔵 Gemini CLI | 🌙 Kimi Code |
|---|:---:|:---:|:---:|:---:|
| Minimum CLI version | none pinned | 0.128.0 | 0.11.0 | 0.27.0 |
| Native streaming | ✅ | ✅ | ✅ | ✅ JSONL |
| Native session resume | ✅ | ✅ | ✅ | ✅ after resume hint |
| Native cost reporting | ✅ | ⚠️ estimated via rate-card | ⚠️ estimated via rate-card | — unavailable |
| Native OTEL telemetry | ✅ | 🔧 synthesized by the app | ✅ native | — unavailable |
| Agent profiles on rails | ✅ | — *(forced legacy)* | — *(forced legacy)* | ✅ |

A project's **provider set** is chosen at install (one or more of Claude / Codex / Gemini / Kimi) and is **immutable afterward**; the per-invocation **engine** is picked from that set on capability-compatible surfaces whenever more than one is installed. To disable Gemini (emergency rollback) set `SPECRAILS_GEMINI_BETA=0`; for Codex it's `SPECRAILS_CODEX_BETA=0` (only the exact string `0` disables either).

Kimi is an **external CLI integration**: Desktop detects and spawns the user's authenticated `kimi` executable with `-p --output-format stream-json`. It neither bundles Kimi nor starts `kimi server`/`kimi acp`. See [Using Kimi](docs/kimi.md) for installation, the complete capability matrix, and the deliberate safety gates.

---

## 🖼️ How it looks

```
┌──────────┬───────────────────────────────────────────────────┐
│          │  Dashboard · Jobs · Analytics · Agents · ⚙        │
│   Arc    │ ──────────────────────────────────────────────── │
│  side-   │                                                   │
│   bar    │   📋 SpecsBoard          │   🛤️  Rails             │
│          │   (your specs)          │   (execution lanes)     │
│ projects │                         │                         │
│  ● proj  │   #1  Login flow ●      │   ▶ Rail 1   #1 #2     │
│  ○ proj  │   #2  Webhook retry     │     [profile: default]  │
│          │   #3  Cost limits  ●    │                         │
│  ➕ Add   │   #4  Draft idea  ✎     │   ▶ Rail 2   running    │
│          │                         │     [profile: budget]   │
│   ⚙      │                         │                         │
└──────────┴───────────────────────────────────────────────────┘
                 ⌨️  Terminal panel  (Cmd/Ctrl + J)
```

---

## 🚀 Quick start

```bash
# 1️⃣  Install
npm install -g specrails-desktop

# 2️⃣  Start the app
specrails-desktop start

# 3️⃣  Add a project from the CLI…
specrails-desktop add /path/to/your/project

# …or click “➕ Add project” in the dashboard sidebar at
#   http://127.0.0.1:4200
```

If a project doesn't have specrails-core yet, a **3-step setup wizard** (Configure → Install → Done) installs it for you — one flow, no tier picker, ~1 minute on a warm cache.

> 💡 **Prefer a desktop app?** Grab a signed macOS or Windows build — see [Desktop app](#%EF%B8%8F-desktop-app). It bundles the server, so there's no separate `start`.

### 🧑‍💻 The `specrails-desktop` CLI

```bash
specrails-desktop start | stop | add | remove | list   # manage the app
specrails-desktop implement #42                         # run a specrails verb
specrails-desktop --status                              # manager status
specrails-desktop --project <name|path>                 # target a project
specrails-desktop --help                                # full reference
```

When the app is running, the CLI talks to it over HTTP + WebSocket; when it isn't, it spawns the agent directly — note the offline path always runs `claude` (even for Codex/Gemini/Kimi projects) and records nothing to Analytics. Either way you get streamed logs. (Job history lives in the dashboard **Jobs** page, per project.)

---

## 📦 Prerequisites

- 🟩 **Node.js 20+**
- 🤖 **At least one AI CLI** on your `PATH`:
  - **[Claude Code](https://claude.com/claude-code)** — the `claude` binary, signed in (via Claude subscription login or an `ANTHROPIC_API_KEY`). No minimum version pinned.
  - **[Codex CLI](https://developers.openai.com/codex)** ≥ 0.128.0 — the `codex` binary. Run `codex login` or set `OPENAI_API_KEY`.
  - **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** ≥ 0.11.0 — the `gemini` binary, authenticated (set `GEMINI_API_KEY`).
  - **[Kimi Code](docs/kimi.md)** ≥ 0.27.0 — the external `kimi` binary, authenticated with `kimi login`. The npm distribution needs Node.js ≥ 22.19; Windows also needs Git Bash.
- 🌿 **git** — required for isolated worktrees, branch-based resume, and PR delivery. Non-git projects still run in shared-folder mode, but no branch or PR card is created.
- 🔀 *(optional but recommended)* **GitHub CLI (`gh`)** authenticated — required when you want Specrails to create, publish, check, or continue GitHub pull requests for rail deliveries.
- 🧪 *(optional)* **`uv`** — only if you want the Serena plugin
- 📦 **specrails-core** ≥ 4.12.0 in the project *(the wizard installs it)* — the shared floor that includes the Kimi `.kimi-code` framework target.

A project's **provider set** is chosen at install time (one or more of Claude / Codex / Gemini / Kimi) and is immutable afterward — you pick a compatible engine per invocation from that set. On macOS the desktop app resolves Homebrew/Volta/nvm paths for you.

---

## 🏗️ How it's built

A clean **three-layer TypeScript monorepo** — one Express process runs in *Super mode* and manages every project.

```
🗄️  server/   Express 5 + WebSocket + SQLite (better-sqlite3)   · the brain
🎨  client/   React 19 + Vite + Tailwind v4                      · the dashboard
⌨️  cli/      specrails-desktop command bridge                   · the terminal door
```

```
~/.specrails/
├── desktop.sqlite                   # project registry
├── manager.pid                      # running server PID
└── projects/<slug>/
    ├── jobs.sqlite                  # per-project DB (jobs, analytics, chats)
    └── …                            # snapshots, telemetry, terminals, summaries
```

**Highlights under the hood:**

- 🔗 **One WebSocket** multiplexes everything; every project-scoped message carries a `projectId`, injected by a `boundBroadcast` closure — managers need zero changes.
- 🧱 **Per-project isolation** — each project gets its own SQLite, queue manager, and chat manager.
- 🖥️ **Terminals** stream over a *dedicated* WebSocket so PTY throughput can't starve the event stream.
- 🌐 **Embedded browser** via Playwright (CDP capture) for the *"From a website"* flow.
- 📦 **Desktop** via Tauri, with optionally-bundled Node, Git, and Chromium runtimes so it runs fully offline.

> 📖 Want the deep dive? CLAUDE.md and [`docs/internals/`](docs/internals/) document the adapter contract, REST surface, migrations, and the OpenSpec workflow.

---

## 🛠️ Development

```bash
git clone https://github.com/fjpulidop/specrails-desktop.git
cd specrails-desktop
npm install                        # root deps (server + CLI)
cd client && npm install && cd ..  # client deps (separate tree)
npm run dev                        # 🚀 server :4200 + client :4201, hot reload
```

| Script | What it does |
|--------|--------------|
| `npm run dev` | Server (4200) + client (4201) with hot reload |
| `npm run dev:desktop` | Desktop app (Tauri) in dev mode |
| `npm run build` | Production build (server + client + CLI) |
| `npm test` | Vitest suite (server + CLI) + core-compat check |
| `npm run test:coverage` | Server coverage (mirrors the CI gate) |
| `npm run test:client` | Client Vitest suite |
| `npm run ci` | Everything CI runs: typecheck + tests + both coverage gates |

🛡️ **Coverage is a hard gate** — **70 % global**, **80 % server**, **80 % client**. Local runs must clear the same bars before pushing.

- 🌍 `4200` — Express API + WebSocket
- ⚡ `4201` — Vite dev server (proxies `/api` and `/hooks` to 4200)

---

## 🖥️ Desktop app

Desktop builds for **macOS (Apple Silicon)**, **Windows (x64)**, and **Windows (arm64)** are published at:

> 📥 `https://specrails.dev/downloads/specrails-desktop/latest/`

The macOS build is **signed + notarized**. The Windows installers are **unsigned in v1** — SmartScreen flags them, so click **More info → Run anyway**. (Authenticode signing is a planned follow-up.)

`npm run build:desktop` produces the `.app` / `.dmg` / `.exe`, but does **not** assemble the bundled runtimes — that app falls back to your system PATH and downloads a Playwright Chromium on first use. To build a self-contained app the way CI does (**macOS arm64 only**):

```bash
# Bundle Node 22 + a relocatable Git, then build
npm run build:desktop:local

# …and bundle Chromium too, so "Add Spec from a website" works fully offline
# (one-time ~150 MB Playwright Chromium download)
BUNDLE_CHROMIUM=true npm run build:desktop:local
```

> ℹ️ Local builds are **unsigned** — Gatekeeper warns; right-click → Open, or `xattr -dr com.apple.quarantine <App>.app`. Signed + notarized installers come only from the `desktop-release` CI workflow.

---

## 🔒 Security model

- 🏠 Binds to `127.0.0.1` only — **do not expose to a network**.
- 🔑 An app token is **auto-generated on first run** and persisted to `~/.specrails/desktop.token` (mode `0600`). Every `/api/*` route requires it (except `/api/health` and `/api/token`), and WebSocket upgrades carry it as a subprotocol. The browser client fetches it same-origin — there's nothing to configure.
- 🧷 Parameterised SQL everywhere — never string-interpolated.
- 🧬 Reserved files in your project (`.mcp.json`, `.specrails/plugins/state.json`, `.specrails/profiles/.user-preferred.json`) are mutated **surgically** — read → modify only owned keys → atomic temp+rename — so adding plugin N+1 never disturbs plugin N.

---

## 📚 Documentation

**User guides**

| Guide | What it covers |
|-------|----------------|
| 🏁 [Getting started](docs/getting-started.md) | Install, register a project, run your first pipeline |
| 📝 [Creating specs](docs/creating-specs.md) | Quick vs Explore, drafts, SMASH, Compare, Continue Editing |
| 🚀 [Running pipelines](docs/running-pipelines.md) | Rails, jobs, agent profiles, plugins |
| 💰 [Tracking cost](docs/tracking-cost.md) | Analytics, exports, per-ticket spending |
| 🎨 [Customising the app](docs/customizing.md) | Themes, settings, telemetry, kill switches |
| ⌨️ [Terminal panel](docs/terminal.md) | Shortcuts, shell integration, drag-and-drop |
| 🧑‍💻 [CLI reference](docs/cli.md) | Every command grouped by task |
| 🟢 [Codex notes](docs/codex.md) | Auth, sandbox, estimated-cost caveats, rollback |
| 🔵 [Gemini notes](docs/gemini.md) | Auth, models, estimated-cost caveats, rollback |
| 🌙 [Kimi notes](docs/kimi.md) | External CLI setup, `-p` execution, capabilities, models/effort, and safety gates |

**Platform notes** — 🍎 [macOS](docs/platforms/macos.md) · 🪟 [Windows](docs/platforms/windows.md)

**Extending** — 🧩 [`docs/internals/`](docs/internals/): architecture, REST reference, ops runbook, adding a provider.

---

## ☕ Support

If specrails-desktop saves you time, you can buy me a coffee on **Ko-fi** — it funds the open-source ecosystem. 💜

[![Donate on Ko-fi](https://img.shields.io/badge/Donate-Ko--fi-FF5E5B?logo=kofi&logoColor=white&style=flat-square)](https://ko-fi.com/D1D81Y002C)

---

## 📄 License

[MIT](LICENSE) © [Javier Pulido](https://github.com/fjpulidop)

<div align="center">
<sub>Built with TypeScript, React, Express & a lot of ☕ — and shipped by the agents it orchestrates. 🚄</sub>
</div>
