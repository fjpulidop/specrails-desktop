## 1. Policy and settings

- [x] 1.1 Pure builder `server/modules/execution/domain/agent-env.ts` (allowlists, pattern matching, inherit identity, minimal filter, names report) with architecture rule
- [x] 1.2 Project setting `agentEnvMode` (domain validation, SQLite persistence, default inherit)
- [x] 1.3 `ProviderAdapter.envAllowlist` on Claude, Codex, Gemini, Kimi and local adapters; `providerEnvAllowlist` helper
- [x] 1.4 Project binding `resolveProjectAgentEnv` / `projectAgentSourceEnv` and `getProjectAgentEnvStatus` in `server/project-env.ts`

## 2. Spawn paths

- [x] 2.1 Rail jobs (headless and interactive) in `QueueManager`
- [x] 2.2 Loop executors: provider-aware base-env thunk (AI steps, deciders, Core definitions, shell steps)
- [x] 2.3 Runtime controls (`agent-runtime-controls.ts`)
- [x] 2.4 Missions (legacy runners) and the Core session host per project scope
- [x] 2.5 Project chats / Explore, spec generation, proposals, Contract Refine, SMASH, agent refinement, AI ticket edits

## 3. Surfaces

- [x] 3.1 `GET /api/projects/:projectId/agent-env/status` (names only)
- [x] 3.2 Project Settings card (route and dialog) with explanation, 8 locales
- [x] 3.3 MCP `specrails_env` reports the mode read-only

## 4. Tests and docs

- [x] 4.1 Builder tests (inherit identity, minimal filter, Windows essentials, child process sees only allowlisted names)
- [x] 4.2 Per-adapter allowlist tests; settings, HTTP and project-env tests; loop executor allowlist tests; spawn-path coverage guard
- [x] 4.3 Client tests for the settings card
- [x] 4.4 Docs: configuration, SECURITY, provider guide, module READMEs
