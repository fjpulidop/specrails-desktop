# Design: add-external-mcp-servers

## Context

Mission agents (Desktop agent chat) wire exactly ONE MCP server today: the embedded Specrails bridge, via `prepareAgentMcp` (`server/agent-mcp-config.ts`), which already resolves the per-provider registration mechanism:

- claude → per-conversation `--mcp-config <file>` (file rewritten every turn)
- codex → inline `-c mcp_servers.specrails.*` overrides on the user's REAL `CODEX_HOME` (auth intact; codex therefore ALSO natively loads the user's own `~/.codex/config.toml` servers in missions today)
- gemini / kimi → `mergeServerIntoJsonFile` into the adapter's `projectMcpPath` under a **per-conversation cwd** (`ensureAgentConversationCwd` — added to prevent concurrent conversations racing on settings files; claude/codex keep the shared `agent-cwd`)

Users with their own MCP servers (Jira, internal tooling) cannot expose them to missions. The only existing user-MCP surface is Explore's per-spec `context_scope.userMcp` toggle (claude-only, `server/user-mcp-config.ts`), which never reaches missions.

Existing precedents this design deliberately reuses:
- **Settings blob**: `desktop_settings['specrails_agent_defaults']` (`server/agent-defaults.ts`) — one JSON k/v entry, typed validation errors, `GET/PATCH` pair in `desktop-router.ts` (lines ~1213).
- **Native-config reader**: `readUserClaudeMcpServers` (`server/user-mcp-config.ts`) — tolerant read of `~/.claude.json`, never throws.
- **Owned-key hygiene**: `PluginManager.mergeMcpServers/removeMcpServers` — surgical add/remove of app-owned keys in a shared JSON file.

## Goals / Non-Goals

**Goals:**
- App-level (per-machine) registry of external MCP servers for the MISSION agent, with a per-provider activation matrix.
- Discovery from provider native user configs so users don't retype what they already registered.
- Cross-provider reuse: a server discovered from claude's config is injectable into gemini/kimi/codex missions (stdio transports are provider-agnostic).
- Consent-first: nothing activates without an explicit per-entry, per-provider tick.
- Fail-open everywhere: a missing/corrupt native config, an orphaned selection, or a resolution error degrades to "entry skipped", never a broken mission spawn.

**Non-Goals (v1):**
- Rails/loops/Explore injection (pipeline blast radius; Explore keeps its own toggle).
- Per-mission composer toggles (blob shape leaves the door open — see D1).
- Health probes / tool-count display per server.
- HTTP/SSE transports for custom entries (stdio only in v1; discovered entries pass through whatever shape the native config holds — the app does not interpret transports it merely relays).
- Managing (editing/deleting) servers INSIDE the provider's native configs — the app reads them, never writes them.

## Decisions

### D1 — Storage: one `desktop_settings` blob, selection-only for discovered entries

`desktop_settings['external_mcp_servers']`:

```json
{
  "version": 1,
  "servers": {
    "d:claude:jira-interno": {
      "source": "discovered", "sourceProvider": "claude", "name": "jira-interno",
      "providers": { "claude": true, "kimi": true }
    },
    "c:mi-tool": {
      "source": "custom", "name": "mi-tool",
      "transport": { "command": "npx", "args": ["-y", "…"], "env": {} },
      "providers": { "claude": true }
    }
  }
}
```

- **Key = stable id** (`d:<sourceProvider>:<name>` / `c:<name>`), NOT the bare name — the same name may exist in two native configs with different transports; ids keep rows distinct.
- Discovered entries persist **selection only**; transport is re-resolved live at spawn (D2). Custom entries persist the full stdio transport.
- No SQLite migration (plain k/v). Per-mission toggles later = an additive `perMission` field, no reshape.
- *Alternative rejected*: new table / per-provider blobs → migration + no precedent benefit.

### D2 — Live transport resolution; orphan degradation

At spawn, each enabled-for-this-provider entry resolves:
- `custom` → transport from the blob.
- `discovered` → re-read the source provider's native config **at that moment**; entry absent → **skip silently for the spawn** (log line, UI badge on next `GET /api/external-mcp`), never block or fail the turn.

User edits to `~/.claude.json` etc. flow through with zero app action. *Alternative rejected*: snapshotting transports at tick time → silent drift, stale env/secrets.

### D3 — Discovery sources: JSON configs parsed; codex names-only

| Provider | File | Parsed | Usable as cross-provider source |
|---|---|---|---|
| claude | `~/.claude.json` (top-level `mcpServers`) | full (JSON) | yes |
| gemini | `~/.gemini/settings.json` (`mcpServers`) | full (JSON) | yes |
| kimi | `~/.kimi-code/mcp.json` (`mcpServers`) | full (JSON) | yes |
| codex | `~/.codex/config.toml` | **names only** (regex on `[mcp_servers.<name>]` table headers) | **no (v1)** |

Codex-native servers already load in missions (real `CODEX_HOME`); the UI lists them as "native, always on" — display-only, no toggle, no transport parsing (avoids a TOML dependency). A codex-only server wanted elsewhere → user adds it as a custom entry. All readers are tolerant (`missing/corrupt → {}`), mirroring `readUserClaudeMcpServers`, and generalized into the new `server/external-mcp.ts`.

### D4 — Injection: `prepareAgentMcp` goes 1 → N

