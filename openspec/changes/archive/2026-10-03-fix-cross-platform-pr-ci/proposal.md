## Why

The Core and Desktop PRs fail their cross-platform CI despite focused local checks. The failures include platform-dependent verification fixtures, launch integration expectations, and a Desktop pairing pinned to a Core revision predating the fixes it exercises.

## What Changes

- Make verification regression fixtures emit complete output without exceeding Windows command-line limits.
- Reproduce and repair MCP launch and addendum integration failures while preserving production admission rules.
- Pair Desktop against the exact corrected Core revision and run the real factory and recovery suites.
- Verify both PR heads through GitHub CI without weakening coverage or acceptance checks.

## Capabilities

### New Capabilities

- `cross-platform-runtime-regression-checks`: Deterministic regression checks for verification evidence and compatible Desktop/Core integration.

### Modified Capabilities

None. Existing delivery, scope and verification requirements remain authoritative.

## Impact

Core verification regression tests; Desktop MCP and loop lifecycle tests; Desktop paired Core CI configuration. Production changes are limited to bugs demonstrated by these cases.
