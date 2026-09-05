## ADDED Requirements

### Requirement: Untimed AI steps remain inactivity-bounded
A loop AI step whose per-step timeout is disabled (`aiStepTimeoutMinutes = 0`, the factory-loop default) SHALL still be bounded by the engine's inactivity watchdog: when the step's provider produces no stream activity for the configured idle threshold, the engine SHALL tear the step down, record `loop_step_end` with `status: 'stalled'` and `reason: 'idle_timeout'`, retry the step once by resume, and on a second stall settle the run as `stalled` rather than leaving it `running` indefinitely. Disabling the watchdog via its env contract SHALL restore the untimed behaviour byte-identically.

#### Scenario: Factory step cannot run forever
- **WHEN** a `factory:batch` step's provider wedges with no output past the idle threshold, and the resumed attempt wedges again
- **THEN** the run settles `stalled`, broadcasts `loop.run_completed` with `status: 'stalled'` and the job row leaves `running`

#### Scenario: Timed steps are unchanged
- **WHEN** a user loop configures `aiStepTimeoutMinutes = 45` and its step keeps producing output
- **THEN** the step is ended only by that 45-minute cap, exactly as before
