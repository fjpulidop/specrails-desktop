## Why

Implement can repeat successful host checks and an ineffective review correction until the global 200-node ceiling. The reported Windows run performed 25 green verification passes and 24 fixer turns, then failed with an opaque recursion error.

## What Changes

- Require an actual candidate change after corrections for both failed verification and rejected review.
- Bound automatic correction attempts, including corrections that keep changing files without satisfying review.
- Give reviewer and fixer the exact acceptance policy and preserve current review findings in terminal diagnostics.
- Display durable failure reasons in the readable runtime log.
- Reproduce the reported green-check/no-edit loop through the real published Core runtime without live provider calls.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `factory-loops`: bounded Implement corrections and actionable review failure diagnostics.

## Impact

Desktop's configurable Implement graph, deterministic paired-runtime fixtures, runtime bridge logging and loop guide. Core's engine and review acceptance thresholds remain compatible and unchanged. Existing frozen executions keep their original definitions; the corrected graph applies to newly launched runs.
