## Context

Specrails treats a "provider" as an **agentic CLI spawned as a child process** (`claude`, `codex`, `gemini`, `kimi`). Every manager that talks to a model (`ChatManager`, `QueueManager`, `AgentChatManager`, `AgentRefineManager`, `SetupManager`, loop executors, contract refine, file summaries) consumes the `ProviderAdapter` contract in `server/providers/types.ts`: `buildArgs(action, opts)` → argv, `parseStreamLine(line)` → `AdapterEvent`, `extractResult(events)` → normalised result. Spawn, stream, settle and accounting are centralised in `server/modules/execution/runtime/spawn-lifecycle.ts` (`runAiCliInvocation`) + `server/modules/accounting/runtime/result-event.ts` (`finaliseInvocationResult`). Provider availability is a machine property decided by `server/provider-detection.ts` (binary on PATH + version + auth heuristic, 60 s cache), and every engine selector in the client renders `project.providers`, which `mapProjectRow` mirrors from the detected set.

Separately, the **programmatic agent runtime** (core `src/agent-runtime/`) already knows about `openai-compatible` providers: `~/.specrails/runtime-providers.json` (`server/modules/agent-runtime/runtime/agent-runtime-settings.ts`, global connections) + per-project `agent-runtime.json` (role → provider/model). Core's `OpenAICompatibleExecutor` (145 lines, non-streaming chat-completions with a `tool_calls` loop) runs architect/developer/reviewer against such an endpoint. The user has `local` → `http://192.168.68.74:8080/v1` (key from `LOCAL_OLLAMA_API_KEY`), serving `qwen3.5-9b:latest`; it works for the runtime roles, but nothing else in the product can see it.

Constraints: the frozen wire contracts (mobile `hub.*`, bundle id), the coverage policy (80 % server / 80 % client), the Windows packaged-spawn traps (`process.execPath` ≠ node; use `resolveBundledNodeExe` + `windowsSpawnEnv`), honest-metrics (no invented numbers), and "one change, all surfaces" — the user explicitly wants rails, Add Spec, chat and missions in the same change.

## Goals / Non-Goals

**Goals:**
- A configured OpenAI-compatible connection is a selectable engine on every surface where a CLI provider is selectable, with no per-selector special-casing.
- Zero changes to the managers' spawn/stream/settle path: the local engine looks like one more CLI to them.
- Rails reuse core's executor for the three pipeline roles; every other AI step reuses the runner.
- Reachability and models are discovered, never typed blind; the API key never leaves the environment.
- Accounting is honest: tokens real, cost `NULL` unless the user supplies rates, then flagged estimated.
- Fully reversible: kill switch restores byte-identical behaviour; connections keep working for runtime roles.

**Non-Goals:**
- Anthropic-messages-format endpoints (`/v1/messages`) — OpenAI chat-completions only.
- Per-connection agent profiles, custom roles, Agent Studio generation, SMASH/structured-action surfaces (gated off via existing capability flags).
- A generic "bring your own CLI" provider.
- Changes in specrails-core.
- Jira, plugins (Serena) registration for local engines.
- Guaranteeing quality with small models; the product surfaces are wired, model competence is the user's choice.

## Decisions

### D1 — Local engine = a bundled runner spawned like a CLI (not an in-process HTTP client)

**Choice:** ship `local-runner/` (TypeScript → esbuild single file `src-tauri/binaries/specrails-local-runner.js`, run by the bundled Node, same packaging as `specrails-mcp`). Desktop spawns it with argv and reads `stream-json` on stdout.

**Why:** the whole product is built on the spawn contract. An in-process HTTP client would need a second streaming/settle/accounting path in every manager (ChatManager alone has three transports: spawn-per-turn, persistent stdin, crash respawn). A runner that speaks the same frames plugs into `runAiCliInvocation`, `InteractiveJobSession`, `ExploreStdinSessions`, kill/zombie/timeout handling, provenance snapshots and `ai_invocations` for free. It also keeps model traffic in a separate process (a hung SSE never blocks the sidecar event loop).

**Alternatives:** (a) in-process `fetch` adapter with a synthetic event stream — rejected, duplicates three transports; (b) route everything through core's `OpenAICompatibleExecutor` — rejected, it is role-scoped, non-streaming, has no MCP client and no session/resume; (c) `codex --oss` — rejected, ties local models to codex's tool policy and CLI presence.

### D2 — Frame dialect: claude-shaped `stream-json`

The runner emits the subset of claude's stream-json the claude adapter already parses: `system/init { session_id, model }`, `assistant { message: { content: [text | tool_use], usage } }`, `user { tool_result }` (for the activity log), `result { num_turns, is_error, usage, session_id, result }`. **The local adapter owns its own `parseStreamLine`** (a thin copy of the claude frame mapping, NOT an import of `claudeAdapter.parseStreamLine`) so claude-specific heuristics (`isClaudeNotificationResultFrame`, `background_tasks_changed`, alias pinning) never leak in, and so a claude parser change cannot silently break local engines. `total_cost_usd` is always absent in `result`.

