## 1. Local agent runner package

- [x] 1.1 Scaffold `local-runner/` (package.json, tsconfig, `src/index.ts` argv parser with fail-fast unknown flags, `src/types.ts`)
- [x] 1.2 Implement streaming chat-completions client (`src/openai-client.ts`): SSE parse, text deltas, `tool_calls` fragment assembly by index, 429/4xx/5xx/network error mapping, context-length detection + one eviction retry
- [x] 1.3 Implement stream-json emitter (`src/frames.ts`): `system/init`, incremental `assistant` text, `assistant` tool_use, `user` tool_result, terminal `result` (no `total_cost_usd`)
- [x] 1.4 Implement built-in tools `Read/Grep/Glob/Bash/Write/Edit` with claude-compatible schemas, path confinement to cwd + `--add-dir`, Bash caps (10 min / 64 KB), malformed-args → error tool_result
- [x] 1.5 Implement tool policies (`--tools __none__`, `--tools csv`, `--disallowedTools csv`) and the agent loop with `--max-turns`
- [x] 1.6 Implement sessions (`~/.specrails/local-runner/sessions/<uuid>.json`, 0600, LRU 200), `--resume`, missing-session diagnostic, `--input-format stream-json` persistent multi-turn
- [x] 1.7 Implement MCP client (`src/mcp.ts`): `--mcp-config` stdio servers via SDK `Client`, tools exposed as `mcp__<server>__<tool>`, failed server skipped with stderr log
- [x] 1.8 Add `scripts/build-local-runner.mjs` (esbuild → `src-tauri/binaries/specrails-local-runner.js`), wire `build:local-runner` into `build`, `build:desktop`, `dev:desktop:prepare`, `typecheck`, `package.json files`, `tauri.conf.json bundle.resources`
- [x] 1.9 Runner unit tests with a fake SSE endpoint fixture (tool turn, malformed args, policies, confinement, resume, persistent stdin, MCP exposure, error frames) — coverage ≥ 80 %

## 2. Local adapter + registry

- [x] 2.1 Add `unregisterAdapter(id)` to `server/providers/registry.ts` (CLI-first ordering preserved) + tests
- [x] 2.2 Implement `server/providers/local-adapter.ts` `createLocalAdapter(connection)`: capabilities per spec, `AGENTS.md` / `.specrails-local`, `buildArgs` for `chat`, `chat-stream`, `job`, `freestyle`, `decider`, `contract-refine` mapping tool policies / system prompt / resume / mcp-config / add-dir, own `parseStreamLine` + `extractResult`, `modelCatalog()` from the detection cache, `formatCoreCommand` pass-through, `detectInstalled()` = HTTP probe
- [x] 2.3 Implement `server/providers/local-adapter-registry.ts` `syncLocalAdapters(connections)` + kill switch `isLocalEnginesEnabled()`; call it at boot (`index.ts` after `loadRuntimeProviders`) and after `PUT /runtime-providers`
- [x] 2.4 Extend `validateRuntimeProviders` to reject connection ids colliding with registered CLI adapter ids and to accept additive `label`, `defaultModel`, `rates`, `supportsReasoningEffort` (schema + semantic checks); parity test vs core schema documents the desktop-only additive fields
- [x] 2.5 Spawn helper: runner executable = bundled node (`resolveBundledNodeExe`, `windowsSpawnEnv`, cross-spawn) with `[scriptPath, ...args]`; unit test on both platforms' argv shape
- [x] 2.6 Adapter contract tests: recorded runner transcript → `AdapterEvent[]` fixture; capability block; catalog fallback; reserved-id rejection

## 3. Detection + selection

- [x] 3.1 Implement `server/local-engine-detection.ts` `probeConnection(conn)` (3000 ms, no redirects, Bearer from env, 200/401/403/network mapping, models extraction, `apiKeyEnvMissing`) + tests with a stub HTTP server
- [x] 3.2 Extend `provider-detection.ts`: probe local adapters in the same cycle, carry `kind: 'local'` + `models`, skip under kill switch, include ids in the detected set; `providers.detected_changed` on set change
- [x] 3.3 `provider-selection.ts`: `validateRequestedProvider` / `isProviderEnabled` accept detected local ids; primary derivation never picks a local id over a detected CLI
- [x] 3.4 `desktop-router.ts`: `POST /runtime-providers/test`, `GET /runtime-providers` returns detection status + models per local row, `PUT` re-syncs adapters + re-probes + broadcasts
- [x] 3.5 `GET /default-spec-model?provider=<local>` and `lib/loop-run-models.ts` read the dynamic catalog; `customModelAliases` remains accepted
- [x] 3.6 Tests for detection cycle, selection, routes (coverage ≥ 80 %)

