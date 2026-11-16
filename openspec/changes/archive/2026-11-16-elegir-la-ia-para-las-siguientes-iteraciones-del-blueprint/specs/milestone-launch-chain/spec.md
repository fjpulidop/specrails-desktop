# Spec Delta

## MODIFIED Requirements

### Requirement: Milestone launch is a server-owned chain
`POST /:projectId/blueprint/milestones/:n/launch { autoAdvance?, engine? }` SHALL gather that milestone's `M<n>` `todo` tickets, order them by their dependencies (a stable topological order over `prerequisites` restricted to those tickets, ties broken by `execution_order` — unset last — and then id; a dependency cycle SHALL NOT block the milestone), put exactly ONE spec on each rail (rails named `M<n> · #<id>`, launched with mode `implement`), persist ONE `milestone_launch_chains` row (per-project SQLite, additive migration) and launch through the ordinary rails launch path so every existing launch guard applies unchanged. Launches SHALL always be sequential: only the first spec launches immediately. A request carrying the retired `mode: 'parallel'` SHALL be accepted and run sequentially; any other `mode` value SHALL be rejected with 400. At most one non-terminal chain SHALL exist per milestone; a second launch while one exists SHALL return 409 `chain_active` with the chain id. An optional engine selection SHALL be validated against the compatible installed provider/model/effort catalog before chain creation; invalid selections SHALL return 400 without starting a chain. The route SHALL return 202 `{ chainId, mode: 'sequential', launched: [{ railIndex, ticketIds }], pending: number[][] }`. The client "Launch Milestone" actions (Builder done screen, sidebar flyout) SHALL call this route, SHALL NOT offer a Sequential/Parallel choice and SHALL NOT keep any launch plan in browser storage. Completed chain rows recorded with `mode = 'parallel'` before this change SHALL still render.

#### Scenario: Sequential launch starts one rail with one spec
- **WHEN** M1 has 3 `todo` tickets and the user launches M1
- **THEN** one rail carrying 1 spec launches, the chain row records `next_chunk = 1` with two pending one-spec chunks, and the response lists the launched rail and the pending chunks

#### Scenario: Dependencies decide the order
- **WHEN** M1 spec #1 lists spec #2 as a prerequisite
- **THEN** spec #2 launches before spec #1 regardless of their ids

#### Scenario: A parallel request runs sequentially
- **WHEN** an old client posts `mode: 'parallel'`
- **THEN** the route returns 202 with `mode: 'sequential'` and only the first spec launches

#### Scenario: Guard rejection is typed
- **WHEN** the first spec's launch is rejected by an existing guard (for example `tickets_in_flight`)
- **THEN** the route returns that guard's status and error unchanged and no chain row remains active

#### Scenario: Duplicate launch refused
- **WHEN** a chain for M1 is `waiting` and the user launches M1 again
- **THEN** the route returns 409 `chain_active` with the chain id and launches nothing

#### Scenario: Invalid execution selection
- **WHEN** launch receives an unknown provider, incompatible model or unsupported effort
- **THEN** it returns 400 without calling chain start

## ADDED Requirements

### Requirement: Frozen milestone execution choice
A chain launched with an explicit provider/model/nullable effort SHALL persist that selection and use it for every rail, retry and resume after restart. Chains without a selection SHALL retain legacy behavior. An invalid persisted engine shape SHALL fail chunk launch with milestone_engine_unavailable.

#### Scenario: Failure and restart
- **WHEN** a selected-engine chain fails and a replacement manager resumes it
- **THEN** the retry and next rail use the original stored engine even if the caller's original selection object changed

#### Scenario: Legacy chain
- **WHEN** a chain has no persisted execution choice
- **THEN** it continues through the existing launch behavior without a strict engine override

### Requirement: Strict selection respects loop engine ownership
For a strict milestone engine selection, a conflicting effective loop developer provider, model or effort SHALL reject launch with 409 loop_engine_conflict before spawning. A compatible selection SHALL reach ordinary loop execution and its runtime provider override without rewriting the recipe.

#### Scenario: Recipe conflict
- **WHEN** a recipe owns Codex and a strict launch requests Claude
- **THEN** launch returns loop_engine_conflict and no execution starts

#### Scenario: Compatible execution
- **WHEN** a strict Codex model/high-effort selection is compatible with the selected loop
- **THEN** ordinary loop execution receives that provider, model and effort and the matching runtime provider override
