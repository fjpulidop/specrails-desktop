# loop-execution Specification

## Purpose
TBD - created by archiving change loop-builder. Update Purpose after archive.
## Requirements
### Requirement: App-Owned Iteration Loop

The `LoopRunManager` engine SHALL own the iteration loop for every loop run: it SHALL traverse the published loop graph, increment a monotonic iteration counter on each pass through the loop body, and enforce both the `maxIterations` limit and the configured timeout. The run MUST stop as soon as either limit is reached, and the engine MUST NOT delegate iteration counting or limit enforcement to specrails-core or to any AI node.

#### Scenario: Iteration counter increments per pass

- **WHEN** the engine completes one full traversal of the loop body and the Loop Decider returns `continue`
- **THEN** the engine SHALL increment the iteration counter by exactly one before starting the next pass
- **AND** the current iteration number SHALL be available to all nodes in the next pass as part of the iteration context

#### Scenario: maxIterations stops the run

- **WHEN** the iteration counter reaches the loop's configured `maxIterations` value
- **THEN** the engine SHALL stop traversing the graph and SHALL NOT spawn any further node
- **AND** the run SHALL settle with final outcome `max-iterations`

#### Scenario: Timeout stops the run

- **WHEN** the elapsed wall-clock time for the run reaches the configured timeout while an iteration is still in progress
- **THEN** the engine SHALL terminate the active process and stop traversing the graph
- **AND** the run SHALL settle with a final outcome of `failed` or `max-iterations` as appropriate

### Requirement: Context-Carrying AI Step Nodes

AI Step nodes SHALL spawn the run's selected provider CLI (Claude or Codex) and MUST carry context across iterations via session resume, so that iteration N+1 sees the work produced in iteration N. The engine SHALL capture each spawn's session id and pass it to the next iteration's AI Step spawn so prior reasoning and edits remain in scope.

#### Scenario: First AI Step iteration captures a session

- **WHEN** an AI Step node spawns the provider CLI for the first iteration of a run
- **THEN** the engine SHALL spawn without a resume id and SHALL capture the session id emitted by the CLI
- **AND** the captured session id SHALL be stored against the run for reuse on the next iteration

#### Scenario: Subsequent iterations resume the prior session

- **WHEN** an AI Step node spawns the provider CLI on iteration N+1 and a session id from iteration N exists
- **THEN** the engine SHALL pass the prior session id to the spawn so the new invocation resumes the existing context
- **AND** the iteration N+1 invocation MUST be able to see the work produced in iteration N

### Requirement: AI Loop Decider Node

The end-of-loop decision SHALL be made by a dedicated AI "Loop Decider" node and MUST NOT be made by app logic. Given the loop goal, the iteration history, and the last node output, the Loop Decider SHALL return a structured decision of the form `{decision: continue | stop, reasoning}`. The engine SHALL act on the returned `decision` to continue or stop the loop, and the `reasoning` MUST be surfaced to the user on every iteration.

#### Scenario: Decider returns continue

- **WHEN** the Loop Decider node returns `{decision: continue, reasoning}` and neither `maxIterations` nor the timeout has been reached
- **THEN** the engine SHALL proceed to the next iteration of the loop body
- **AND** the `reasoning` for that iteration SHALL be surfaced to the user

#### Scenario: Decider returns stop

- **WHEN** the Loop Decider node returns `{decision: stop, reasoning}`
- **THEN** the engine SHALL stop traversing the loop body and settle the run with final outcome `success`
- **AND** the `reasoning` SHALL be surfaced to the user as the explanation for stopping

#### Scenario: Decider receives goal, history, and last output

- **WHEN** the engine invokes the Loop Decider node for any iteration
- **THEN** the engine SHALL provide the loop goal, the iteration history, and the last node output as the Decider's input
- **AND** the engine MUST NOT itself evaluate success criteria to decide continuation

### Requirement: Shell Node Execution

Shell nodes SHALL execute their configured command in the run's working directory and MUST capture the command's stdout, stderr, and exit code. The captured result SHALL feed the next node in the graph and SHALL be available to the Loop Decider as part of the last node output.

#### Scenario: Shell node captures full result

- **WHEN** a Shell node executes its command and the process exits
- **THEN** the engine SHALL capture stdout, stderr, and the integer exit code from the process
- **AND** the captured result SHALL be passed as input to the next node in the traversal

#### Scenario: Shell result feeds the Decider

- **WHEN** a Shell node is the last node executed before the Loop Decider runs
- **THEN** the Shell node's stdout, stderr, and exit code SHALL be included in the last node output provided to the Decider

### Requirement: Condition AND/OR Joins

Condition nodes SHALL implement two join semantics. An `AND` condition SHALL run its phases in sequence, requiring each phase to proceed before the next. An `OR` condition SHALL, on exhaustion of its first phase, take the fallback (alternative) branch.

#### Scenario: AND runs phases in sequence

- **WHEN** the engine reaches a Condition node configured as `AND`
- **THEN** the engine SHALL run the condition's phases in sequence
- **AND** a later phase SHALL only run after the preceding phase has completed

#### Scenario: OR falls back on exhaustion

- **WHEN** the engine reaches a Condition node configured as `OR` and its first phase is exhausted
- **THEN** the engine SHALL take the fallback branch as the alternative path

### Requirement: Loop Invocation Recording

Each AI invocation that occurs inside a loop run SHALL be recorded to the `ai_invocations` table with `surface="loop"` and a `loop_run_id` linking it to its originating run. The cost, tokens, turns, and duration of each invocation MUST be captured so loop runs are accounted for in analytics.

