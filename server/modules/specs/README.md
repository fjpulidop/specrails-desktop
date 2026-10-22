# specs

This module owns the specs capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [domain/triage.ts](domain/triage.ts)
- [runtime/contract-refine-runner.ts](runtime/contract-refine-runner.ts)
- [runtime/generated-spec-parser.ts](runtime/generated-spec-parser.ts)
- [runtime/proposal-manager.ts](runtime/proposal-manager.ts)
- [runtime/smash-runner.ts](runtime/smash-runner.ts)
- [runtime/spec-addenda-core.ts](runtime/spec-addenda-core.ts)
- [runtime/spec-addenda.ts](runtime/spec-addenda.ts)
- [runtime/spec-contract-prompt.ts](runtime/spec-contract-prompt.ts)
- [runtime/spec-draft-parser.ts](runtime/spec-draft-parser.ts)
- [runtime/spec-generation.ts](runtime/spec-generation.ts)
- [runtime/spec-launcher-manager.ts](runtime/spec-launcher-manager.ts)
- [runtime/spec-models.ts](runtime/spec-models.ts)
- [runtime/ticket-store.ts](runtime/ticket-store.ts)
- [runtime/ticket-watcher.ts](runtime/ticket-watcher.ts)
- [runtime/triage.ts](runtime/triage.ts)

## Spec generation

[`runtime/spec-generation.ts`](runtime/spec-generation.ts) is the use case behind
`POST /tickets/generate-spec`: it builds the spec-gen prompts, spawns the
provider with `spec-gen` arguments and the scope's tool policy, parses the
`## Spec Title` / `## Labels` / `## Estimated Complexity` / `## Short Summary`
contract ([pure parser](runtime/generated-spec-parser.ts)), persists the ticket
and records `ai_invocations`. `generateSpecFromText` awaits the outcome;
`startSpecGeneration` spawns synchronously and returns `{ requestId, done }` so
the route can answer `202` only after a successful spawn.

Passing `ticketId` rewrites that ticket in place: id, status, metadata,
comments, ownership and attachments stay; title, description (with acceptance
criteria), labels, priority and short summary are replaced in the same format.
`contractRefine` schedules `runContractRefineForQuick` on the same provider after
persistence. The route keeps HTTP validation, `spec_gen_*`/`ticket_created`
messages, attachment migration and Jira promotion through `hooks`.

## Spec triage

[`domain/triage.ts`](domain/triage.ts) holds the pure rules, and the
architecture test pins it to zero imports. They cover canonical inputs,
similar-spec selection, the prompt, output parsing and repair, the rail
recommendation and the accuracy math.
[`runtime/triage.ts`](runtime/triage.ts) has `SpecTriageService`. It gathers the
inputs (ticket store, repo map, `file_provenance`, loops, Flow availability),
hashes them and runs one call through
[`runtime/triage-runner.ts`](runtime/triage-runner.ts) on the `triage` role
engine. It then writes `metadata.triage` and records `ai_invocations`
(surface `triage`). The project registry composes the service and feeds it the
project broadcast. `POST /tickets/:id/triage` forces a recalculation. See
[spec triage](../../../docs/internals/spec-triage.md).

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/specs` and any affected consumers.
