## 1. Provider contract

- [x] 1.1 Add `SpawnOptions.retainMcpTools` and `ProviderCapabilities.missionReadOnlySession` (types.ts)
- [x] 1.2 Claude: read-only plus `retainMcpTools` maps to the bypass with `--tools Read,Grep,Glob,Agent,WebFetch,WebSearch`, without plan mode, `--safe-mode` or plugins
- [x] 1.3 Declare `missionReadOnlySession` for Claude (bypass + read-only tools) and Codex (read-only permissions)
- [x] 1.4 Gemini: `prepareAgentMcp({ readOnly })` writes the plan-scoped MCP policy and returns `--policy <file>`

## 2. Missions

- [x] 2.1 `mission-tool-policy.ts`: spawn policy, read-only gap, Core session boundary (respects driver `toolFiltering`)
- [x] 2.2 `AgentChatManager._runTurn`: pass the spawn policy to every legacy and native transport, pass `readOnly` to the MCP wiring, log the effective tool policy
- [x] 2.3 `MissionCoreSessions.prepareTurn`: use `missionSessionBoundary` for `permissions` and `tools`
- [x] 2.4 Operator prompt: drop the raw-shell promise and state that the session is read-only
- [x] 2.5 Kill switch `SPECRAILS_MISSION_READ_ONLY` in `feature-flags.ts`
- [x] 2.6 Boundary manifest and source map regenerated

## 3. Tests

- [x] 3.1 Adapter argv: Claude (chat-turn/resume/stream), Codex (fresh/resume), Gemini (`--policy` passthrough), local runner
- [x] 3.2 Gemini policy file content, permissions and no-op for default turns (agent-mcp-config)
- [x] 3.3 Mission spawn argv per provider plus the kill switch (agent-chat-manager)
- [x] 3.4 Core session policy for Claude, Codex, a non-filtering driver and the kill switch (mission-core-sessions)
- [x] 3.5 Unit tests for mission-tool-policy

## 4. Verification and docs

- [x] 4.1 Live smokes: Claude (adapter argv), Codex (exec read-only + MCP), Gemini (plan + generated policy)
- [x] 4.2 Docs: internals guide, configuration flag, agent sessions, MCP audit, adding a provider, user MCP and local-provider docs
- [x] 4.3 `npm run typecheck`, `npx vitest run server/modules/missions server/providers server/mcp`, `npm run audit:architecture`
