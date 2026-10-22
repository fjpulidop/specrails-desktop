## Why

Correction rounds (a failed verification, a rejected review) were just another developer visit: same engine, same 9 KB plan dump ahead of the feedback, same OpenSpec apply guidance. A small local developer re-read the whole repository before its first patch, and there was no way to put a stronger model on repairs while keeping a cheap one on volume — the hybrid split that pays off most.

## What Changes

- **Fixer stance (Core, compact).** Every correction round runs with a dedicated stance: the verifier's exact output and host-read excerpts lead, only the plan tasks whose files the failure names follow, no scope/design/specs dump, no re-implementation. Log line `Compact fixer: …`. Applies to the verify ⇄ fixer ping-pong, review rejections and the per-group check's in-place fix.
- **Fixer engine (Core config).** Optional top-level `fixer: { provider, model?, effort?, maxTurns?, escalation? }` in `agent-runtime.json` (schema + `validateRuntimeConfig`). When set, the developer node invokes correction rounds with `agentOverride: fixer` + `stance: 'fixer'` (fresh session, `Fixer route:` note, developer role state untouched); first passes and continuations of unchecked tasks stay on the developer. Absent ⇒ the developer corrects, as before.
- **Desktop.** `RuntimeConfig.fixer`, vendored schema synced, default-model fill + launch override + log banner cover the fixer, and the pipeline stepper gains phase 4 **Fixer** (between Verification and Reviewer) with "Inherit developer" (default) vs "Own engine" and the usual role fields.
- CLI providers: a fixer may be a CLI engine too (the override is provider-agnostic); the compact stance applies to local engines.

## Capabilities

### New Capabilities
- `fixer-role`: stance, optional engine, routing rule, UI.

## Impact

- **Core:** `executor-types.ts` (`RuntimeConfig.fixer`, `AgentRequest.stance`), `config.ts` (`validateAgent` extracted), `schemas/agent-runtime.schema.json`, `graph/roles.ts` (`agentOverride`/`stance`), `graph/nodes.ts` (correction detection), `openai-executor.ts`, `compact/{step,developer}.ts`.
- **Desktop:** `agent-runtime-settings.ts`, `agent-runtime-effective-config.ts`, `agent-runtime-bridge.ts`, vendored schema, `PipelineStepper` + `AgentRuntimeSettingsSection`, i18n ×8, docs.
