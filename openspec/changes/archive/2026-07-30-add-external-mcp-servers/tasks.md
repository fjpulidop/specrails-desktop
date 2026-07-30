# Tasks: add-external-mcp-servers

## 1. Server core (`server/external-mcp.ts`)

- [x] 1.1 Types + settings read/validate: `ExternalMcpSettings` (`version`, `servers` map keyed `d:<provider>:<name>` / `c:<name>`), `readExternalMcpSettings(db)`, `applyExternalMcpPatch(db, body)` with typed errors (`reserved_name`, `duplicate_server_name`, `invalid_transport`, `unknown_provider`); kill-switch helper `isExternalMcpEnabled()` (`SPECRAILS_EXTERNAL_MCP` false/0/off, case-insensitive)
- [x] 1.2 Discovery readers (tolerant, read-only, never throw): claude `~/.claude.json` `mcpServers`, gemini `~/.gemini/settings.json` `mcpServers`, kimi `~/.kimi-code/mcp.json` `mcpServers`, codex `~/.codex/config.toml` names-only regex; `discoverExternalMcp()` returning per-provider lists + orphan flags against stored selections; honour `SPECRAILS_REGISTRY_HOME` for tests
- [x] 1.3 `resolveExternalEntries(adapterId, db): NamedAgentMcpEntry[]` — enabled-for-provider filter, custom → blob transport, discovered → live re-read of source config (absent ⇒ skip + log), kill switch ⇒ `[]`
- [x] 1.4 Unit tests: settings validation (all four error codes), tolerant discovery (missing/corrupt files), live resolution + orphan skip, kill switch

## 2. Injection seam (`server/agent-mcp-config.ts`)

- [x] 2.1 Parametrize helpers to N named servers: `buildAgentMcpArgs` writes `{ specrails, ...external }` into the per-conversation `mcp.json`; `codexMcpOverrides(name, entry)`; `mergeServerIntoJsonFile(file, name, entry)`
- [x] 2.2 Sidecar ownership for gemini/kimi (`external-owned.json` next to the settings file in the conversation cwd): each spawn removes previously-owned external keys, merges the enabled set, rewrites the sidecar; `specrails` managed outside the sidecar; foreign keys never touched
- [x] 2.3 Wire `resolveExternalEntries` into `prepareAgentMcp` (all provider branches); failures degrade to specrails-only wiring, never a broken spawn
- [x] 2.4 Unit tests: claude N-server mcp.json, codex N× `-c` argv, gemini/kimi merge + disable-removes-key via sidecar, orphan skip mid-conversation, kill switch byte-identical wiring

## 3. REST + operator prompt

- [x] 3.1 `GET/PATCH /api/external-mcp` in `server/desktop-router.ts` (mirror `/api/agent-defaults`); GET runs discovery per request and returns `{ discovered, settings }`; PATCH returns stored settings or 400 typed error
- [x] 3.2 Operator prompt disclosure line in `server/agent-operator-prompt.ts` (external user tools may exist; app operations only via `specrails_*`)
- [x] 3.3 Route tests (supertest): GET shape, PATCH round-trip, each 400 code, prompt contains disclosure

## 4. Client (Settings ▸ MCP card)

- [x] 4.1 `ExternalMcpServersCard` in `client/src/components/settings/` rendered from `McpSettingsSection`: rows (name, source badge, provider matrix, orphan badge), codex-native rows display-only ("native, always on"), add-custom form (name/command/args/env pairs), remove entry, consent warning copy; optimistic PATCH + revert/toast (agent-defaults pattern)
- [x] 4.2 i18n: new `mcp` namespace keys ×8 locales (rows, badges, form, warning, errors); key-parity test passes
- [x] 4.3 Component tests: render matrix from GET payload, tick → PATCH body, orphan badge, reserved-name error surfaced, custom-entry add/remove

## 5. Verification + gates

- [x] 5.1 Empirical checks (record findings in design.md Open Questions): does headless claude agent spawn already load user-scope `~/.claude.json` servers (if yes → filter claude-discovered entries from claude injection); confirm kimi global config path as discovery source (if wrong → kimi injection-target-only)
- [x] 5.2 `npm run typecheck` + `npm test` green
- [x] 5.3 Coverage gates: `npm run test:coverage` (server ≥80%) + `cd client && npm run test:coverage` (client ≥80%) — iterate tests until green
- [x] 5.4 Docs: CLAUDE.md section blurb (external MCP servers under the agent-chat section) + `docs/mcp.md` note
