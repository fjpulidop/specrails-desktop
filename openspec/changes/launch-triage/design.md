## Context

Specs are created through many doors (manual form, quick/explore generation,
drafts, MCP, Jira materialisation, project builder, Flow). All of them persist
through the ticket store and announce the change with a `ticket_created` /
`ticket_updated` broadcast; external writers (Core, the CLI) are announced by the
ticket watcher as a full refresh (`ticket.id === 0`). Loops are chosen per rail in
the rail header (`selectedLoopId`, persisted client-side) and frozen per launch in
`rail_pr_deliveries.loop_id`.

## Goals / Non-Goals

**Goals:** a cheap, reproducible triage per spec; reuse across restarts; never
invent a recommendation; measurable accuracy.

**Non-goals:** the Flow-vs-Implement offer inside the mission (separate change);
blocking spec creation on AI; triaging the historical backlog automatically.

## Decisions

1. **Pure domain + effectful runtime.** `specs/domain/triage.ts` has no imports:
   canonical inputs, prompt, output parsing/repair, similarity, recommendation and
   accuracy math. `specs/runtime/triage.ts` gathers inputs (store, repo map,
   provenance, loops), hashes with `node:crypto`, spawns the provider and writes
   back. The architecture test pins the domain to zero dependencies.
2. **Hash = sha256 of canonical JSON** (sorted keys) of: bounded ticket text
   (title, description, labels, priority, repository scope), repo map, similar
   files, available loop ids, Flow availability, the resolved `provider:model`
   and the prompt version. Status, timestamps and `metadata.triage` are excluded
   so a triage write or a status move never invalidates it.
3. **Triggers observe broadcasts.** One per-project `SpecTriageService` taps the
   bound broadcast (like the milestone progress tap). Every observed ticket
   message schedules one debounced scan (2 s) that compares a content signature
   per eligible spec (`draft`/`todo`, not an epic, not Flow-held) with the one
   seen before; new or changed specs are queued. The seen-map is seeded at
   startup, so upgrading never triages the old backlog in bulk. The queue runs
   one triage at a time per project; the hash check makes repeated scheduling
   idempotent. On-demand recalculation is forced and allowed for any status but
   `cancelled`.
4. **Engine.** `triage` is a Desktop-owned role engine next to `verifier` and
   `decider`. Absent ⇒ the derived primary provider and its cheapest priced
   catalog model (pricing table, input-weighted); unpriced catalogs fall back to
   the adapter default. The provider must be detected, registered and able to
   enforce the pure-output tool policy; otherwise the record is
   `{ status: 'unavailable', reason }` and nothing spawns.
5. **Structured output with repair.** The model is asked for one JSON object.
   The parser strips fences, extracts the first balanced object, normalises enums
   (`s` → `S`, `"yes"` → `true`), bounds strings and paths, drops absolute or
   escaping paths and maps an unknown loop to the deterministic size rule (XS/S ⇒
   Quick SDD when offered, else Implement) with `confidence: 'low'`. An invalid
   size or no JSON ⇒ `failed`, recorded with the real cost.
6. **Preselection is derived, not stored.** `effectiveLoopId` takes the rail's
   recommended loop as the last fallback before the mode default, so a rail with
   no explicit choice follows the triage of its first triaged spec (and updates
   when the triage lands). Any explicit pick (`selectedLoopId`) wins. Only loops
   the selector offers are preselected.
7. **Recording at launch is server-side.** The launch route reads the ticket
   store and records `recommended_loop` (first triaged spec in rail order) and
   `chosen_loop` (the launched canonical loop id) on the delivery row, so the
   measurement does not trust the client. Migration 76 appends both columns.

## Risks / Trade-offs

- Repo map or provenance changes make old hashes stale; they are recomputed only
  on the next edit or a manual Recalculate, which keeps cost bounded.
- Launches without an isolated delivery (shared-cwd fallback) are not counted by
  the accuracy aggregate.
- The `triage` role has no settings UI yet; it is configurable through
  `PUT /agent-runtime/loop-roles` and documented.
