# Spec triage

Every spec gets a cheap triage that estimates its size and recommends the loop
to run it on. The rail header preselects that loop, and each launch records the
recommended and the chosen loop so loop economics can measure how often the
triage was right. OpenSpec change: `launch-triage`.

Code: the pure rules are in
[`server/modules/specs/domain/triage.ts`](../../server/modules/specs/domain/triage.ts).
The effects are in
[`runtime/triage.ts`](../../server/modules/specs/runtime/triage.ts), and the
provider call is in
[`runtime/triage-runner.ts`](../../server/modules/specs/runtime/triage-runner.ts).

## Record

The record lives in `ticket.metadata.triage`. It uses ticket store schema 1.5,
the same version Flow uses. Core ignores it.

```json
{
  "status": "ready",
  "size": "S",
  "filesLikely": ["server/modules/delivery/runtime/rails-router.ts"],
  "publicInterfaces": false,
  "dataModel": false,
  "securitySurface": false,
  "recommendedLoop": "factory:sdd-quick-openspec",
  "recommendedLoopName": "SDD Quick (OpenSpec)",
  "recommendedMode": "implement",
  "rationale": "Single file, no schema or API change",
  "confidence": "high",
  "inputsHash": "sha256:…",
  "model": "claude-haiku-5-5",
  "costUsd": 0.0031,
  "computedAt": "2026-10-22T10:12:00.000Z"
}
```

- `recommendedLoop` is always one of the loops offered to the triage. These are
  the rail built-ins the primary engine can run (Implement, Freestyle when the
  provider supports it, and SDD Quick when Loops are enabled), plus published
  spec-driven custom loops.
- Flow is not a loop. `recommendedMode: 'flow'` is a hint for exploratory work,
  and the triage gives it only when Flow is available.
- `costUsd` is the cost the provider reported, or the priced cost. It is `null`
  when the cost is unknown.
- When no usable model exists, the record is
  `{ status: 'unavailable', reason, inputsHash, computedAt }`. Nothing is
  spawned and no values are invented.
- An answer that cannot be repaired is stored as
  `{ status: 'failed', error, model, costUsd, … }`, with its real cost.

## Inputs and hash

The deterministic inputs come first:

- The bounded spec text: title, description, labels, priority and repository
  scope.
- The repository map: packages, ecosystems, size buckets and the README excerpt.
- Up to 30 files touched by the 5 most similar specs, taken from
  `file_provenance`. Similarity is Jaccard over title tokens and labels.
- The offered loops and Flow availability.
- The resolved `provider:model` and the prompt version.

The inputs are serialised as sorted-key JSON and hashed with sha256. Status,
timestamps and the stored triage are not inputs, so a status change or the
triage write itself never invalidates the hash. An automatic trigger skips a
spec whose stored `inputsHash` matches. Recalculate always runs.

## Engine and cost

The `triage` role engine in `loop-role-engines.json` wins when it names a
detected provider. Otherwise the triage uses the project's primary provider
and its cheapest priced catalog model, weighted by input price. See
[configuration](configuration.md#spec-triage-and-role-engines). Each run is one
pure-output turn with no tools and a 90-second timeout. It is recorded in
`ai_invocations` with surface `triage` and the spec's id, and the analytics
surfaces label it "Triage".

## Output parsing

The model must answer with one JSON object. The parser repairs what it can:

- It strips code fences and takes the first balanced object.
- It normalises the size and confidence spelling.
- It reads `"yes"` and `"no"` as booleans.
- It drops absolute paths and paths that climb out with `..`.
- It bounds the rationale.

An unknown loop falls back to a size rule, XS or S ⇒ SDD Quick when offered,
else Implement, and the confidence drops to `low`. With no JSON object or an
invalid size, the triage is stored as `failed`.

## Triggers

`SpecTriageService` (one per project) taps the project broadcast. Every
`ticket_created` or `ticket_updated` message schedules one scan after a 2-second
debounce. The scan compares a content signature per spec with the one it saw
before, and queues the `draft` and `todo` specs that are new or changed. The
signatures are seeded when the project opens, so the existing backlog is not
triaged in bulk. Those specs show a hover-only **Triage** action on their card
instead. Triages run one at a time per project.

Cancelled specs, epics and Flow-held specs are never triaged. The kill switch
`SPECRAILS_SPEC_TRIAGE=false` stops the automatic triggers.

## UI

- **Spec card chip:** shows size · recommended loop · confidence. The tooltip
  shows the rationale, the impact flags, the likely files, the model and cost,
  and **Recalculate** (`POST /tickets/:id/triage`).
- **Rail header:** when the rail has no explicit loop and is on its default mode,
  it preselects the recommended loop of its first triaged spec. This happens
  only if the picker offers that loop, and the option is marked "recommended".
  Any explicit choice wins. The launch uses the same rule.
- **Mission rail-launch card:** shows the structured triage per spec instead of
  the agent's prose rationale whenever the specs carry one.

## Delivery recording and accuracy

The launch route reads the ticket store on the server, so the measurement does
not trust the client. It records two columns on the isolated delivery row
(migration 76):

- `recommended_loop`: the recommendation of the first triaged spec in rail
  order.
- `chosen_loop`: the launched canonical loop id.

`getTriageAccuracy(db, { since? })` in
[`rail-pr-store.ts`](../../server/modules/delivery/runtime/rail-pr-store.ts)
returns `{ total, matched, rate }`. It counts root deliveries that carried a
recommendation. Launches without an isolated delivery are not counted.
