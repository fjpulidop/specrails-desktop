## ADDED Requirements

### Requirement: Loop AI steps are inactivity-bounded
The loop engine SHALL arm an inactivity watchdog on every loop AI step (one-shot and interactive) that fires when the step's provider process has produced no stream activity — the same activity that updates the step's `loop_step_recovery` checkpoint — for the configured idle threshold. The watchdog SHALL apply regardless of the loop's per-step timeout: a step with `aiStepTimeoutMinutes > 0` keeps that hard cap AND the idle bound; a step with `aiStepTimeoutMinutes = 0` (every factory loop) is bounded by inactivity only. When the watchdog fires the engine SHALL tear the step's process/session down and record a `loop_step_end` event with `status: 'stalled'`, `reason: 'idle_timeout'` and the observed idle duration.

#### Scenario: Factory loop step with no output is torn down
- **WHEN** a `factory:batch` AI step's provider emits no stream frame for the idle threshold
- **THEN** the engine tears the step down and persists a `loop_step_end` with `status: 'stalled'` and `reason: 'idle_timeout'`

#### Scenario: Activity resets the watchdog
- **WHEN** the provider emits a stream frame every few minutes during a 2-hour step
- **THEN** the watchdog never fires and the step runs to its own completion

#### Scenario: Hard cap and idle bound coexist
- **WHEN** a loop configures `aiStepTimeoutMinutes = 20` and the step produces activity every minute but exceeds 20 minutes
- **THEN** the existing per-step timeout ends the step exactly as before (the idle bound never fired)

### Requirement: Idle threshold configuration
The idle threshold SHALL default to 30 minutes and SHALL be overridable with `SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS` (integer milliseconds). The values `0`, `false` and `off` (case-insensitive) SHALL disable the watchdog. The effective threshold SHALL never be lower than the stuck-run notification threshold (`SPECRAILS_STUCK_THRESHOLD_MS` / its 10-minute floor), so a `job.stuck` notification always precedes a teardown; a lower configured value SHALL be clamped up and logged once.

#### Scenario: Default applies to factory loops
- **WHEN** the env var is unset and a factory loop step runs
- **THEN** the effective idle threshold is 30 minutes

#### Scenario: Disabled restores untimed behaviour
- **WHEN** `SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS=0`
- **THEN** no idle watchdog is armed and an untimed factory step behaves byte-identically to the pre-change engine

#### Scenario: Value below the stuck floor is clamped
- **WHEN** `SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS=60000` and the stuck threshold is 10 minutes
- **THEN** the effective idle threshold is 10 minutes and a single warning is logged

### Requirement: A stalled step is retried once by resume
After an idle-timeout teardown the engine SHALL retry the SAME step exactly once by resuming the captured provider session (or a fresh spawn when no session id was captured), inside the same step index, before failing it. A second stall of the same step SHALL fail the step; the run SHALL settle with outcome `stalled`, which maps to the existing `canceled` ticket outcome (specs return to `todo`) and closes the delivery row through the existing zero-succeeded path. The retry SHALL be visible in the step log (a `loop_step` event with an incremented `attempt`) so the narration surface can state it.

#### Scenario: Resume after a single stall
- **WHEN** a step stalls once and the resumed attempt completes
- **THEN** the step settles with its normal status and the run continues to the next node

#### Scenario: Two stalls fail the step
- **WHEN** the resumed attempt stalls again
- **THEN** the step fails, the run settles `stalled`, its tickets revert to `todo` and the delivery row auto-closes

### Requirement: Stuck notification is actionable
The `job.stuck` WS message SHALL carry `actions: ['stop']`, and the client notification path SHALL render a "Stop run" action that invokes the existing loop-run stop route for that run. No new stop route SHALL be introduced.

#### Scenario: Stop from the stuck notification
- **WHEN** the user activates "Stop run" on a `job.stuck` notification
- **THEN** the existing stop route is called for that run id and the run settles as a user stop
