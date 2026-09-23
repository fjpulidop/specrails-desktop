## Why

specrails-hub agents (rails) burn most of their tokens navigating the user's codebase via raw `Read`/`Grep`. Semantic-aware tooling (e.g. Serena via LSP+MCP) cuts that cost ~40-60% but its setup is fiddly and per-project. We want a marketplace-style surface inside the hub where each project independently opts into integrations, the hub installs/uninstalls them surgically, and rails launched from that project automatically inherit the active plugins — without ever requiring changes in `specrails-core`.

## What Changes

- New per-project **Integrations** section (page + REST + server module) that lists bundled plugins as marketplace cards, each independently installable/uninstallable.
- New `PluginManager` server module that owns plugin lifecycle (detect, install, verify, uninstall), state file, healthchecks, and a typed registry of bundled plugins.
- New `Plugin` TypeScript interface + bundled `serena` plugin as the first dogfooded integration.
- **Surgical, additive mutators** for `<project>/.mcp.json` and per-project plugin state, with file locking, rollback on install failure, and an "ownership" contract so plugins never stomp each other or user-authored entries.
- New per-project state directory `<project>/.specrails/plugins/` with `state.json` and per-job snapshots — independent from `specrails-core` artifacts.
- `QueueManager` integration: pre-spawn healthcheck per active plugin, snapshot to `~/.specrails/projects/<slug>/jobs/<jobId>/plugins.json` (chmod 400), inject `SPECRAILS_PLUGINS_ACTIVE` env var, and add OTEL resource attrs `specrails.plugins.active` / `specrails.plugins.degraded`. Healthcheck is **non-blocking** (degraded plugins log + continue).
- `ChatManager` inherits `.mcp.json` from cwd at spawn time without snapshotting (interactive sessions stay live). `SetupManager` ignores plugins entirely (project under construction).
- Diagnostic ZIP (`telemetry-export.ts`) gains `plugins.json` entry and plugin mentions in `summary.md`.
- New WebSocket events: `plugin.installed`, `plugin.uninstalled`, `plugin.degraded`, `plugin.health_changed` — all `projectId`-scoped.
- New install-time UX: install dialog with diff-preview of files about to change, prerequisite auto-install (reuses existing `usePrerequisites` + `setup-prerequisites.ts` patterns, extended for `uv`), streaming progress, and rollback on verify failure. Uninstall dialog mirrors the same pattern.
- v1 ships **bundled-only** registry (`server/plugins/index.ts` array). No remote registry, no third-party plugin loading, no marketplace beyond what hub bundles.
- v1 ships **MCP-only** plugin scope: each plugin contributes one or more `mcpServers` entries plus optional `<project>/.claude/agents/custom-<plugin>.md` (a core-protected namespace). Agent system-prompt injection is intentionally out of scope to keep `specrails-core` untouched.

## Capabilities

### New Capabilities
- `plugin-system`: per-project plugin lifecycle (registry, state file, install/uninstall, healthchecks, additive `.mcp.json` mutation, ownership conflict detection).
- `plugin-marketplace-ui`: marketplace-style `IntegrationsPage` per project (cards, install dialog with diff preview, uninstall confirm, health badges, WS event handling).
- `plugin-rail-integration`: QueueManager pre-spawn snapshot + healthcheck + env injection + OTEL attrs; ChatManager inherit-only behavior; SetupManager opt-out; diagnostic ZIP additions.
- `serena-plugin`: bundled Serena plugin implementation — manifest, install (writes MCP server entry + ensures `uv` available), verify (`uvx serena --version`), uninstall (surgical removal), and any plugin-owned files under `.claude/agents/custom-serena.md`.

### Modified Capabilities
<!-- None. The integration with QueueManager / ChatManager / SetupManager / telemetry export is additive new behavior captured under the new capabilities above; no existing spec's REQUIREMENTS change. -->

## Impact

- **Server**: new `server/plugin-manager.ts`, `server/plugins-router.ts`, `server/plugins/` (registry + serena), new types in `server/types.ts`. Light edits to `server/modules/execution/runtime/queue-manager.ts` (one new resolve step + env/OTEL injection), `server/modules/accounting/runtime/telemetry-export.ts` (extra ZIP entry), `server/setup-prerequisites.ts` (add `uv` detector), `server/index.ts` (mount router). No edits to `chat-manager.ts` or `setup-manager.ts` beyond ensuring they don't snapshot plugins.
- **Client**: new `client/src/features/integrations/pages/IntegrationsPage.tsx`, supporting components (`PluginCard`, `PluginInstallDialog`, `PluginUninstallDialog`, `PluginDiffPreview`), new route under `ProjectLayout`, sidebar entry, WS handlers in `useHub` / project event stream filter.
- **Per-project filesystem (managed by hub)**: `<project>/.mcp.json` (surgical merge), `<project>/.specrails/plugins/state.json`, `<project>/.specrails/plugins/snapshots/<jobId>.json`, optional `<project>/.claude/agents/custom-<plugin>.md`. Hub uses `proper-lockfile` for `.mcp.json` and `state.json` writes.
- **Hub-managed runtime paths**: `~/.specrails/projects/<slug>/jobs/<jobId>/plugins.json` (chmod 400) alongside the existing `profile.json` snapshot.
- **specrails-core**: zero changes. Plugin instructions are NOT injected into `sr-*.md` templates in v1 — agents discover MCP tools via their JSON schemas. Custom-agent file `custom-<plugin>.md` lives in the already-protected `.claude/agents/custom-*.md` namespace if a plugin chooses to ship one.
- **Tests**: vitest suites for plugin-manager (lifecycle, ownership conflicts, lock contention, additive guarantees), plugins-router (REST), QueueManager (snapshot + degraded path + OTEL attrs), telemetry-export (ZIP contents), IntegrationsPage (cards/dialogs), end-to-end Serena install/uninstall against a temp project.
- **Coverage**: new code must clear the existing 80% server / 80% client thresholds — no exclusions.
- **Dependencies**: `proper-lockfile` (already eligible) for atomic file mutation; no other new runtime deps. `uv` is a runtime requirement of the Serena plugin only — auto-installed via existing prerequisites flow, never a hub-level dependency.
- **Backwards compatibility**: pure addition. Projects without any installed plugins behave identically to today. Existing rails, chats, setup wizards, telemetry exports remain unchanged on the no-plugin path.