## 4. Rails, loops and jobs on local engines

- [x] 4.1 `rails-router.ts`: map local engine → `runtimeProviderOverride { provider, model }` (effort dropped), extend `runtime_provider_mismatch` to local ids, hide/reject `maxCostUsd` for local engines, freestyle allowed via capability
- [x] 4.2 `agent-runtime-effective-config.ts`: apply a local override to all three roles; verify core receives the connection from `runtime-providers.json`
- [x] 4.3 `loop-executors.ts` `runAiStep` + decider: spawn the runner via the adapter for local ids (`toolPolicy` none for deciders), inject `SPECRAILS_REPO_DIR` / `--add-dir`, no profile env; `queue-manager.ts` `_startJob` legacy jobs + interactive sessions on local engines
- [x] 4.4 Ensure `ensureClaudeTrusted`, plugin snapshot, OTEL injection and profile resolution are skipped for local adapters through existing capability checks
- [x] 4.5 Tests: implement launch override mapping, freestyle spawn argv, decider `__none__`, interactive job on local (fake runner script), kill switch rejects local launch

## 5. Chat, Explore, Quick spec, missions

- [x] 5.1 `chat-manager.ts`: local adapter through spawn-per-turn, persistent-stdin (`ExploreStdinSessions`) and crash-respawn paths; `toolFlagsForScope` → runner policies; explore-cwd / workspace cwd unchanged
- [x] 5.2 Quick spec (`project-router-tickets.ts` generate-spec) on local engines; Contract Refine stays gated by `supportsContractRefine`
- [x] 5.3 `agent-chat-manager.ts` + `agent-mcp-config.ts`: `prepareAgentMcp` `local` branch writing the per-conversation `--mcp-config` (bridge + external servers), tier/conversation env forwarded; `agent_tool` / `agent_tool_result` events from runner frames
- [x] 5.4 Agent-chat `/models?provider=<local>` returns the dynamic catalog; provider bar + mission selector list local ids
- [x] 5.5 Tests: explore turn spawn argv, resume across turns, mission mcp-config contents, agent tool events from fixture transcript

## 6. Accounting + analytics

- [x] 6.1 `result-event.ts` / `pricing.ts`: local branch — rates ⇒ estimated cost, else `NULL` cost with `estimated = 0`; tokens always recorded
- [x] 6.2 `spending.ts` / analytics chips: local ids in the engine filter when rows exist; "cost unknown (local engine)" label; Job status panel cost `—`
- [x] 6.3 Tests for both cost paths and the analytics filter

## 7. Settings card (client)

- [x] 7.1 Create `components/settings/provider-connections/` (`ProviderConnectionsCard`, `ConnectionRow`, `LocalConnectionEditor`, `ConnectionStatusPill`, `TestConnectionButton`) with premium styling on semantic tokens; replace `RuntimeProviderConnections` mount; `VITE_FEATURE_LOCAL_ENGINES=false` renders legacy rows
- [x] 7.2 Test connection flow (draft payload, pill states, models list, default-model picker, `apiKeyEnvMissing` hint), rates inputs with validation, add/rename/remove/save with revert-on-failure toast
- [x] 7.3 `lib/agent-runtime.ts` types (+ `LocalConnection` additive fields), `useProviderDetection` consumers show local status badges
- [x] 7.4 i18n keys ×8 (`settings`, `agentRuntime`, `agent`, `analytics`) + locale-parity test green
- [x] 7.5 Component tests (coverage ≥ 80 % client)

## 8. MCP + docs

- [x] 8.1 `server/mcp/tools/settings.ts`: `runtime_providers.list|test|save` actions with tiers; `specrails_guide` mention
- [x] 8.2 `docs/local-providers.md` (user guide: add a connection, env key, recommended model classes, surfaces, limitations), `docs/internals/local-agent-runner.md` (argv/frames/tools/sessions/MCP contract), in-app guide page ×8 langs
- [x] 8.3 CLAUDE.md section "Local AI engines" + Multi-provider section cross-refs; `docs/internals/adding-a-provider.md` note on dynamic adapters

## 9. Verification

- [x] 9.1 `npm run typecheck`, `npm test`, `npm run test:coverage`, `cd client && npm run test:coverage` all green at the mandated thresholds
- [ ] 9.2 Manual smoke against the user's endpoint (`http://192.168.68.74:8080/v1`, `qwen3.5-9b:latest`): Test connection, sidebar chat turn + resume, Explore turn, mission listing specs via bridge, freestyle rail, implement rail; record results in the internals doc
- [ ] 9.3 Kill-switch smoke: `SPECRAILS_LOCAL_ENGINES=false` ⇒ selectors show CLIs only, runtime role radio still offers `local`
