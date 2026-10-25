## Context

The ticket store is shared with Core and stays at schema 1.5. Spec addenda (`docs/internals/spec-addenda.md`) already carry structured notes into every launch door, including the `clarification` kind. Core (contract 5.7) records the architect's clarifications in `<pipeline>/<runId>/clarifications.json` (engine 2 implementation pieces: the newest `<runId[0..80]>-impl-*` directory).

## Goals / Non-Goals

**Goals:** one structured place for non-goals that every agent still sees; questions answered where the stakeholders are; idempotent, durable Jira writes.

**Non-Goals:** importing Jira threads in general; resuming a paused run from a Jira reply; writing non-goals to Jira; changing the Contract Layer.

## Decisions

- **Field, not description.** Non-goals move out of the description so the modal shows them once; `descriptionWithNonGoals` re-appends them at the two spec-building points (loop `getTicketSpec`, Freestyle prompt), unless the description still has its own section (older tickets).
- **No schema bump.** Optional, additive and absent when empty, so older tickets round-trip byte-identically.
- **Observer, not polling.** `LoopRunManager` exposes `onDefinitionInvocationEnd`; the composition reads the record after every invocation (a pause is seen while it waits for a human) and again when the run finishes. Without the Core capability no record exists, so nothing is posted.
- **Durable and idempotent.** Comments go through the existing outbox with marker `[specrails:clarifications=<runId>:ticket=<id>:<digest>]`; a thread row (migration 77) remembers which replies were imported. Replies are human comments after the marker comment, read for 14 days.

## Risks / Trade-offs

- A reply that is not an answer is still recorded as a clarification → it is an open addendum the user can dismiss before the next launch.
- A minimized Explore session does not park manual non-goal edits → the agent's latest list still arrives.