#### Scenario: AI invocation records loop surface and run id

- **WHEN** an AI Step or Loop Decider invocation inside a loop run reaches process exit
- **THEN** the engine SHALL write an `ai_invocations` row with `surface="loop"`
- **AND** the row's `loop_run_id` SHALL reference the loop run that produced the invocation
- **AND** the row SHALL capture the invocation's cost, tokens, and duration

### Requirement: Loop Run Persistence

A per-project `loop_runs` record SHALL persist the lifecycle of every loop run. The record MUST store the run status, the iteration count, the final outcome (one of `success`, `max-iterations`, `stopped`, `failed`), and the aggregated total cost, total tokens, and total duration for the run.

#### Scenario: Run record persists final outcome and totals

- **WHEN** a loop run settles for any reason
- **THEN** the engine SHALL persist a `loop_runs` record with the final status and an outcome of `success`, `max-iterations`, `stopped`, or `failed`
- **AND** the record SHALL include the iteration count and the aggregated total cost, total tokens, and total duration

#### Scenario: Iteration count reflects passes completed

- **WHEN** a loop run completes after N iterations of the loop body
- **THEN** the persisted `loop_runs` record's `iteration_count` SHALL equal N

### Requirement: Loop Run WebSocket Events

The engine SHALL emit project-scoped WebSocket events for loop run lifecycle transitions: `loop.run_started` when a run begins, `loop.run_stopped` when a run is stopped by the user, and `loop.run_completed` when a run settles on its own. Every emitted event MUST carry the `projectId` so client handlers can filter by the active project.

#### Scenario: run_started on launch

- **WHEN** a loop run begins execution
- **THEN** the engine SHALL broadcast a `loop.run_started` WebSocket event carrying the `projectId`

#### Scenario: run_completed on natural settle

- **WHEN** a loop run settles on its own with outcome `success`, `max-iterations`, or `failed`
- **THEN** the engine SHALL broadcast a `loop.run_completed` WebSocket event carrying the `projectId`

#### Scenario: run_stopped on user stop

- **WHEN** a user stops a running loop and the run settles as `stopped`
- **THEN** the engine SHALL broadcast a `loop.run_stopped` WebSocket event carrying the `projectId`

### Requirement: User-Initiated Stop

A loop run SHALL be stoppable by the user at any time while running. On stop, the engine MUST terminate the active process belonging to the run and settle the run with final outcome `stopped`.

#### Scenario: Stop terminates the active process

- **WHEN** the user stops a loop run that has an active spawned process
- **THEN** the engine SHALL terminate the active process for that run
- **AND** the run SHALL settle with final outcome `stopped`
- **AND** the engine SHALL broadcast `loop.run_stopped` carrying the `projectId`

### Requirement: Zero Specrails-Core Coupling

The loop execution engine SHALL have zero coupling to specrails-core. It MUST drive raw prompts directly to the provider CLI (no slash command, no core-version gate), mirroring the existing ultracode path. The engine MUST NOT invoke any specrails-core command to run a loop.

#### Scenario: AI nodes use raw prompts

- **WHEN** the engine spawns the provider CLI for any AI Step or Loop Decider node
- **THEN** the spawn SHALL use a raw prompt rather than a specrails-core slash command
- **AND** the engine MUST NOT require a minimum specrails-core version to run the loop

### Requirement: Timeout And Crash Handling

The engine SHALL handle hung and crashed iterations safely. A hung iteration SHALL be killed when the timeout is reached, and the run SHALL settle as `failed` or `max-iterations`. A process that crashes mid-iteration MUST settle the run rather than leave it indefinitely running.

#### Scenario: Hung iteration killed at timeout

- **WHEN** an iteration's process is still running when the run's timeout is reached
- **THEN** the engine SHALL kill the hung process
- **AND** the run SHALL settle with final outcome `failed` or `max-iterations`

#### Scenario: Crash settles the run

- **WHEN** a spawned process for a loop run exits unexpectedly before its node completes
- **THEN** the engine SHALL settle the run rather than leaving it in a `Running` state
- **AND** the engine SHALL broadcast the appropriate `loop.run_completed` or `loop.run_stopped` event carrying the `projectId`

### Requirement: Loop Run Surfaced As An Inspectable Job With A Live Log

A loop run SHALL be backed by a job row (`jobs` table, job id === run id) so it appears in the project's Jobs list and its full session is inspectable in real time in Job Detail — exactly like an `implement`/`ultracode` rail job. The job row MUST be created synchronously at run start (before the first await) so a "View Log" navigation to `/jobs/<id>` never 404s. The engine SHALL stream every node's activity (AI Step text + tool use, Shell stdout/stderr, Loop Decider reasoning, and per-node headers) to that job both as persisted `log` events and as live `log` WebSocket messages keyed to the job id, and SHALL settle the job via `finishJob` with a `job.finalized` broadcast when the run ends.

#### Scenario: A loop run appears in Jobs and streams live

- **WHEN** a loop run starts
- **THEN** a job row whose id equals the run id SHALL exist immediately and be listed in the Jobs history
- **AND** the rail SHALL expose that id as its active job so "View Log" opens `/jobs/<id>`
- **AND** each AI Step / Shell / Decider activity SHALL stream to that job's log as live `log` messages and be persisted as events

#### Scenario: The job settles with the run

- **WHEN** the run reaches a terminal outcome
- **THEN** the engine SHALL call `finishJob` with status `completed` for `success`, `canceled` for `stopped`, and `failed` for `failed`/`max-iterations`
- **AND** SHALL broadcast `job.finalized` so an open Job Detail re-fetches and stops the live stream

