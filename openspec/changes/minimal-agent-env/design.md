## Context

Before this change three places built an agent's base environment: `QueueManager` (`process.env` plus the passthrough overlay), the loop executors' base-env thunk in `project-registry.ts` (`resolveLoopBaseEnv` over the same overlay) and `buildProviderEnv` (adapter overrides on any base). Missions, chats and spec helpers used `process.env` directly. Provider adapters already own provider knowledge (`buildEnv`), and project settings own the passthrough names.

## Goals / Non-Goals

**Goals:** opt-in minimal environment per project; `inherit` identical to today; provider auth names owned by adapters; one builder for every project agent spawn path; names-only status.

**Non-Goals:** filtering verification commands (Core already applies a deny-list); journal redaction (Core); changing the setup wizard and non-project helper spawns.

## Decisions

1. **Filter the base, overlay afterwards.** The builder filters only the Desktop environment and the passthrough values. Specrails' per-spawn overlays (telemetry `OTEL_*`, profile, repo map, relocation, adapter `buildEnv`) are applied by the callers on top, so they keep working in minimal mode. Callers whose base already includes a `SPECRAILS_*` relocation overlay pass it as `sourceEnv`; `SPECRAILS_*` is allowlisted, so the overlay survives.
2. **Pure policy in the execution core.** `buildAgentEnv`, `minimalAgentEnvNames` and the allowlists live in `server/modules/execution/domain/agent-env.ts` with no imports, guarded by the architecture test. `server/project-env.ts` binds it to a project connection (mode, passthrough values, login-shell recovery).
3. **Inherit is returned untouched.** `resolveProjectAgentEnv(db)` returns exactly `applyWorktreeEnvPassthrough(db, process.env)` in inherit mode, and `projectAgentSourceEnv(db, …, source)` returns `source` itself, so paths that never applied the overlay keep their previous object.
4. **Provider names on the adapter.** `ProviderAdapter.envAllowlist` (patterns, trailing `*` = prefix). `providerEnvAllowlist(adapters)` merges one or several adapters. Core-hosted work receives the union of registered adapters because Core may launch any configured role provider; plain AI steps and deciders receive their adapter's names; loop shell steps receive none.
5. **Windows.** Windows names are matched case-insensitively only on `win32`. `windowsSpawnEnv` is still applied at spawn time and backfills canonical values.
6. **Mission session host.** The Core host launcher accepts `env` as a per-scope resolver; the composition maps a project scope to its loaded project and applies the mode at host start. A running host keeps its environment until it restarts (documented).
7. **Agents cannot widen their environment.** The mode is changed only through the project settings PATCH used by the UI; the MCP `specrails_env` tool reports it read-only.

## Risks / Trade-offs

- A tool that needs an unlisted variable (for example `JAVA_HOME`, `AWS_PROFILE` for Bedrock) fails in minimal mode → the UI explains it and the passthrough list is the escape hatch; minimal is opt-in.
- Prefix patterns (`ANTHROPIC_*`, `GEMINI_*`) admit future variables of that provider → acceptable; they are scoped to the provider's own namespace.
- Some helper spawns stay on `inherit` behavior → listed in the documentation as not covered yet.
