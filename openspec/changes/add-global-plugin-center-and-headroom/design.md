## Context

The current integration surface is `client/src/pages/IntegrationsPage.tsx`. It requires `activeProjectId`, renders `JiraIntegrationCard`, then renders project plugins from `/api/projects/:projectId/plugins`. Serena is already project-local through `PluginManager`, and Jira is project-local through `/api/projects/:projectId/jira`.

Specrails also already has the beginnings of `uv` support: `server/setup-prerequisites.ts` knows a `uv` minimum version and Serena advertises `uv`, but runtime bundling only treats Node/npm/npx/git as bundled-first tools and GitHub CLI as system-first fallback.

Headroom is different from Jira and Serena:
- It is global to Specrails, not tied to a project path.
- Install and activation are separate.
- Activation is per provider platform (`codex`, `claude`).
- Specrails controls the relevant AI CLI spawns, so the safest default is Specrails-scoped routing through a managed proxy and env injection.

## Decisions

### D1 - Global plugin center, scoped plugin taxonomy

Add a global `/plugins` route and sidebar item below `Loops`. The page owns the plugin catalog and groups plugins by `scope: "global" | "project"`. The right sidebar no longer contains `Integrations`.

Board mode navigates to `/plugins`. Mission mode opens the same page in a large modal, matching the existing Loops behavior so users are not pulled out of a mission.

### D2 - Project plugin wizard wraps existing local integrations

Jira and Serena remain project-local. The plugin center starts with project selection, then delegates:
- Jira: selected project opens the existing `JiraConnectWizard`/status card semantics.
- Serena: selected project opens the existing project plugin install/preview/verify flow.

This avoids duplicating integration logic while making plugin scope visible.

### D3 - Headroom install is Specrails-owned

Specrails installs Headroom with the bundled `uv` executable and these directories:
- `UV_TOOL_DIR=~/.specrails/tools/uv/tools`
- `UV_TOOL_BIN_DIR=~/.specrails/tools/bin`
- `UV_CACHE_DIR=~/.specrails/tools/uv/cache`

The Headroom binary is executed by absolute path from `UV_TOOL_BIN_DIR`, never by relying on user `PATH`. User-global `~/.local/bin` remains untouched.

### D4 - Default activation is Specrails-managed routing

Default activation starts or reuses a Specrails-managed `headroom proxy --host 127.0.0.1 --port <port>` process and injects provider-specific env vars into Specrails AI spawns:
- Codex: `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`
- Claude: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`

This avoids silently editing global user configs. A separate advanced action may call Headroom durable/system commands later, but it must be explicit and reversible.

### D5 - Error states are first-class

The Headroom service reports structured phases and error codes:
- `uv_missing_or_corrupt`
- `network_unavailable`
- `package_resolution_failed`
- `install_permission_failed`
- `headroom_not_found_after_install`
- `proxy_port_busy`
- `proxy_unhealthy`
- `provider_route_failed`
- `provider_config_conflict`
- `activation_partially_applied`

The UI maps these to contextual guidance, retry/repair/change-port/diagnostics actions, and does not mark a provider active unless verification succeeds.

### D6 - Bundled `uv` becomes a first-class runtime

Add `uv` to bundled runtime resolution and smoke testing. Unlike `gh`, `uv` is bundled-first for Specrails-managed tool installation. System `uv` can still be a fallback in development, but desktop mode should prefer the bundled binary.

## Risks

- **Network install failures:** `uv tool install` still needs network for `headroom-ai[all]`. The app must classify and guide failures, not present a generic crash.
- **Port conflicts:** Headroom defaults to 8787; the app must detect conflicts and allow a different port.
- **Partial activation:** Activating Codex and Claude independently must avoid a broken combined state. Each provider stores its own status.
- **Spawn coverage:** all Codex/Claude spawn paths need routing. Use a shared helper rather than ad hoc env edits.
- **Bundled uv size and signing:** uv is a native binary; macOS signing loop over `runtimes/` should sign it automatically, but smoke tests must assert it works in staging and packaged app.

## Migration

- Keep existing project plugin APIs and Jira routes.
- Redirect `/integrations` to `/plugins`.
- No project files are modified by the new plugin center until a user installs a project plugin through its wizard.
- Headroom global state is stored in desktop settings under `plugins.headroom.*`.
