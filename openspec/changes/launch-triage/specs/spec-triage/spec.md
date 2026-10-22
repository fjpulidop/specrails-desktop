## ADDED Requirements

### Requirement: Triage is computed from hashed deterministic inputs
The app SHALL compute a spec's triage from deterministic inputs — the bounded
ticket text, the deterministic repository map, the files touched by similar
tickets according to `file_provenance`, the available loop ids, Flow
availability, the resolved engine and the prompt version — canonicalised as
sorted-key JSON and hashed with sha256 into `inputsHash`. When the stored triage
carries the same `inputsHash`, an automatic trigger SHALL NOT recompute it.

#### Scenario: Stable hash
- **WHEN** the same inputs are canonicalised twice with keys in a different order
- **THEN** both produce the same `inputsHash`

#### Scenario: Unchanged spec is not recomputed
- **WHEN** an automatic trigger fires for a spec whose stored `inputsHash` equals the current one
- **THEN** no provider process is spawned and the stored triage is kept

### Requirement: Triage output follows annex D.2 and never invents values
A successful triage SHALL be stored in `metadata.triage` as
`{ status: 'ready', size, filesLikely, publicInterfaces, dataModel, securitySurface, recommendedLoop, recommendedLoopName, recommendedMode, rationale, confidence, inputsHash, model, costUsd, computedAt }`,
where `size` is one of XS, S, M, L, XL, `confidence` one of high, medium, low,
`recommendedLoop` one of the loop ids offered to the triage and `recommendedMode`
is `flow` only when Flow is available. `costUsd` SHALL be the provider-reported or
priced cost, or `null` when unknown. When no usable model exists the app SHALL
store `{ status: 'unavailable', reason, inputsHash, computedAt }` without spawning.
An answer that cannot be repaired SHALL be stored as `failed` with its real cost.

#### Scenario: No model available
- **WHEN** the triage engine's provider is not detected or cannot enforce a pure-output tool policy
- **THEN** `metadata.triage` is `{ status: 'unavailable', ... }` with no size, loop or confidence

#### Scenario: Repaired output
- **WHEN** the model answers fenced JSON with a lowercase size and an unknown loop id
- **THEN** the size is normalised and the loop falls back to the deterministic size rule with `confidence: 'low'`

### Requirement: Triage triggers are asynchronous, debounced and on demand
Creating or editing a `draft` or `todo` spec through any door SHALL schedule its
triage asynchronously after a debounce, without blocking the request that
changed the spec. Specs present when the project opened SHALL NOT be triaged
until they change or are recalculated. `POST /:projectId/tickets/:id/triage`
SHALL force a recalculation and return the stored record; it SHALL answer `404`
for an unknown spec and `409 triage_not_applicable` for a cancelled spec, an epic
or a Flow-held spec. Each spawned triage SHALL be recorded in `ai_invocations`
with surface `triage` and the spec's id.

#### Scenario: Burst of edits
- **WHEN** a spec is edited three times within the debounce window
- **THEN** a single triage runs for it

#### Scenario: Recalculate
- **WHEN** the user presses Recalculate on a spec whose inputs did not change
- **THEN** the triage runs again and replaces the stored record

### Requirement: The rail preselects the recommended loop
The rail header SHALL preselect the recommended loop of the first spec on the
rail with a ready triage while the rail has no explicit loop choice and the loop
is offered by the selector, and mark that option as recommended. An explicit
choice by the user SHALL always win. The spec card SHALL show a triage chip with
size, recommended loop and confidence, whose tooltip shows the rationale and a
Recalculate action. The mission rail-launch card SHALL show the structured
triage of its specs instead of the prose rationale when present.

#### Scenario: Preselection
- **WHEN** a spec triaged with `recommendedLoop: 'factory:sdd-quick-openspec'` is assigned to a rail without an explicit loop and loops are enabled
- **THEN** the rail's selected loop is Quick SDD

#### Scenario: Override
- **WHEN** the user then picks Implement on that rail
- **THEN** the rail launches Implement

### Requirement: Deliveries record the recommended and chosen loop
Each isolated rail launch SHALL store `recommended_loop` (the first triaged spec's
recommendation, or null) and `chosen_loop` (the launched loop id) on its
`rail_pr_deliveries` row, and `getTriageAccuracy` SHALL return
`{ total, matched, rate }` over root deliveries that carry a recommendation.

#### Scenario: Launch records the choice
- **WHEN** a rail whose spec recommends Quick SDD launches Implement
- **THEN** the delivery row has `recommended_loop = 'factory:sdd-quick-openspec'` and `chosen_loop = 'factory:implement'`, and the accuracy counts it as unmatched
