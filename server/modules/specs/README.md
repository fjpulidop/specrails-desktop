# specs

This module owns the specs capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [domain/non-goals.ts](domain/non-goals.ts)
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
- [runtime/ticket-trash-service.ts](runtime/ticket-trash-service.ts)
- [runtime/ticket-trash.ts](runtime/ticket-trash.ts)
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

## Non-goals

[`domain/non-goals.ts`](domain/non-goals.ts) is pure (pinned to zero imports):
validation and bounds of the optional ticket field `nonGoals` ("Out of scope",
schema 1.5, additive), extraction of a `## Out of Scope` section, and
`descriptionWithNonGoals`, which the loop spec lookup and the Freestyle prompt
use so agents keep seeing the non-goals. Quick generation and Explore drafts
fill the field; the Contract Layer is unchanged. See
[existing-project anchoring](../../../docs/internals/existing-project-anchoring.md#non-goals-out-of-scope).

## Spec triage

[`domain/triage.ts`](domain/triage.ts) holds the pure rules, and the
architecture test pins it to zero imports. They cover canonical inputs,
similar-spec selection, the prompt, output parsing and repair, the rail
recommendation and the accuracy math.
[`runtime/triage.ts`](runtime/triage.ts) has `SpecTriageService`. It gathers the
inputs (ticket store, repo map, `file_provenance`, loops), hashes them and runs one call through
[`runtime/triage-runner.ts`](runtime/triage-runner.ts) on the `triage` role
engine. It then writes `metadata.triage` and records `ai_invocations`
(surface `triage`). The project registry composes the service and feeds it the
project broadcast. `POST /tickets/:id/triage` forces a recalculation. The
triage recommends a loop and a size for Implement only: Flow and Implement
never compete, so it never ranks them (a legacy `recommendedMode` stays
readable and is ignored). See
[spec triage](../../../docs/internals/spec-triage.md).

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/specs` and any affected consumers.

## Recently deleted (soft delete)

`DELETE /tickets/:id` no longer removes a spec: [`runtime/ticket-trash.ts`](runtime/ticket-trash.ts)
moves it to a sidecar `<store>.trash.json` next to the ticket store. The store is
shared with specrails-core, so a `deleted_at` flag inside it would leave deleted
specs visible to Core and to every direct reader; moving the entry hides it from
every list, search, API and Core read at once. Restore moves it back under the
same id (ids are never reused: `next_id` is monotonic) and re-adopts the children
a deleted epic orphaned when they are still parentless.

- Crash safety: delete writes the trash entry before removing the live spec and
  restore removes the entry after re-inserting, so a crash leaves a spec in both
  places, never in neither. A live spec is never overwritten by its trash copy.
- Retention: 30 days. [`runtime/ticket-trash-service.ts`](runtime/ticket-trash-service.ts)
  purges expired entries at project start, every 6 hours, and when the trash is
  listed. A permanent removal (purge or "Delete permanently") runs the cascade a
  hard delete used to run (attachments, the orphan Explore draft conversation);
  a soft delete keeps both so Undo is lossless.
- Jira: a spec delete never wrote to Jira (Jira-backed specs use "Move to"), so a
  delete followed by a restore is invisible to it. Label-only edits hold their
  outbound `update` for the 10 s undo window (`enqueueHeldUpdate` in
  `server/jira/jira-db.ts`): an edit undone inside the window collapses with it
  and Jira never sees the transient value.
- Missions are soft-deleted separately: `agent_conversations.deleted_at`
  (desktop DB migration 37), see [agent chat routes](../missions/runtime/agent-chat-router.ts).
- HTTP: `GET /tickets/trash`, `POST /tickets/:id/restore`,
  `DELETE /tickets/trash/:id` ([API reference](../../../docs/internals/api-reference.md)).
