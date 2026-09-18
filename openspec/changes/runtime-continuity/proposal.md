## Why

A real implementation was killed after 15 minutes while making progress, then started a fresh provider conversation and rediscovered environment blockers. Large instruction reads, missing test prerequisites and ambiguous interruption recovery waste AI work and obscure the actual outcome.

## What Changes

- Expose explicit inactivity and total deadlines, retain scoped progress across recovery, and prepare isolated test dependencies before agent execution.
- Treat timeout and cancellation of writes consistently, requiring explicit recovery while keeping original scope and configuration.
- Preserve official OpenSpec planning/apply and independent verification; progress is advisory, never acceptance evidence.
- Add deterministic regressions reproducing activity, interruption, resume, cold fallback and isolated test preparation.

## Capabilities

### New Capabilities
- `runtime-continuity`: Bounded, observable implementation progress and recovery without repeated setup or lost provider context.

### Modified Capabilities

None.

## Impact

Paired changes in specrails-core and specrails-desktop. No provider authentication changes, paid benchmark calls, automatic retry loops, or publication. Existing retained runtimes remain bound to their original version. Changes are verified and pushed on new branches based on updated main.
