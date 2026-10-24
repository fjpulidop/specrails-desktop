## ADDED Requirements

### Requirement: Projects opt in to baseline on touch

Each project SHALL have a `baselineOnTouch` boolean setting, default `false`. Desktop SHALL forward `baselineOnTouch: true` to Core's runtime configuration only when the setting is on and the active Core announces `baselineOnTouch: 1`, and SHALL remove the key otherwise.

#### Scenario: Older Core
- **WHEN** the setting is on and Core does not announce the capability
- **THEN** the runtime configuration sent to Core has no `baselineOnTouch` key and the settings switch shows an update-Core note

### Requirement: The packet shows the baseline with its cost apart

When a unit's run recorded a baseline other than `not-needed`, the review packet SHALL show the module described, the as-built requirements per capability, the characterization tests, the status and Core's reason when blocked, and the baseline spend separately from the change's cost, or that the spend was not reported.

#### Scenario: Baseline passed
- **WHEN** a run characterized `src/search.ts` with two requirements and the baseline cost $0.42
- **THEN** the packet shows the module, "2 as-built requirements" and "$0.42" apart from the build cost

### Requirement: The characterization blocker is explicit

When Core blocks a run with `baseline_characterization_failed`, the run's error text SHALL state that the characterization tests do not pass on the unchanged code and that the module was not edited.

#### Scenario: Tests fail on base
- **WHEN** Core stops the run with that code
- **THEN** the run log reads "Baseline blocked: the characterization tests do not pass on the unchanged code…"
