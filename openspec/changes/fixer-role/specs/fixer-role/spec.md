## ADDED Requirements

### Requirement: Correction rounds run on the fixer engine with the fixer stance
When the runtime configuration carries a `fixer` engine, every developer-step visit that follows a failed verification (all tasks ticked) or a rejected review SHALL run on that engine in a fresh session with the fixer stance; visits that implement or continue unchecked tasks SHALL keep the developer engine. Without a `fixer`, the developer SHALL correct its own work with the fixer stance. The fixer stance SHALL present the exact verification output and host-read source excerpts before any plan context and SHALL NOT include the frozen scope/design/specs dump.

#### Scenario: Review rejection goes to the fixer
- **WHEN** `fixer: { provider: 'fixerbox', model: 'strong' }` is configured and the reviewer rejects once
- **THEN** the correction request is sent to `fixerbox`/`strong` with the fixer system prompt, the developer's requests keep their own model, and the run succeeds

#### Scenario: No fixer configured
- **WHEN** the configuration has no `fixer`
- **THEN** correction rounds run on the developer engine with the fixer stance
