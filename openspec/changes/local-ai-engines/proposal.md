## Why

Users already register OpenAI-compatible endpoints (a local Ollama/llama.cpp/LM Studio server, a self-hosted vLLM, a LAN box) under **Settings ▸ Specrails Agents ▸ Provider connections** (`~/.specrails/runtime-providers.json`, `kind: 'openai-compatible'`), but those connections are usable ONLY as per-role providers of specrails-core's programmatic runtime. They never appear as a selectable AI engine in the rail header, Add Spec (Quick/Explore), the sidebar chat, or agent missions, the model must be typed by hand, and nothing tells the user whether the endpoint is reachable. A user who can already chat with their local model from Chatbox cannot use it from Specrails, which reads as "Specrails does not support local models" — the capability exists, it is just not wired to the product surfaces.

## What Changes

- **Local AI engines are first-class providers.** Every configured `openai-compatible` connection becomes a registered `ProviderAdapter` (id = the connection id) and participates in provider detection: a bounded `GET /v1/models` probe decides `installed`/`executable`/`authState`. A reachable connection joins `project.providers` and therefore every engine selector (`RailEngineSelector`, `AiEngineSelector`, `ChatInput`, agent-chat provider bar, mission selector) with zero selector changes.
- **Bundled local agent runner.** A new `local-runner/` package (esbuild → `src-tauri/binaries/specrails-local-runner.js`, executed by the bundled Node — the `specrails-mcp` bridge pattern) that Desktop spawns exactly like a CLI: a streaming chat-completions tool loop with built-in `Read/Grep/Glob/Bash/Write/Edit` tools, tool policies (`none`/`read-only`/`default`), persistent-stdin multi-turn, resumable sessions on disk, an MCP stdio client (so missions reach `specrails-mcp` and external servers), and a claude-shaped `stream-json` output so the existing stream/settle/accounting core (`runAiCliInvocation`, `finaliseInvocationResult`) is reused unchanged.
- **Rails on local engines.** Launching a rail (implement/batch/freestyle/custom loops) with a local engine routes every core role (architect/developer/reviewer) through core's existing `OpenAICompatibleExecutor` via the launch-time `runtimeProviderOverride`, and every non-core ai-step (freestyle, verify/fix/decider, loop ai-steps) through the local runner. `validateRequestedProvider` accepts connection ids; the `runtime_provider_mismatch` guard is extended to local ids.
- **Dynamic model catalog.** `modelCatalog()` for a local adapter is the live `GET /v1/models` result (cached 60 s, per connection, with a stored `defaultModel`). Custom aliases remain accepted (`customModelAliases: true`).
- **Premium Provider connections card.** The basic `RuntimeProviderConnections` form is replaced by connection cards: status pill (reachable / not authorized / unreachable / probing), **Test connection**, discovered models with a default-model picker, API-key-from-env hint (key never stored), optional USD-per-1M-tokens rates for an *estimated* cost badge, add/rename/remove, and the CLI rows in the same card family.
- **Honest accounting.** Invocations record `provider = <connection id>`, real `usage` tokens, `total_cost_usd = NULL` unless the connection carries rates (then `total_cost_usd_estimated = 1`). Analytics engine chips list local engines. No rate-card guessing.
- **Capability honesty.** Local adapters advertise `persistentStdin`, `toolPolicies: ['none','read-only']`, `freestyle`, `customModelAliases`, `nativeResume`, `nativeStreamJson`, `userMcp: false`, `structuredActions: false`, `profiles: false`, `nativeCostUsd: false`, `nativeOtelEnv: false`. Surfaces that need structured actions or profiles (SMASH, Contract Refine on pure-output, Agent Studio Generate, Project Builder generation, profile editor) gate themselves off through the existing capability checks — no new special cases.
- **Kill switch.** `SPECRAILS_LOCAL_ENGINES=false` ⇒ no local adapters registered, no detection probes, byte-identical legacy behaviour (connections still work for the programmatic runtime roles exactly as today).
- **Docs + MCP + i18n.** `docs/local-providers.md`, `docs/internals/local-agent-runner.md`, CLAUDE.md section; `specrails_settings` exposes connection CRUD + test; i18n ×8 (`settings`, `agentRuntime`, `agent`, `analytics`).

## Capabilities

### New Capabilities
- `local-ai-engines`: OpenAI-compatible connections as first-class, detectable, selectable AI engines across rails, Add Spec, chat and missions; dynamic model catalog; honest capability flags and accounting; kill switch.
- `local-agent-runner`: the bundled runner contract — argv, stream-json frames, tool loop, tool policies, sessions/resume, persistent stdin, MCP client, error surfacing, packaging.
- `provider-connections-card`: the premium Settings card — connection test, status pills, discovered models, default model, optional rates, env-key hint, CRUD, MCP exposure.

### Modified Capabilities
- `provider-auto-detection`: the detection singleton probes local connections (HTTP `GET /v1/models`, bounded, cached) alongside CLI adapters; connection ids join the detected set; `authState` derives from HTTP 401/403.
- `multi-provider-architecture`: the registry is no longer populated only at module load — local adapters are registered/unregistered when connections load or save; `detectInstalled()` for a local adapter is the HTTP probe.

## Impact

- **Server:** new `server/providers/local-adapter.ts` (+ `local-adapter-registry.ts` dynamic registration), `server/local-engine-detection.ts` (HTTP probe + model cache), changes in `provider-detection.ts`, `provider-selection.ts` (`validateRequestedProvider`), `rails-router.ts` (override mapping for local ids), `loop-executors.ts` / `queue-manager.ts` (spawn the runner binary), `agent-mcp-config.ts` (`--mcp-config` for the runner), `ai-invocations.ts` / `pricing.ts` (null cost, optional connection rates), `desktop-router.ts` (`/runtime-providers` gains `test` + `models` + rates), `mcp/tools/settings.ts`.
- **New package:** `local-runner/` (TypeScript, esbuild, `scripts/build-local-runner.mjs`, `tauri.conf.json` resource, `package.json` `files`/`build`/`typecheck`).
- **Client:** `RuntimeProviderConnections.tsx` → `ProviderConnectionsCard.tsx` family in `components/settings/`, `lib/agent-runtime.ts` types, `lib/loop-run-models.ts` (dynamic catalog for local ids), `useProviderDetection` consumers (status badge copy), analytics chips.
- **Core:** none required. Core's `OpenAICompatibleExecutor` is reused as-is for architect/developer/reviewer.
- **Dependencies:** no new runtime deps; the runner uses `fetch` + `@modelcontextprotocol/sdk` (already a dependency) for MCP.
- **Compat:** `runtime-providers.json` schema is additive (`defaultModel?`, `rates?`, `label?`). No SQLite migration. Frozen wire contracts untouched.
