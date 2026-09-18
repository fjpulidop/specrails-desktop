## Why

The programmatic runtime already lets each pipeline role (architect, developer, reviewer) name its own provider and model — cloud or local, mixed freely — in `agent-runtime.json` (Settings ▸ Specrails Agents ▸ runtime). But a rail launch flattened that: the engine picked in the rail header became a `runtimeProviderOverride` applied to all three roles, and the loop's own AI steps (verify/fix and the Loop Decider) always inherited the rail engine. A hybrid setup — architect on a cloud model where judgement matters, developer on a local model where volume matters, a cheap model deciding the loop — was configurable and then silently ignored at launch.

## What Changes

- **`roles` rail engine.** The rail engine selector gains a **Roles** option (sentinel `aiEngine: 'roles'`, accepted by `PUT /rails/:i/engine` and the launch body, MCP `specrails_rails` included). A roles launch carries NO provider override: Core runs architect/developer/reviewer on their configured per-role engines.
- **Loop roles.** Two new per-project role engines, `verifier` (every non-core ai-step of the loop: verify, fix, custom ai-steps) and `decider` (the Loop Decider), stored in `<workspace>/.specrails/loop-role-engines.json` next to `agent-runtime.json`, edited in a new **Loop roles** block of Settings ▸ Specrails Agents, exposed as `GET/PUT /:projectId/agent-runtime/loop-roles`. Absent role ⇒ the project's primary engine.
- **Resolution at launch.** Under `roles`, the loop's provider/model/effort come from the verifier role (validated against the detected providers; a stale model falls back to the adapter default, an unsupported effort is dropped) and the Loop Decider runs on the decider role (`LoopRunRequest.deciderEngine`), which must enforce a read-only tool policy like the rail's engine does today. The rail header hides model/effort/profile selectors under roles and shows a chip instead.
- **Guards.** Freestyle has no roles ⇒ `400 roles_engine_unsupported_mode`. A roles launch with an explicit `runtimeProviderOverride` ⇒ `400 runtime_provider_mismatch`. Loops off (legacy QueueManager path) ⇒ the roles launch degrades to the primary engine.
- **Byte-identical otherwise.** A rail on a concrete engine behaves exactly as before; CLI providers and local engines untouched.

## Capabilities

### New Capabilities
- `hybrid-role-engines`: the `roles` engine, the two loop roles, their storage/REST/UI, and launch-time resolution.

### Modified Capabilities
- `multi-provider-architecture`: `aiEngine` admits the `roles` sentinel on rails.

## Impact

- **Server:** `server/loop-role-engines.ts` (new), `server/rails-router.ts` (roles mode at launch + `PUT /engine`), `server/rail-isolated-launch.ts` + `server/loop-run-manager.ts` (`deciderEngine` pass-through), `server/agent-runtime-settings-router.ts` (loop-roles routes), `server/mcp/tools/rails.ts` (description).
- **Client:** `RailEngineSelector`, `RailRow`, `DashboardPage`, `AgentRuntimeSettingsSection` (Loop roles block), `lib/provider-capabilities.ts`; i18n `agents`/`dashboard`/`agentRuntime` ×8.
- **Core:** none (per-role config already supported).
- **Docs:** `docs/local-providers.md` (hybrid section), CLAUDE.md.
