# Specrails Desktop

[![CI](https://github.com/fjpulidop/specrails-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/fjpulidop/specrails-desktop/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/specrails-desktop.svg)](https://www.npmjs.com/package/specrails-desktop)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Specrails Desktop is a local application for turning software specifications into reviewed implementations. Use a mission conversation to explore and direct work, or organize specs on a board and run them through built-in or custom loops. The app coordinates your installed AI CLIs, Git worktrees, project context and delivery decisions.

[specrails-core](https://github.com/fjpulidop/specrails-core) supplies the provider workflows and agents. Desktop adds the interface, execution lifecycle, history and project management.

This README describes the current source tree. Published packages do not include unmerged changes; check the [release notes](https://github.com/fjpulidop/specrails-desktop/releases) for the features in your installed version.

## Start using Specrails

Choose one way to run the app. The native application and npm server both use the local backend; do not start them together on the same port.

### Native application

Get an installer from the [official releases](https://github.com/fjpulidop/specrails-desktop/releases). The release pipeline targets macOS Apple Silicon and Windows x64/ARM64. Select an artifact actually present in the release, and check its release notes and platform requirements.

Launch Specrails, install and authenticate at least one supported AI CLI, then add a project. The setup flow checks prerequisites and installs the project's Core artifacts. Provider CLIs and their authentication are separate from the app; they are not bundled model services.

The native application provides separate mission windows and OS webviews: WebView2 on Windows and WebKit on macOS. See the [Windows validation matrix](docs/platforms/windows-parity.md) for automated coverage and remaining platform acceptance.

### npm application in your browser

Requires Node.js **20.19.0+**, Git and an authenticated provider CLI. Use a current Node 22 release if your provider CLI requires a newer runtime.

```sh
npm install -g specrails-desktop
specrails-desktop start
specrails-desktop add /absolute/path/to/project
```

Open [http://127.0.0.1:4200](http://127.0.0.1:4200). This distribution serves the web interface; installing it does not install the native Tauri application or enable native mission windows.

```sh
specrails-desktop list
specrails-desktop --status
specrails-desktop --help
specrails-desktop stop
```

The CLI also forwards workflow commands to a running server. Its legacy direct fallback runs **Claude** when the server is unavailable and does not record Desktop analytics. Use the running app for provider selection and managed execution.

## Working with projects and specs

| Area | What the current source supports |
| --- | --- |
| Specs | Explore an idea in conversation, generate a Quick Spec, refine its contract, or capture a website as context. Structured AI actions are offered only when the provider supports their required tool restrictions. |
| Missions | Converse with an agent using project, spec and file references. Follow-ups queue by default; explicit **Steer** sends a correction into a running invocation through its supported transport. Delivery and read acknowledgements remain distinct. |
| Board and rails | Assign specs to execution lanes and select Implement, Batch Implement, SDD Quick, Freestyle or a published custom loop, subject to provider capabilities. Inspect live steps, errors and retry state. |
| Multiple repositories | One project owns a shared backlog and can include several local repositories. Specs select their affected repositories; execution prepares their worktrees together and presents delivery evidence and actions per repository. |
| Review and delivery | Inspect recorded changes, create or publish a PR, integrate locally, or check out completed work. Conflicts and stale evidence require resolution; a multi-repo spec completes only when all required deliveries are accepted. |
| Files | Browse and search by repository, jump to lines, read source, inspect recorded diffs and construction history, and request an AI summary. This is a read-only explorer, not an editor. |
| Processes and metrics | Use the integrated terminal and inspect retained background-process logs. Track invocation activity and available usage; estimated costs are labelled and unavailable usage is not shown as zero. |

Additional folders can be added to an existing project in **Project settings → General → Repositories and folders**. Reading a repository does not grant it implementation scope. Secondary folders without Git provide context but cannot be additional implementation targets. See [multi-repository projects](docs/multi-repo-projects.md).

In the native app, the mission header can move a conversation into its own window and reintegrate it. The agent continues in the same backend. Draft and workspace handoffs require acknowledgement; closing a mission window reintegrates it, while closing main hides it to the tray. Quitting the application is a separate shutdown operation. See [detachable mission windows](docs/features/detachable-mission-windows.md).

Native mission browsing retains the actual WebKit/WebView2 session, including history and authentication popups. Website-to-spec capture and the browser fallback use Playwright. These paths have different rendering and capture capabilities; availability of bundled runtimes does not make remote websites or model calls work offline.

## Providers and integrations

Install and authenticate the provider CLI you intend to use before launching work. The current adapter checks use these minimum versions:

| Provider | Executable | Adapter minimum | Usage reporting |
| --- | --- | --- | --- |
| Claude Code | `claude` | No pinned minimum | Provider-reported cost when present |
| Codex CLI | `codex` | 0.128.0 | Tokens with estimated cost |
| Gemini CLI | `gemini` | 0.11.0 | Tokens with estimated cost |
| Kimi Code | `kimi` | 0.27.0 | Native token/cost totals unavailable |

A minimum-version check is not a promise that every later CLI release has identical APIs. Features are capability-gated: for example, profiles are available for Claude and Kimi, and Kimi's unsupported no-tools transforms and Loop Deciders are rejected before execution. See [Kimi integration](docs/kimi.md) and the [provider adapter guide](docs/internals/adding-a-provider.md).

Git is required for isolated worktrees and branch delivery. Authenticated `gh` is needed for GitHub PR operations. Jira, MCP integrations and other external services require their own configuration and credentials. The [Specrails MCP server](docs/mcp.md) exposes project-aware operations to agents; repository-specific operations retain explicit repository identity.

## Core installation and updates

Desktop's version, the selected Core executable, the active shared framework and each project's installed artifacts are separate state. The current source supports Core 4 and Core 5; its online installation fallback requests Core 5. Core 5 installs deterministically and does not run the removed `enrich` wizard.

The resolver considers compatible managed, bundled, local and externally installed Core packages. An explicit `SPECRAILS_CORE_BIN` takes precedence; ordinary resolution does not silently downgrade an activated framework. Updating an external CLI alone does not refresh every project's copied artifacts.

Settings reports these versions separately. A partially refreshed workspace remains pending, blocks new implementations and offers **Finish updating** using the retained package. Read access and conversations remain available. See [Core runtime selection and recovery](docs/internals/core-runtime-updates.md) before diagnosing a version mismatch.

## Develop from source

Use **Node 22.22.3** to match the native CI runtime, plus npm and Git. The root package accepts Node 20.19+, but the current Vite client specifically requires **20.19+ on Node 20 or 22.12+ on Node 22 and later**. Node 21 and early Node 22 releases do not satisfy that requirement. Native builds also require Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/fjpulidop/specrails-desktop.git
cd specrails-desktop
npm ci
npm ci --prefix client
npm run dev
```

Web development starts the API on **4200** and Vite on **4201**, with hot reload. These commands use the normal local Specrails data directory; they do not create an isolated test profile.

To develop native features, stop the web development command and any other Specrails instance, then run:

```sh
npm run dev:desktop
```

Tauri's development hook rebuilds the sidecar and MCP bridge, starts Vite, then opens the native application. Ports **4200 and 4201** must be free. Use the default ports: `SPECRAILS_DEV_SERVER_PORT`, `SPECRAILS_DEV_CLIENT_PORT` and `SPECRAILS_PORT` overrides are for web development and can conflict with Tauri's fixed endpoints.

Frontend changes reload through Vite. After backend or MCP changes, restart `npm run dev:desktop` to rebuild their packaged artifacts. Preparation failures stop startup instead of using an old sidecar. The first build may download packaging dependencies; no installer is needed for this development loop.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check server, CLI, MCP bridge and client types |
| `npm test` | Server/CLI tests and Core compatibility check |
| `npm run test:client` | Client tests |
| `npm run test:scripts` | Test build, packaging and release helpers |
| `npm run ci` | Type, compatibility, script and coverage checks, then build and package validation |
| `npm run build` | Build the npm server, client, CLI and MCP bridge |
| `npm run check:package` | Validate the built npm package payload |
| `npm run build:desktop` | Build native artifacts from available staged resources |

`build:desktop` does not assemble a complete release runtime bundle or sign it. `build:desktop:local` assembles local runtimes for macOS ARM64 only. Release resources, signing, platform tests and publication are defined in [CI and releases](docs/ci-cd.md); a local web build does not validate native behavior.

## Architecture and data

| Directory | Responsibility |
| --- | --- |
| `server/` | Express, WebSocket, SQLite, provider execution and project services |
| `client/` | React interface, mission/board views and workspace tools |
| `cli/` | Local server management and command bridge |
| `mcp-bridge/` | stdio-to-server MCP bridge |
| `src-tauri/` | Native windows, webviews, OS integrations and sidecar lifecycle |

The default data home is `~/.specrails/`, containing the project registry, per-project history and managed framework/workspace data. Source files remain in their selected repositories. Back up the data home and repositories when preserving a complete working environment. The [architecture reference](docs/internals/architecture.md) describes the service boundaries.

The local server binds to loopback and authenticates API and WebSocket access. Specrails is a single-user application, not a server to expose publicly. Project history is stored locally, but provider CLIs, package installation, update checks, websites and configured integrations can contact external services. Model calls can transmit the context supplied to them and incur provider charges. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Further reading

- [User guide](docs/guide/en/getting-started/1-what-is-specrails.md)
- [Multi-repository projects](docs/multi-repo-projects.md)
- [Mission background processes and logs](docs/mission-processes.md)
- [Native browser capture and performance](docs/internals/browser-capture-performance.md)
- [Review packets](docs/internals/review-packet.md)
- [Internal documentation](docs/internals/README.md)
- [Contributing](CONTRIBUTING.md) and [changelog](CHANGELOG.md)

Specrails Desktop is available under the [MIT license](LICENSE). Development can be supported through [Ko-fi](https://ko-fi.com/D1D81Y002C).
