## MODIFIED Requirements

### Requirement: Loop AI steps are inactivity-bounded
The loop engine SHALL arm an inactivity watchdog on every loop AI step (one-shot and interactive) that fires when the step's provider process has produced no stream activity — the same activity that updates the step's `loop_step_recovery` checkpoint — for the configured idle threshold. The watchdog SHALL apply regardless of the loop's per-step timeout: a step with `aiStepTimeoutMinutes > 0` keeps that hard cap AND the idle bound; a step with `aiStepTimeoutMinutes = 0` (every factory loop) is bounded by inactivity only. When the watchdog fires the engine SHALL tear the step's process/session down and record a `loop_step_end` event with `status: 'stalled'`, `reason: 'idle_timeout'` and the observed idle duration.

#### Scenario: Factory loop step with no output is torn down
- **WHEN** a `factory:implement` AI step's provider emits no stream frame for the idle threshold
- **THEN** the engine tears the step down and persists a `loop_step_end` with `status: 'stalled'` and `reason: 'idle_timeout'`

#### Scenario: Activity resets the watchdog
- **WHEN** the provider emits a stream frame every few minutes during a 2-hour step
- **THEN** the watchdog never fires and the step runs to its own completion

#### Scenario: Hard cap and idle bound coexist
- **WHEN** a loop configures `aiStepTimeoutMinutes = 20` and the step produces activity every minute but exceeds 20 minutes
- **THEN** the existing per-step timeout ends the step exactly as before (the idle bound never fired)
