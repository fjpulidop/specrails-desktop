## ADDED Requirements

### Requirement: Loop Rail Mode

A rail SHALL support a fourth launch mode named `loop`, selectable alongside the existing `implement`, `batch-implement`, and `freestyle` modes. When a rail's mode is set to `loop`, the rail header SHALL render the loop-mode controls (loop picker, AI engine selector, model selector, reasoning-effort selector) and SHALL NOT render the controls exclusive to the other three modes. Selecting `loop` mode MUST NOT alter the rail's currently assigned spec.

#### Scenario: Loop appears as a fourth selectable rail mode
- **WHEN** the user opens a rail's mode selector
- **THEN** the available modes SHALL include `implement`, `batch-implement`, `freestyle`, and `loop`
- **AND** selecting `loop` SHALL set the rail's mode to `loop`

#### Scenario: Loop mode reveals loop-specific controls
- **WHEN** the user sets a rail's mode to `loop`
- **THEN** the rail header SHALL display a published-loop picker, an AI engine selector, a model selector, and a reasoning-effort selector
- **AND** the controls exclusive to `implement`, `batch-implement`, and `freestyle` SHALL NOT be displayed for that rail

### Requirement: Published-Loop Picker

The loop picker presented in `loop` mode SHALL list ONLY loops whose lifecycle status is `Published`. Loops in `Draft` or `Running` status MUST NOT be selectable from the picker. Each picker entry SHALL be a global (cross-project) loop definition.

#### Scenario: Only published loops are offered
- **WHEN** the loop picker is opened on a rail in `loop` mode
- **THEN** every loop offered SHALL have status `Published`
- **AND** loops with status `Draft` or `Running` SHALL be excluded from the picker

#### Scenario: A draft loop is not selectable
- **WHEN** a loop exists with status `Draft`
- **THEN** that loop SHALL NOT appear as a selectable entry in any rail's loop picker

#### Scenario: A running loop is not selectable
- **WHEN** a loop exists with status `Running`
- **THEN** that loop SHALL NOT appear as a selectable entry in any rail's loop picker

### Requirement: Engine, Model, and Reasoning-Effort Selection

In `loop` mode the rail SHALL allow the user to select the AI engine (Claude or Codex), the model, and the reasoning effort to use for the Loop Run. The reasoning-effort selection MUST be threaded into the launched run. Loop mode SHALL function with both the Claude and the Codex engine.

#### Scenario: Engine selection offers Claude and Codex
- **WHEN** the user opens the AI engine selector on a rail in `loop` mode
- **THEN** the selector SHALL offer Claude and Codex as engine choices

#### Scenario: Launch with Codex engine
- **WHEN** the user selects the Codex engine, chooses a published loop, and presses Play
- **THEN** a Loop Run SHALL be launched using the Codex engine with the selected model and reasoning effort

#### Scenario: Launch with Claude engine
- **WHEN** the user selects the Claude engine, chooses a published loop, and presses Play
- **THEN** a Loop Run SHALL be launched using the Claude engine with the selected model and reasoning effort

### Requirement: Play Disabled Until a Loop Is Chosen

While a rail is in `loop` mode but no published loop has been chosen in the picker, the Play control SHALL be disabled. The Play control SHALL become enabled only once a published loop is selected.

#### Scenario: No loop chosen disables Play
- **WHEN** a rail is in `loop` mode and no loop is selected in the picker
- **THEN** the Play control SHALL be disabled

#### Scenario: Selecting a loop enables Play
- **WHEN** the user selects a published loop in the picker for a rail in `loop` mode
- **THEN** the Play control SHALL become enabled

### Requirement: Launch Loop Run Bound to Rail and Spec

Pressing Play on a rail in `loop` mode SHALL launch a Loop Run bound to that rail and to the rail's currently assigned spec. The selected spec SHALL flow into the loop as context via the `{{spec.title}}` and `{{spec.description}}` interpolation variables. The run SHALL be tracked per-rail so that the rail reflects the active Loop Run.

#### Scenario: Play launches a run bound to the rail's spec
- **WHEN** the user presses Play on a rail in `loop` mode that has a selected published loop and an assigned spec
- **THEN** a Loop Run SHALL be created and bound to that rail and to the rail's assigned spec

#### Scenario: Spec context flows into the loop
- **WHEN** a Loop Run is launched for a rail with an assigned spec
- **THEN** the loop's `{{spec.title}}` variable SHALL resolve to the spec's title
- **AND** the loop's `{{spec.description}}` variable SHALL resolve to the spec's description

#### Scenario: Run is tracked per rail
- **WHEN** a Loop Run is launched on a rail
- **THEN** the rail SHALL track the active Loop Run as its current run

### Requirement: Ticket Lifecycle on Loop Run Completion

On completion of a Loop Run the rail SHALL release its tickets and update ticket status exactly as a normal job does. On success a ticket in `todo` or `in_progress` SHALL transition to `done`. On failure or stop a ticket in `in_progress` SHALL transition back to `todo`. The rail SHALL broadcast a run-completion event mirroring the job lifecycle.

#### Scenario: Success transitions tickets to done
- **WHEN** a Loop Run bound to a rail completes successfully
- **THEN** each of the rail's tickets in `todo` or `in_progress` SHALL transition to `done`
- **AND** the rail SHALL release its tickets

#### Scenario: Failure reverts tickets to todo
- **WHEN** a Loop Run bound to a rail fails or is stopped
- **THEN** each of the rail's tickets in `in_progress` SHALL transition back to `todo`
- **AND** the rail SHALL release its tickets

#### Scenario: Completion is broadcast
- **WHEN** a Loop Run completes
- **THEN** the rail SHALL broadcast a run-completion event scoped to the project

### Requirement: Stopping the Rail Cancels the Active Loop Run

Stopping a rail that has an active Loop Run SHALL cancel that Loop Run. After cancellation the rail SHALL apply the failure/stop ticket lifecycle (any `in_progress` ticket reverts to `todo`) and SHALL release its tickets.

#### Scenario: Stop cancels the run
- **WHEN** the user stops a rail that has an active Loop Run
- **THEN** the active Loop Run SHALL be cancelled

#### Scenario: Stop reverts tickets and releases the rail
- **WHEN** a rail with an active Loop Run is stopped
- **THEN** each of the rail's tickets in `in_progress` SHALL transition back to `todo`
- **AND** the rail SHALL release its tickets
