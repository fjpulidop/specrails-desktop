## Why

The compact (local-model) runtime accumulated a dozen process guardrails — validated plans, frozen planning artifacts, one test file per module, evidence-gated task ticking, host-side environment repair, a silence timeout for hanging tests. They exist so a 7–30B developer does not derail, they are all implicit, and nobody can see them or tune them. A user who wants to experiment ("what if the model is allowed to add a second test file?") has no switch, and a user who hits one ("why was my write refused?") has no list to consult.

## What Changes

- **Catalog in Core.** `src/agent-runtime/guardrails.ts` names every configurable guardrail (stable id + phase). Pure correctness fixes (candidate fingerprint, correction counter, argument repair) are deliberately excluded.
- **Config field.** `RuntimeConfig.guardrails?: { [id]: boolean }` in `agent-runtime.json` (schema + `validateRuntimeConfig`), rides `AgentRequest.guardrails` into `CompactEnv`; every guard checks `on(env, id)` and behaves as before when unset. Host guards (`environment-repair`, `lockfile-repair`, `verify-idle-timeout`) are read from the config in the verify node.
- **Capability.** Core advertises `configurableGuardrails: 1` and the catalog on the `runtime-api` frame; Desktop forwards `guardrails` to Core only when advertised (`forCoreRuntime`) and exposes `GET /:projectId/agent-runtime/guardrails` (`{ supported, catalog }`).
- **UI.** Project settings ▸ Agent engine ▸ **Guardrails**: the catalog grouped by phase, every switch on by default, title/description/why per id, "N of M active", reset. Persists through the existing runtime-config save.
- CLI providers are never affected (the compact loop is local-engine only).

## Capabilities

### New Capabilities
- `configurable-guardrails`: catalog, config field, capability gate, REST, UI.

## Impact

- **Core:** `guardrails.ts` (new), `config.ts`, `executor-types.ts`, `schemas/agent-runtime.schema.json`, `graph/roles.ts`, `graph/nodes.ts`, `openai-executor.ts`, `compact/{step,developer,architect,environment}.ts`, `installer/runtime/pipeline-state.ts` (`idleTimeoutMs` option), `cli.ts` (capability + catalog).
- **Desktop:** vendored schema (byte-identical), `agent-runtime-settings.ts` (`guardrails`, `forCoreRuntime`), `agent-runtime-bridge.ts`, `agent-runtime-settings-router.ts` (route), `agent-runtime-loader.ts` (api shape), client `AgentRuntimeSettingsSection` + guardrails block, i18n ×8, docs.
