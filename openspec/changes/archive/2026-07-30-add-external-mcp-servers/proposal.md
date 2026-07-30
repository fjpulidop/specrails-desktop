# Proposal: add-external-mcp-servers

## Why

Mission agents (Desktop agent chat) can only call the embedded Specrails MCP today. Users who already run their own MCP servers (Jira, internal tooling, domain APIs) cannot make them available to the mission agent, so the agent round-trips through the human for operations their own tools could perform directly. There is no app-level way to say "these external MCP servers are active for missions, per AI provider" — the only existing user-MCP surface is the per-spec Explore toggle (`context_scope.userMcp`, claude-only), which never reaches missions.

## What Changes

- New app-level (per-machine) **external MCP servers registry** stored as one JSON blob in `desktop_settings['external_mcp_servers']` (precedent: `specrails_agent_defaults`). No SQLite migration.
- **Discovery**: the app reads each provider's native user-scope MCP config read-only (`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.kimi-code/mcp.json`) and lists discovered servers in the UI. For discovered entries the app persists **only the selection** — transports are re-resolved live from the native config at spawn time, so user edits flow through and a removed entry degrades to an orphan (skipped at spawn, badged in UI), never a broken spawn.
- **Custom entries**: manual add (name, stdio command/args/env) stored fully in the blob, for servers not registered in any native config.
- **Per-provider activation matrix**: each server entry carries `providers: { claude?, codex?, gemini?, kimi? }`. A server discovered from one provider's config is injectable into any provider's missions (stdio transports are provider-agnostic). Codex-native servers are displayed honestly as "native, always on" (codex mission spawns keep the user's real `CODEX_HOME` and load `config.toml` servers natively — no toggle pretending otherwise).
- **Injection at spawn**: `prepareAgentMcp` (`server/agent-mcp-config.ts`) extends from 1 server (specrails bridge) to N: claude → the same per-conversation `--mcp-config` file carries `{ specrails, ...external }`; codex → additional `-c mcp_servers.<name>.*` inline overrides; gemini/kimi → app-owned keys merged into the agent-cwd settings file, with tracked ownership so disabling an entry removes it on the next spawn (precedent: PluginManager `owns.mcpServers`).
- **Consent-first security**: nothing auto-enables after discovery — the user ticks each entry per provider, and that tick is the consent. UI carries explicit warning copy: mission spawns run with `--dangerously-skip-permissions`, so external tools are callable without approval prompts and live OUTSIDE the Shift+Tab tier ladder (tiers govern only `specrails_*` tools, server-side).
- **Guardrails**: reserved name `specrails` rejected at PATCH; one operator-prompt line telling the agent additional user tools may exist and app operations must still go through `specrails_*`; kill switch `SPECRAILS_EXTERNAL_MCP=false` ⇒ byte-identical current behaviour.
- **REST**: `GET/PATCH /api/external-mcp` (desktop-router, master token) returning `{ discovered, settings }` (precedent: `/api/agent-defaults`).
- **Client**: new "External MCP servers" card in `Settings ▸ MCP` (`McpSettingsSection` sibling card) — per-server rows with source badge, provider matrix, orphan badge, add-custom form, warning copy. i18n ×8.

**Explicitly out of scope (v1)**: rails/loops injection (pipeline blast radius), per-mission composer toggles (the blob shape leaves the door open), per-entry health probes, Explore-toggle unification.

## Capabilities

### New Capabilities

- `external-mcp-servers`: app-level registry of user external MCP servers (discovered + custom) with per-provider activation, consent-first enablement, live transport resolution, and injection into mission agent spawns.

### Modified Capabilities

_None._ Mission-agent MCP wiring has no canonical spec yet (`add-desktop-agent-chat` / `add-desktop-mcp-server` remain unarchived); this change layers onto that in-flight surface without changing any archived requirement.

## Impact

- **Server**: new `server/external-mcp.ts` (discovery + settings read/validate/resolve); `server/agent-mcp-config.ts` (`prepareAgentMcp`, `buildAgentMcpArgs`, `codexMcpOverrides`, `mergeServerIntoJsonFile` parametrized to N servers + ownership tracking for gemini/kimi agent-cwd files); `server/desktop-router.ts` (two routes); `server/agent-operator-prompt.ts` (one line); `server/user-mcp-config.ts` (generalize `readUserClaudeMcpServers`-style native-config readers per provider).
- **Client**: `client/src/components/settings/McpSettingsSection.tsx` (new card or sibling component); new i18n keys in the `mcp` namespace ×8 locales.
- **Security surface**: external tools run unprompted inside missions — consent UI + warning copy are load-bearing, not cosmetic. Custom-entry `env` blocks may carry secrets; stored in `desktop.sqlite` plaintext, same trust domain as `~/.claude.json` (documented).
- **No changes** to: specrails-core, rails/loops spawns, Explore's `userMcp` toggle, the embedded MCP server/tier system, mobile wire contract.
