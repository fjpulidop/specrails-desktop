# specs

This module owns the specs capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

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

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/specs` and any affected consumers.
