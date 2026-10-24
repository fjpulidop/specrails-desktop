## Why

Specs generated from an idea say what to build but rarely what to leave alone, so implementers widen them. The "Out of Scope" section lived inside the description where nobody edited it. And when Core's architect asks clarification questions before planning (Core `architectClarifications: 1`, contract 5.7), the people who can answer them often live in Jira, not in Specrails. This is Phase 3 task 3.2 (Desktop) of the feedback-2026-10 program.

## What Changes

- **Ticket field `nonGoals`.** An optional `string[]` on the ticket ("Out of scope"), additive at schema 1.5 (no bump: Core ignores unknown ticket fields). Validated and bounded by a pure domain module.
- **Generation fills it.** Quick asks for 1–5 non-goals and the parser moves the `## Out of Scope` section into the field. Explore's `spec-draft` schema gains `nonGoals` (edited in the draft panel); `from-draft` takes it or moves the section. The Contract Layer is unchanged.
- **Editable.** The ticket modal shows **Out of scope** under the description, one item per line. `POST /tickets`, `PATCH /tickets/:id` and `from-draft` accept `nonGoals` (400 when malformed). Never written back to Jira.
- **Agents still see it.** The loop spec lookup and the Freestyle prompt append `## Out of Scope` to the description they hand an agent.
- **Jira clarifications.** Project setting `jiraPostClarifications` (default off). When a run pauses with the architect's questions or proceeds on assumptions (`clarifications.json`), Desktop enqueues one durable outbox comment per linked issue (idempotency key per run, ticket and record content). A human reply after that comment is imported once as a spec addendum of kind `clarification`.

## Capabilities

### New Capabilities
- `ticket-non-goals`: an editable "Out of scope" list per spec, filled by spec generation and carried to every agent.
- `jira-architect-clarifications`: architect questions and assumptions posted to the linked Jira issue, with replies recorded as clarification addenda.

## Impact

- **Server:** `modules/specs` (`domain/non-goals.ts`, `ticket-store.ts`, `generated-spec-parser.ts`, `spec-generation.ts`, `spec-draft-parser.ts`), `project-router-tickets.ts`, `command-resolver.ts` (Explore prompt), `project-registry.ts` (`getTicketSpec`, clarifications publisher), `execution/runtime/queue-manager.ts` (Freestyle prompt), `modules/project-settings`, `jira/jira-clarifications.ts`, `jira/jira-sync-manager.ts`, `jira/jira-client.ts`, `loops/runtime/loop-run-manager.ts` (invocation-end observer), `delivery/runtime/run-records.ts`, migration 77 (`jira_clarification_threads`).
- **Client:** `NonGoalsSection`, `TicketDetailModal`, Explore draft (`spec-draft.ts`, `SpecDraftPanel`, `ExploreSpecShell`), settings switch, locales (tickets, explore, settings ×8).
- **Docs:** existing-project anchoring, spec addenda, API reference, configuration, user guide.