`resolveExternalEntries(adapterId, settings): NamedAgentMcpEntry[]` (in `server/external-mcp.ts`) feeds the existing per-provider branches:

- **claude**: `buildAgentMcpArgs` writes `{ mcpServers: { specrails, <name>: … } }` into the SAME per-conversation `mcp.json` (0600). File is rewritten per turn — self-healing on disable.
- **codex**: `codexMcpOverrides` parametrized by name; N entries → N× `-c mcp_servers.<name>.*`. Argv per spawn — self-healing. Name equal to a codex-native server → the `-c` override wins (same-name = user intends that server; acceptable).
- **gemini / kimi**: `mergeServerIntoJsonFile` parametrized by name. Cleanup via a **sidecar ownership file** `external-owned.json` next to the settings file (per-conversation cwd, already app-managed): each spawn reads the sidecar, deletes every previously-owned external key, merges the currently-enabled set, rewrites the sidecar. Disable-then-respawn removes the key deterministically; `specrails` stays outside the sidecar (always merged).
- Injected server name = entry `name`. If two ENABLED entries would inject the same name for the same provider, PATCH rejects (`duplicate_server_name`) — collision handled at config time, not spawn time.
- Kill switch `SPECRAILS_EXTERNAL_MCP=false` (exact-string false/0/off) short-circuits `resolveExternalEntries` → byte-identical current wiring.

### D5 — Consent and security model

- Discovery only LISTS. The per-provider tick in Settings is the consent act; default state for every entry is fully unticked.
- Warning copy in the card (i18n ×8): mission spawns run with `--dangerously-skip-permissions` → external tools are callable WITHOUT approval prompts, and they live OUTSIDE the Shift+Tab tier ladder (tiers guard only `specrails_*`, server-side).
- Reserved name `specrails` rejected at PATCH (`reserved_name`).
- Custom-entry `env` may carry secrets: blob lives in `desktop.sqlite` plaintext — same trust domain as `~/.claude.json` (also plaintext). Generated per-conversation config files keep 0600.
- The client never needs transports echoed back for discovered entries; `GET` returns discovered metadata (name, source, present/orphan) + settings.

### D6 — REST: `GET/PATCH /api/external-mcp`

Mirror of `/api/agent-defaults` (desktop-router, master token, loopback):
- `GET` → `{ discovered: { claude: [...], gemini: [...], kimi: [...], codexNative: [...] }, settings }` — discovery executed on request (cheap file reads; no cache in v1).
- `PATCH` → replaces the settings blob after validation; typed error codes (`reserved_name`, `duplicate_server_name`, `invalid_transport`, `unknown_provider`). Returns the stored settings.

### D7 — Operator prompt line

One appended sentence in `server/agent-operator-prompt.ts`: additional user-configured tools may be present; ALL Specrails app operations MUST still go through `specrails_*` tools. Prevents the agent from confusing a user's `jira` MCP with `specrails_jira`.

### D8 — Missions-only seam

Injection touches ONLY `prepareAgentMcp` (agent chat). QueueManager/loop-executors/ChatManager spawns are untouched — verified by the absence of any call into `external-mcp.ts` from those modules.

## Risks / Trade-offs

- [Token bloat: every enabled server adds tool schemas to every mission turn] → consent-first default-off, per-provider granularity, advice copy in the card; per-mission toggles are the designed v2.
- [Discovered orphan silently missing mid-conversation] → skip + log at spawn, orphan badge in Settings on next load; never fail the turn (matches "bridge unavailable ⇒ degraded" behaviour today).
- [Same-name conflicts across sources] → stable ids in storage + `duplicate_server_name` PATCH guard per provider.
- [claude may already auto-load user-scope servers in headless mode → double registration] → `--mcp-config` merges by server name additively; same-name/same-transport is idempotent for the CLI. Verify empirically during implementation; if duplication surfaces, filter claude-discovered entries out of the claude injection set (they load natively) — the matrix tick then only matters cross-provider.
- [kimi global user-scope config path unverified (`~/.kimi-code/mcp.json` assumed)] → verification task before wiring kimi discovery; worst case kimi is injection-target-only in v1 (like codex).
- [Secrets in `desktop.sqlite` plaintext] → documented; same trust domain as native CLI configs; no new exposure class.

## Migration Plan

Purely additive: no migration, no default behaviour change (empty registry ⇒ zero injection ⇒ current wiring byte-identical). Rollback = `SPECRAILS_EXTERNAL_MCP=false` or emptying the card; removing the settings row is harmless.

## Open Questions

_Resolved during implementation (2026-07-30):_

- **Headless `claude -p` DOES load user-scope `~/.claude.json` servers** — verified empirically (a headless probe listed the machine's user-scope servers alongside project-scope ones). Consequence: for a claude-discovered entry ticked for claude, the `--mcp-config` injection is a same-name/same-definition merge — idempotent, no duplication (the CLI merges `mcpServers` by name). The contingency filter is therefore NOT needed; the tick is a harmless no-op for claude-target and meaningful for every cross-provider target. Kept as-is for matrix uniformity.
- **Kimi global config path** (`~/.kimi-code/mcp.json`) could not be verified on the dev machine (file absent). The discovery reader is fail-open (absent/corrupt → empty list), so a wrong path degrades to "kimi discovers nothing" — kimi remains a fully working injection TARGET either way. Revisit when a kimi install with registered MCP servers is available.
