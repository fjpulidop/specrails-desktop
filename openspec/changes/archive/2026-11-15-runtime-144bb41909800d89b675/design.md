# Design

## Context

- `commit_draft` (`server/mcp/tools/specs.ts:448-473`) derives `agentProvider` from the origin conversation only for first-party calls and sends it to `POST /tickets/from-draft`. External MCP clients send none.
- `from-draft` (`server/project-router-tickets.ts`, ~860-960) validates it with `validateRequestedProvider` and passes `providerId` to the contract runner; unsupported providers broadcast `explore.contract_refine_failed` with `provider-unsupported`.
- `SpecTriageService` (`server/modules/specs/runtime/triage.ts`) is triggered by the ticket broadcast: `observe` -> debounced `scan` -> `enqueue(ticketId)` -> `run`, where `resolveTriageEngine(project)` picks the `triage` role engine or the primary provider. The mission provider is lost here; this is the leak.
- `triage-runner.ts` executes the given provider/model and reports usage; it needs no change.

See proposal.md for motivation.

## Goals / Non-Goals

**Goals:** carry the mission provider as an immutable per-operation value to triage; no fallback; inventory all creation paths; keep accounting.

**Non-Goals:** rails/loops provider selection, global or triage-role settings, spec #17, new provider capabilities, fixing the Claude CLI exit 1.

## Decisions

1. **Per-ticket pin, not resolver state.** Add `SpecTriageService.pinProvider(ticketId, provider)` storing the value in a `Map<number,string>` keyed by ticket id, called synchronously in `from-draft` right after the ticket is written and before the `ticket_created` broadcast (the scan is debounced 2s, so the pin precedes it). `run` reads the pin at execution time. Keying by ticket makes concurrent missions and later selector changes irrelevant, since the value was captured at save time. Alternative rejected: a service-level "current provider" field, which would mix concurrent operations.
2. **Override precedence.** `resolveTriageEngine(project, opts?: { provider?: string })`: an override wins over the primary provider and the stored triage role. The role model is reused only if valid for that provider; otherwise `cheapestModelForProvider`. Without an override behavior is identical to today (no-mission and external MCP unchanged). Settings are only read, never written. The `resolveEngine` test seam gains the same optional argument.
3. **No fallback.** With an override, a disabled, unregistered or tool-policy-unsupported provider returns `{ok:false, reason}` (existing reason strings) and `run` stores an `unavailable` triage record naming the reason. The pin is kept until a terminal record is written, then dropped.
4. **Contract path.** Keep the `agentProvider` -> `providerId` translation. Verify the Explore-origin (`convoProvider`), agent-authored and `/contract-refine` retry branches; fix any branch that passes no validated mission provider or silently picks another.
5. **Failure reporting.** Save returns 201 before enrichment. Triage failure is stored in `metadata.triage` (failed/unavailable with reason); contract failure keeps `explore.contract_refine_failed` with provider, ticketId and reason. No step edits content or repositories or creates tickets.
6. **Accounting.** `recordInvocation` already writes the actual provider and model; tests assert them for pinned runs.

## Creation path inventory (confirm in implementation)

| Path | AI steps | Provider source |
| --- | --- | --- |
| MCP `commit_draft` agent-authored -> from-draft | contract refine, triage | origin conversation provider (pinned) |
| from-draft with conversationId/draftTicketId | contract refine, triage | conversation provider; pin when known |
| `from-prompt` | triage only via watcher | no mission context; unchanged |
| `generate-spec` | generation, contract | validated requested engine; verify |
| `/contract-refine`, `/triage` retries | contract, triage | explicit/project; unchanged |
| `ai-edit` | edit | validated requested provider; verify |

Capabilities: triage needs `pureOutputToolPolicy`; contract refine needs `supportsContractRefine`. Record per-provider support (Claude, Codex, local) in `server/modules/specs/README.md`.

## Risks / Trade-offs

- Pin lost on restart -> startup seeding marks existing specs as seen, so no cross-provider run occurs.
- A pin left unconsumed (disposed service) -> in-memory only, harmless.
- Claude exit code 1 cause stays unexplained -> documented as out of scope.
