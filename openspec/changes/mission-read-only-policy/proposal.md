## Why

Mission (agent chat) turns set no `toolPolicy`, so every provider spawns in its default write-capable mode. Claude runs with `--dangerously-skip-permissions --tools default`, Codex with `--sandbox workspace-write`, and Gemini with `--yolo`. Core sessions get `permissions: 'bypass'` or `'workspace-write'`. Missions stay off the code only because of an app-owned cwd, the operator prompt and the MCP permission ladder. Flow (docs/plans/flow-arquitectura.md, section 4.5) needs "only Flow writes" to be true by construction, so normal missions must be read-only at the CLI and session level first.

## What Changes

- Mission turns ask every transport for the provider's native read-only boundary: one-shot spawns, native live sessions (Claude stream-json, Codex app-server) and Core agent sessions. The `specrails_*` MCP tools must stay callable.
- New `SpawnOptions.retainMcpTools`. With `toolPolicy: 'read-only'`, Claude drops plan mode and `--safe-mode`, which block or unload MCP tools (verified live). Claude then runs with `--dangerously-skip-permissions --tools Read,Grep,Glob,Agent,WebFetch,WebSearch`.
- Gemini read-only mission turns run in plan mode with a generated, plan-scoped policy file that allows the registered MCP servers. Plan mode otherwise removes every MCP tool.
- New `ProviderCapabilities.missionReadOnlySession`, which maps a read-only mission onto Core's session policy. Claude maps to `bypass` with `tools.mode: 'read-only'`. Codex maps to `permissions: 'read-only'`. A tool restriction is only requested from drivers with `toolFiltering`.
- Kimi (no native read-only mode) keeps its current behaviour, and the limitation is documented. Local engines use the runner's read-only tool set and keep MCP.
- Kill switch `SPECRAILS_MISSION_READ_ONLY=false` (default on) restores the previous argv and session policy without a release.
- The operator manual no longer promises a raw shell.

## Capabilities

### New Capabilities
- `mission-read-only-policy`: mission agents run under the provider's native read-only boundary on every transport, keep MCP tools callable, have a kill switch, and document the providers that cannot comply.

### Modified Capabilities
- None. Existing pure-output and read-only callers (milestone chat, titles, refinements) keep their current argv.

## Impact

- `server/providers/{types,claude-adapter,codex-adapter}.ts`, `server/agent-mcp-config.ts`, `server/feature-flags.ts`.
- `server/modules/missions/runtime/{mission-tool-policy,agent-chat-manager,mission-core-sessions,agent-operator-prompt}.ts`, module boundary manifest.
- Docs: `docs/internals/mission-read-only-policy.md` (new), configuration, agent sessions, MCP audit, adding a provider, `docs/mcp.md`, `docs/local-providers.md`.
- Behavioural: Claude missions on Core sessions lose native sub-agents (`Agent` is not in Core's read-only tool set). Delegated sub-agents are unaffected.
