# Proposal

## Why

A spec created from a mission conversation with a selected provider (e.g. Codex) can still run derived AI steps on another provider. In the reported case spec #17 was saved from a Codex mission but its automatic triage ran on Claude (`claude exit code=1`), consuming the wrong provider's quota. Triage resolves its engine from the project primary provider or the `triage` role, never from the mission. Contract refinement already honours the mission provider on the agent-authored path and must be preserved.

## What Changes

- Capture the mission provider (`agentProvider`) once, at save time in `POST /tickets/from-draft`, from the authenticated MCP `commit_draft` context, and pin it to the created spec as an immutable per-operation value.
- `SpecTriageService` receives the pinned provider per queued operation (not via shared resolver state) and `resolveTriageEngine` takes an optional provider override that wins over the project primary provider and the `triage` role engine. The model is chosen from that provider's catalog (stored role model only if valid for that provider, else cheapest).
- If the pinned provider is not enabled, not registered, or lacks the pure-output tool policy, triage records `unavailable` with the step and reason; it never falls back to another provider.
- Inventory every mission-reachable creation path (`commit_draft` agent-authored, Explore-origin from-draft, from-prompt, generate-spec, manual contract-refine/triage retries, ai-edit) and verify each AI step receives the mission provider or reports a limitation. Fix any path found to lose it.
- Post-save failures (triage, contract refine) never remove or regenerate the saved spec; the failing step and reason are reported separately from save success (broadcast/record), without duplicates.
- Diagnostics and accounting (`recordInvocation`, `metadata.triage`) already record actual provider/model; keep that and assert it.
- Out of scope: rails/loops provider selection, global project/triage-role settings, spec #17, new provider capabilities, and the root cause of the Claude CLI exit 1.

## Capabilities

### New Capabilities
- `spec-creation-provider-affinity`: AI steps derived from creating a spec in a mission run on the mission's provider, with no silent fallback and with isolated, immutable per-operation context.

### Modified Capabilities

## Impact

- `server/mcp/tools/specs.ts`, `server/project-router-tickets.ts`, `server/modules/specs/runtime/triage.ts` (and `project-registry.ts` wiring only if needed), reading `triage-runner.ts` unchanged.
- Tests under `server/` for propagation, concurrency, selector change, incompatible providers, post-save failures, no-mission and external MCP behavior, accounting.
- Docs: `server/modules/specs/README.md`, `docs/internals/api-reference.md` for the `agentProvider` field.