### D3 — One adapter instance per connection, registered dynamically

`server/providers/local-adapter.ts` exports `createLocalAdapter(connection): ProviderAdapter` with `id = connection.id`, `binary = <bundled node>` and `buildArgs` prefixing the runner script path. `server/providers/local-adapter-registry.ts` `syncLocalAdapters(connections)` registers new ids and unregisters removed ones (new `registry.unregister(id)` — additive to the registry contract; `listAdapters` order stays CLI-first). Called at boot (after `loadRuntimeProviders`) and after every `PUT /runtime-providers`. Reserved ids (`claude|codex|gemini|kimi`) can never be a connection id (already true by validation: CLI rows own them) — the validator additionally rejects a connection id that collides with any registered CLI adapter.

Provider-neutral filesystem conventions: `instructionsFilename = 'AGENTS.md'`, `projectDirName = '.specrails-local'` (never a repo dir), `projectMcpPath` = `<root>/.specrails-local/mcp.json`. Relocated workspaces need no assemble step for local engines (the runner reads the repo via `SPECRAILS_REPO_DIR`/cwd like the others; the framework surface it needs is the commands text, which core's executor handles for rails).

### D4 — Detection = bounded `GET /v1/models`

`server/local-engine-detection.ts` `probeConnection(conn)`: `GET <baseUrl>/models` with `Authorization: Bearer <env>` when `apiKeyEnv` is set, 3000 ms `AbortSignal.timeout`, no redirects. 2xx + `data[]` ⇒ `installed: true, executable: true, authState: 'authenticated', models`; 401/403 ⇒ `installed: true, executable: true, authState: 'unauthenticated'`; network error / timeout / non-JSON ⇒ `installed: false`. `apiKeyEnv` set but env empty ⇒ probe still runs (many local servers ignore auth) and the card shows an "env var not set" hint. The provider-detection singleton calls this for every connection in the same 60 s cycle as CLI probes; results carry `kind: 'local'` and `models` so `modelCatalog()` reads from the cache (fallback: `[{ value: defaultModel ?? 'default' }]` when the cache is empty, so a selector never renders empty). Detection of local engines is skipped entirely under the kill switch.

### D5 — Rails: core roles via `OpenAICompatibleExecutor`, everything else via the runner

`rails-router.ts`: when `engineCheck.provider` is a local id, `runtimeProviderOverride = { provider: <id>, model, effort? }` (effort is dropped — OpenAI endpoints have no effort knob; the validator already allows omission). `agent-runtime-effective-config.ts` maps the override onto the three roles (it already does for CLI ids; the connection kind is already valid in the schema). Core spawns its own HTTP executor with the connection's `baseUrl`/`apiKeyEnv` from the runtime providers file it already reads. Non-core ai-steps (`loop-executors.ts` `runAiStep` for freestyle/verify/fix/decider/custom loops, `queue-manager.ts` `_startJob` legacy jobs) resolve `getAdapter(<id>)` and spawn the runner. `formatCoreCommand` for the local adapter returns the slash command text unchanged; the runner's system prompt makes `/specrails:*` commands resolve by reading `<workspace>/.claude/commands/**` (materialised from the framework dir) — the same `Unknown command` failure semantics as kimi apply when the file is missing. Decider steps use `toolPolicy: 'none'` (supported natively by the runner). `maxCostUsd` limits are rejected for local roles (already core behaviour) — the launch dialog hides the cap for local engines.

### D6 — Tool loop, policies and safety in the runner

Built-in tools mirror claude's names so prompts written for claude work: `Read`, `Grep`, `Glob`, `Bash`, `Write`, `Edit`. Policies: `--tools __none__` (no tools exposed), `--tools Read,Grep,Glob` (read-only), default (all), `--disallowedTools Write,Edit` (the Explore high tier). Every tool path is confined to `cwd` and `--add-dir` roots (`SPECRAILS_REPO_DIR` + the `./project` link target); path traversal outside is a tool error, not a crash. `Bash` runs through `/bin/sh -c` (`cmd.exe /d /s /c` on Windows) with the runner's env, a 10-minute per-call cap and 64 KB output cap. No `--dangerously-skip-permissions` analogue is needed: the runner has no interactive permission prompts; the policy IS the permission model. Tool-call arguments are JSON-parsed defensively (small models emit malformed JSON) and a malformed call is returned to the model as a `tool_result` error so the loop can self-correct instead of aborting.

### D7 — Sessions, resume, persistent stdin

Sessions live at `~/.specrails/local-runner/sessions/<uuid>.json` (messages array, model, cwd, created/updated; 0600; capped at 200 sessions LRU). `--resume <id>` loads it; `--input-format stream-json` keeps the process alive reading `{type:'user', message:{content}}` lines, one turn per line, emitting a `result` per turn (the persistent-stdin contract `InteractiveJobSession` / `ExploreStdinSessions` expect). Context overflow: when the endpoint returns a context-length error, the runner drops the oldest tool-result pairs (never the system prompt or the latest user turn) and retries once; a second failure is a `result { is_error: true }` with the endpoint message verbatim.

### D8 — MCP inside the runner

`--mcp-config <file>` (same JSON shape claude accepts: `{ mcpServers: { name: { command, args, env } } }`) starts stdio servers with the SDK `Client`; their tools are exposed to the model as `mcp__<server>__<tool>` (claude's naming, so the operator prompt and activity chip work unchanged). `agent-mcp-config.ts` `prepareAgentMcp` gains a `local` branch that writes the same per-conversation file it writes for claude (specrails bridge + enabled external servers). The runner forwards `SPECRAILS_AGENT_CONVERSATION` and the tier header env exactly like the claude spawn does (they ride `entry.env`).

### D9 — Accounting and pricing

`finaliseInvocationResult` already handles missing native cost by calling `pricing.ts`; add a `local` branch: if the connection has `rates { inputPer1M, outputPer1M }` compute `total_cost_usd` with `estimated = true`, else leave `NULL` (and `estimated = 0`). `ai_invocations.model` stores the raw model id; `provider` = the connection id; analytics groups/filters by it (the `?provider=` chip list comes from `distinct provider` + registered adapters, so local ids appear when they have rows). The Job status panel shows Cost `—` for local runs without rates (existing behaviour for null cost).

### D10 — Settings card replaces the form

`client/src/components/settings/provider-connections/`: `ProviderConnectionsCard` (list), `ConnectionRow` (CLI rows read-only status; local rows editable), `LocalConnectionEditor` (id, label, base URL, API-key env, default model, rates), `ConnectionStatusPill`, `TestConnectionButton` (POST `/api/runtime-providers/test` with the unsaved draft, returns `{ reachable, authState, models, latencyMs, error }`). Saving `PUT /runtime-providers` re-syncs adapters, re-runs detection for local ids and broadcasts `providers.detected_changed` so open selectors update live. The card stays inside the existing Specrails Agents section (`GlobalSettingsPage` nav `specrailsAgents`) so users find it where the connections already live.

### D11 — Kill switch and rollout

`SPECRAILS_LOCAL_ENGINES` default on; `0|false|off` ⇒ `syncLocalAdapters` is a no-op, detection ignores connections, `validateRequestedProvider` rejects local ids, the runner is never spawned. The Settings card still edits connections (they remain valid for runtime roles). Client flag `VITE_FEATURE_LOCAL_ENGINES=false` hides the test/models UI and renders the old plain rows.

## Risks / Trade-offs

- [Small local models produce malformed tool calls / ignore slash-command semantics] → tool-call JSON repair + error feedback loop (D6); docs state the recommended model class (≥ 30B coder or a tool-calling-tuned model) and the Freestyle mode as the friendlier first surface.
- [Runner diverges from claude frame semantics over time] → own parser + a shared fixture test that feeds runner output through the adapter and asserts the `AdapterEvent[]` shape; contract documented in `docs/internals/local-agent-runner.md`.
- [Detection probes hit a slow LAN box every 60 s] → probes are bounded (3000 ms), parallel with CLI probes, skipped when no connection exists; the card's manual Test is the only unthrottled call.
- [API key in env of a GUI-launched app is missing] → the card shows "env var `X` not set in this process" with the GUI-launch PATH/env guidance link; `apiKeyEnv` semantics unchanged (never stored).
- [Windows packaging: runner must be spawned via bundled node with `SystemRoot`] → reuse `resolveBundledNodeExe` + `windowsSpawnEnv` + `cross-spawn` exactly as the MCP bridge does.
- [Registry becomes mutable; a rail resolved an adapter that is later removed] → in-flight jobs keep the adapter instance they resolved (`_resolveJobAdapter` snapshots per job); removal only affects new resolutions; `getAdapter` still throws `UnknownProviderError` for gone ids so a stale rail engine falls back to the primary with a log notice (existing stale-engine path).
- [Cost shown as `—` may read as "free"] → analytics badge "cost unknown (local engine)" and the optional rates field; never a $0.

## Migration Plan

1. Ship the runner build (`build:local-runner`) in `build`, `build:desktop`, `dev:desktop:prepare`, `typecheck`, `package.json files`, `tauri.conf.json resources`.
2. Additive fields on `runtime-providers.json` (`label`, `defaultModel`, `rates`); old files load unchanged.
3. First boot: `syncLocalAdapters(loadRuntimeProviders())` then detection; existing `local` connections appear in selectors as soon as the probe succeeds.
4. Rollback: `SPECRAILS_LOCAL_ENGINES=false` (no data to undo; sessions dir is inert).

## Open Questions

- Should the local engine be offered for **Project Builder** day-0 generation? Default: no (needs structured/read-only guarantees the builder gates on `structuredActions`; the runner's `none` policy is sufficient technically, but 9B-class output quality would hurt the flagship flow). Revisit after the change ships.
- Effort mapping: expose `reasoning_effort` as an OpenAI `reasoning_effort` request field for endpoints that accept it (vLLM/llama.cpp ignore unknown fields)? Default: send it only when the connection sets `supportsReasoningEffort: true` (additive field, off by default).
